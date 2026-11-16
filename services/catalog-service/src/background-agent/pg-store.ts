import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
    BACKGROUND_AGENT_WORKFLOW_JOB,
    backgroundAgentDigest,
    normalizeBackgroundAgentPayload,
    type IBackgroundAgentPayload,
} from '../../../shared/background-agent.cjs';
import type { IBackgroundAgentStore } from './worker';
import type { IRuntimeResult } from './runtime';
import type {
    IBackgroundAgentJobState,
    IBackgroundAgentResilienceStore,
    TBackgroundAgentEffectPhase,
} from './resilience';

/**
 * FR-305 (agt-07, phase B): the durable pg/lease implementation of the background-agent job store
 * and the job-lifecycle resilience state (migration 62). It implements the frozen Phase A seams
 * (IBackgroundAgentStore) and the 9.11 resilience seam (IBackgroundAgentResilienceStore) over the
 * same row: the run state, lease/heartbeat, crash-policy counters, effect checkpoints, the verified
 * result and the delivery state.
 *
 * OQ-1: one executor today, but the claim is `FOR UPDATE SKIP LOCKED` and the lease is explicit, so
 * scaling replicas does not break the invariants: a row is claimed by exactly one holder at a time,
 * and a hard kill releases it when the lease expires (reaper) — the effect checkpoints then settle
 * the job as `unknown` without re-executing the paid step.
 */

/** The executor lease: long enough for a run heartbeat, short enough to reclaim a hard-killed process. */
export const BACKGROUND_AGENT_LEASE = Object.freeze({
    /** Claim/renew lease horizon; the supervisor renews while the run is in flight. */
    leaseMs: 5 * 60 * 1000,
});

const LEASE_SQL = (leaseMs: number) => `${Math.floor(leaseMs / 1000)} seconds`;

interface IJobRow {
    request_key: string;
    request_id: string;
    kind: string;
    project_id: string;
    email: string;
    role: string;
    payload: IBackgroundAgentPayload;
    source_message_id: string | null;
    runtime_version: string;
    state: 'pending' | 'running' | 'succeeded' | 'failed' | 'dead_letter';
    result: IRuntimeResult | null;
    attempts: number;
    next_attempt_at: Date | null;
    unknown: boolean;
    dead_letter_reason: string | null;
    lease_token: string | null;
    lease_until: Date | null;
    delivered: boolean;
    publish_state: 'pending' | 'published' | 'withheld';
}

/** The admission link: who admitted the task and the chat origin (the sink publishes into it). */
export interface IBackgroundAgentAdmitLink {
    email: string;
    role: string;
    sourceMessageId?: string | null;
    runtimeVersion: string;
}

export class PgBackgroundAgentStore implements IBackgroundAgentStore, IBackgroundAgentResilienceStore {
    constructor(private readonly pool: Pool) {}

    // ── Phase A seam: IBackgroundAgentStore ───────────────────────────────────────────────────────

    /**
     * The Phase A seam cannot be honored by the durable store: the row records the admitting owner,
     * project role and pinned runtime version, which the link-less seam does not carry. The server
     * flow admits through admitWithLink (the controller knows the actor); using this seam is a
     * wiring mistake and fails closed with an explicit error.
     */
    async admit(): Promise<void> {
        throw new Error(
            'PgBackgroundAgentStore: admission requires the server link — use admitWithLink(payload, link).',
        );
    }

    /**
     * Admission with the server link (owner, project role, chat origin, pinned runtime version).
     * Idempotent by request_key (ON CONFLICT DO NOTHING): the digest of the normalized immutable
     * payload is the receipt idempotency key; a repeated request returns silently.
     */
    async admitWithLink(payload: IBackgroundAgentPayload, link: IBackgroundAgentAdmitLink): Promise<void> {
        const checked = normalizeBackgroundAgentPayload(payload);
        await this.pool.query(
            `INSERT INTO background_agent_jobs(
                request_key, request_id, kind, project_id, email, role, payload, source_message_id, runtime_version
             )
             VALUES($1,$2::uuid,$3,$4,$5,$6,$7::jsonb,$8::uuid,$9)
             ON CONFLICT(request_key) DO NOTHING`,
            [
                backgroundAgentDigest(checked),
                checked.requestId,
                BACKGROUND_AGENT_WORKFLOW_JOB,
                checked.projectId,
                link.email,
                link.role,
                JSON.stringify(checked),
                link.sourceMessageId ?? null,
                link.runtimeVersion,
            ],
        );
    }

    /**
     * Claim one admitted task by request id: the atomic pending→running transition with a fresh
     * lease; a task in backoff (next_attempt_at in the future) or already settled is not claimable.
     * Returns the normalized payload (undefined when the task is absent or not claimable).
     */
    async claim(requestId: string): Promise<IBackgroundAgentPayload | undefined> {
        const { rows } = await this.pool.query<{ payload: IBackgroundAgentPayload }>(
            `UPDATE background_agent_jobs
             SET state='running', lease_token=$2::uuid, lease_until=now()+$3::interval, heartbeat_at=now(), updated_at=now()
             WHERE request_id=$1::uuid
               AND state='pending'
               AND (next_attempt_at IS NULL OR next_attempt_at<=now())
             RETURNING payload`,
            [requestId, randomUUID(), LEASE_SQL(BACKGROUND_AGENT_LEASE.leaseMs)],
        );
        if (!rows[0]) return;
        return normalizeBackgroundAgentPayload(rows[0].payload);
    }

    /**
     * Complete: the verified result settles the job (running→succeeded/failed). Idempotent by the
     * state guard: a settled job is not re-settled (a lost-ACK re-delivery settles to the same
     * recorded receipt through the resilience path, never through a second state transition).
     */
    async complete(requestId: string, result: IRuntimeResult): Promise<void> {
        await this.pool.query(
            `UPDATE background_agent_jobs
             SET state=CASE WHEN $2::jsonb->>'state'='succeeded' THEN 'succeeded' ELSE 'failed' END,
                 result=$2::jsonb, completed_at=now(), updated_at=now()
             WHERE request_id=$1::uuid AND state='running'`,
            [requestId, JSON.stringify(result)],
        );
    }

    // ── 9.11 seam: IBackgroundAgentResilienceStore (job-lifecycle state, same row) ───────────────

    async getState(requestKey: string): Promise<IBackgroundAgentJobState | undefined> {
        const { rows } = await this.pool.query<IJobRow>(
            'SELECT * FROM background_agent_jobs WHERE request_key=$1 FOR SHARE',
            [requestKey],
        );
        const row = rows[0];
        if (!row) return;
        return {
            requestKey: row.request_key,
            attempts: row.attempts,
            nextAttemptAt: row.next_attempt_at ? row.next_attempt_at.getTime() : null,
            deadLetter: row.state === 'dead_letter',
            ...(row.dead_letter_reason ? { deadLetterReason: row.dead_letter_reason } : {}),
            unknown: row.unknown,
            result: row.result,
            delivered: row.delivered,
        };
    }

    /**
     * Job-lifecycle crash: attempts+1, the backoff deadline, and the row back to pending (lease
     * released) — the NEXT pass re-claims it after the deadline, subject to the retry budget.
     */
    async recordCrash(requestKey: string, now: number, backoffMs: number): Promise<IBackgroundAgentJobState> {
        const { rows } = await this.pool.query<IJobRow>(
            `UPDATE background_agent_jobs
             SET attempts=attempts+1,
                 next_attempt_at=to_timestamp($2::float8) + ($3::float8/1000.0)*interval '1 second',
                 state='pending', lease_token=NULL, lease_until=NULL, updated_at=now()
             WHERE request_key=$1
             RETURNING *`,
            [requestKey, now / 1000, backoffMs],
        );
        if (!rows[0]) throw new Error(`Фоновая задача ${requestKey} не найдена.`);
        return this.stateOf(rows[0]);
    }

    async markDeadLetter(requestKey: string, reason: string): Promise<IBackgroundAgentJobState> {
        const { rows } = await this.pool.query<IJobRow>(
            `UPDATE background_agent_jobs
             SET state='dead_letter', dead_letter_reason=$2, lease_token=NULL, lease_until=NULL, updated_at=now()
             WHERE request_key=$1
             RETURNING *`,
            [requestKey, reason],
        );
        if (!rows[0]) throw new Error(`Фоновая задача ${requestKey} не найдена.`);
        return this.stateOf(rows[0]);
    }

    async markUnknown(requestKey: string): Promise<IBackgroundAgentJobState> {
        const { rows } = await this.pool.query<IJobRow>(
            'UPDATE background_agent_jobs SET unknown=true, updated_at=now() WHERE request_key=$1 RETURNING *',
            [requestKey],
        );
        if (!rows[0]) throw new Error(`Фоновая задача ${requestKey} не найдена.`);
        return this.stateOf(rows[0]);
    }

    /** Record-before-ACK: the verified result is persisted (idempotent; the state transition is complete's). */
    async recordResult(requestKey: string, result: IRuntimeResult): Promise<IBackgroundAgentJobState> {
        const { rows } = await this.pool.query<IJobRow>(
            `UPDATE background_agent_jobs SET result=$2::jsonb, updated_at=now() WHERE request_key=$1 RETURNING *`,
            [requestKey, JSON.stringify(result)],
        );
        if (!rows[0]) throw new Error(`Фоновая задача ${requestKey} не найдена.`);
        return this.stateOf(rows[0]);
    }

    async markDelivered(requestKey: string): Promise<IBackgroundAgentJobState> {
        const { rows } = await this.pool.query<IJobRow>(
            "UPDATE background_agent_jobs SET delivered=true, publish_state='published', updated_at=now() WHERE request_key=$1 RETURNING *",
            [requestKey],
        );
        if (!rows[0]) throw new Error(`Фоновая задача ${requestKey} не найдена.`);
        return this.stateOf(rows[0]);
    }

    async hasEffect(requestKey: string, phase: TBackgroundAgentEffectPhase): Promise<boolean> {
        const { rows } = await this.pool.query<{ n: number }>(
            'SELECT 1 AS n FROM background_agent_effects WHERE request_key=$1 AND phase=$2',
            [requestKey, phase],
        );
        return rows.length > 0;
    }

    /** Effect checkpoint (epic-8 entry 12): journaled once, idempotent by the composite key. */
    async journalEffect(requestKey: string, phase: TBackgroundAgentEffectPhase): Promise<void> {
        await this.pool.query(
            'INSERT INTO background_agent_effects(request_key,phase) VALUES($1,$2) ON CONFLICT(request_key,phase) DO NOTHING',
            [requestKey, phase],
        );
    }

    // ── Supervisor loop helpers (phase B, block 4) ────────────────────────────────────────────────

    /** The row the supervisor claims next (FIFO over pending, backoff-eligible), or undefined. */
    async claimNext(): Promise<{ requestId: string; requestKey: string; leaseToken: string } | undefined> {
        const leaseToken = randomUUID();
        const { rows } = await this.pool.query<{ request_id: string; request_key: string }>(
            `WITH picked AS (
                SELECT request_id, request_key
                FROM background_agent_jobs
                WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now())
                ORDER BY created_at
                LIMIT 1
                FOR UPDATE SKIP LOCKED
             )
             UPDATE background_agent_jobs j
             SET state='running', lease_token=$1::uuid, lease_until=now()+$2::interval, heartbeat_at=now(), updated_at=now()
             FROM picked
             WHERE j.request_key=picked.request_key
             RETURNING j.request_id, j.request_key`,
            [leaseToken, LEASE_SQL(BACKGROUND_AGENT_LEASE.leaseMs)],
        );
        if (!rows[0]) return;
        return { requestId: rows[0].request_id, requestKey: rows[0].request_key, leaseToken };
    }

    /** Renew the in-flight lease (the supervisor keeps a long run alive while it is in flight). */
    async renewLease(requestId: string, leaseToken: string): Promise<boolean> {
        const { rowCount } = await this.pool.query(
            `UPDATE background_agent_jobs
             SET lease_until=now()+$3::interval, heartbeat_at=now()
             WHERE request_id=$1::uuid AND state='running' AND lease_token=$2::uuid`,
            [requestId, leaseToken, LEASE_SQL(BACKGROUND_AGENT_LEASE.leaseMs)],
        );
        return (rowCount ?? 0) > 0;
    }

    /** Release a claim without settling (the run was interrupted before any effect). */
    async releaseLease(requestId: string, leaseToken: string): Promise<void> {
        await this.pool.query(
            `UPDATE background_agent_jobs
             SET state='pending', lease_token=NULL, lease_until=NULL, updated_at=now()
             WHERE request_id=$1::uuid AND state='running' AND lease_token=$2::uuid`,
            [requestId, leaseToken],
        );
    }

    /** Reaper: a hard-killed executor releases its row when the lease expires (no silent loss). */
    async reapExpired(): Promise<number> {
        const { rowCount } = await this.pool.query(
            `UPDATE background_agent_jobs
             SET state='pending', lease_token=NULL, lease_until=NULL, updated_at=now()
             WHERE state='running' AND lease_until<now()`,
        );
        return rowCount ?? 0;
    }

    /**
     * Withhold: the result exists but the owner's access was revoked — the receipt is never
     * discarded and never published; re-delivery is stopped the same way as a published one.
     */
    async markWithheld(requestKey: string): Promise<void> {
        await this.pool.query(
            "UPDATE background_agent_jobs SET delivered=true, publish_state='withheld', updated_at=now() WHERE request_key=$1",
            [requestKey],
        );
    }

    /** The full job row (supervisor / observability / sink link lookup). */
    async findRow(requestId: string): Promise<IJobRow | undefined> {
        const { rows } = await this.pool.query<IJobRow>(
            'SELECT * FROM background_agent_jobs WHERE request_id=$1::uuid FOR SHARE',
            [requestId],
        );
        return rows[0];
    }

    private stateOf(row: IJobRow): IBackgroundAgentJobState {
        return {
            requestKey: row.request_key,
            attempts: row.attempts,
            nextAttemptAt: row.next_attempt_at ? row.next_attempt_at.getTime() : null,
            deadLetter: row.state === 'dead_letter',
            ...(row.dead_letter_reason ? { deadLetterReason: row.dead_letter_reason } : {}),
            unknown: row.unknown,
            result: row.result,
            delivered: row.delivered,
        };
    }
}
