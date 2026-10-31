import type { Pool, QueryConfig } from 'pg';
import {
    reserveUsageQuota,
    claimUsageQuota,
    releaseUndispatchedQuota,
    finishQuotaUsage,
} from '../model-token-quotas/quota-ledger';
import type { ModelTokenQuotaAdmission } from '../model-token-quotas/model-token-quotas.types';
import { quotaCoverage } from '../model-token-quotas/model-token-quotas.model';
import { ForbiddenException } from '@nestjs/common';
import { readModelUsageReport } from './model-usage-report';
import type { UsageFilter, UsageInsert, UsagePrivateRoom, UsageScope, UsageTerminal } from './model-usage.types';

/** Receipts are independent of catalog deletion: historical model attribution is never silently removed. */
export class ModelUsageRepository {
    constructor(readonly pool: Pool) {}
    async begin(value: UsageInsert): Promise<void> {
        await this.pool.query(
            `INSERT INTO model_usage_calls(id,worker_id,model_id,model_name,provider,endpoint,purpose,actor_email,project_id,agent_id,turn_id,operation_id,private_project_chat_room_id,lease_until,dispatch_count)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '2 minutes',$14)`,
            [
                value.id,
                value.workerId,
                value.model.id,
                value.model.name,
                value.model.runtime,
                value.endpoint,
                value.purpose,
                value.actorEmail ?? null,
                value.projectId ?? null,
                value.agentId ?? null,
                value.turnId ?? null,
                value.operationId ?? null,
                value.privateProjectChatRoomId ?? null,
                value.endpoint === 'chat' && quotaCoverage(value.model).managedText ? 0 : null,
            ],
        );
    }
    async reserveQuota(worker: string, input: ModelTokenQuotaAdmission, signal?: AbortSignal) {
        return reserveUsageQuota(this.pool, worker, input, signal);
    }
    async claimQuota(worker: string, id: string, enforce: boolean, signal?: AbortSignal) {
        return claimUsageQuota(this.pool, worker, id, enforce, signal);
    }
    async releaseQuota(worker: string, id: string) {
        return releaseUndispatchedQuota(this.pool, worker, id);
    }
    async finish(id: string, worker: string, value: UsageTerminal): Promise<void> {
        if (value.quotaTracked && (await finishQuotaUsage(this.pool, worker, id, value))) return;
        await this.metadata(
            `UPDATE model_usage_calls SET status=$3,input_tokens=$4,output_tokens=$5,latency_ms=$6,dispatch_count=$7,dispatched_at=$8,rate_wait_ms=$9,provider_latency_ms=$10,failure_code=$11,finished_at=now(),lease_until=NULL
            WHERE id=$1 AND worker_id=$2 AND status IN ('pending','interrupted')`,
            [
                id,
                worker,
                value.status,
                value.inputTokens,
                value.outputTokens,
                value.latencyMs,
                value.dispatchCount ?? null,
                value.dispatchedAt ?? null,
                value.rateWaitMs ?? null,
                value.providerLatencyMs ?? null,
                value.failureCode ?? null,
            ],
        );
    }
    /** A settled transport is no longer generating an answer, even while terminal accounting is retried. */
    async dispatchProgress(
        id: string,
        worker: string,
        count: number,
        at: string | null,
        latency: number | null,
    ): Promise<void> {
        await this.metadata(
            `UPDATE model_usage_calls SET dispatch_count=$3,dispatched_at=$4,provider_latency_ms=$5
            WHERE id=$1 AND worker_id=$2 AND status='pending' AND lease_until>now()`,
            [id, worker, count, at, latency],
        );
    }
    async recover(): Promise<void> {
        await this
            .metadata(`WITH eligible AS (SELECT id FROM model_usage_calls WHERE status='pending' AND lease_until<=now() FOR UPDATE SKIP LOCKED)
            UPDATE model_usage_calls receipt SET status='interrupted',finished_at=now(),lease_until=NULL,
            quota_state=CASE WHEN quota_state IN ('reserved','dispatched') THEN 'unknown' ELSE quota_state END,
            quota_debit_tokens=CASE WHEN quota_state IN ('reserved','dispatched') THEN quota_reserved_tokens ELSE quota_debit_tokens END,
            quota_reserved_tokens=CASE WHEN quota_state IN ('reserved','dispatched') THEN 0 ELSE quota_reserved_tokens END FROM eligible WHERE receipt.id=eligible.id`);
    }
    async renew(worker: string): Promise<void> {
        await this.metadata(
            `WITH eligible AS (SELECT id FROM model_usage_calls WHERE worker_id=$1 AND status='pending' AND lease_until>now() FOR UPDATE SKIP LOCKED)
            UPDATE model_usage_calls receipt SET lease_until=now()+interval '2 minutes' FROM eligible WHERE receipt.id=eligible.id`,
            [worker],
        );
    }
    async interrupt(worker: string): Promise<void> {
        await this.metadata(
            `WITH eligible AS (SELECT id FROM model_usage_calls WHERE worker_id=$1 AND status='pending' FOR UPDATE SKIP LOCKED)
            UPDATE model_usage_calls receipt SET status='interrupted',finished_at=now(),lease_until=NULL,
            quota_state=CASE WHEN quota_state IN ('reserved','dispatched') THEN 'unknown' ELSE quota_state END,
            quota_debit_tokens=CASE WHEN quota_state IN ('reserved','dispatched') THEN quota_reserved_tokens ELSE quota_debit_tokens END,
            quota_reserved_tokens=CASE WHEN quota_state IN ('reserved','dispatched') THEN 0 ELSE quota_reserved_tokens END FROM eligible WHERE receipt.id=eligible.id`,
            [worker],
        );
    }
    /** A total client deadline complements per-lock GUCs; pool.query discards the timed-out active client. */
    private async metadata(text: string, values?: unknown[]): Promise<void> {
        // pg-pool can open a new client ahead of queued checkouts; optional writes must yield to existing work.
        if (this.pool.waitingCount > 0) throw new Error('Usage metadata deferred while database work is queued');
        const query: QueryConfig & { query_timeout: number } = { text, values, query_timeout: 500 };
        await this.pool.query(query);
    }
    async canonicalProject(idOrName: string): Promise<string> {
        const row = (
            await this.pool.query<{ id: string }>(
                "SELECT id FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%') ORDER BY (id=$1) DESC LIMIT 1",
                [idOrName],
            )
        ).rows[0];
        return row?.id ?? idOrName;
    }
    async report(scope: UsageScope, filter: UsageFilter) {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const result = await readModelUsageReport(db, scope, filter);
            await db.query('COMMIT');
            return result;
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        } finally {
            db.release();
        }
    }
    /** Recheck the entire report audience after its snapshot, including facets and aggregates outside the history page. */
    async assertPrivateAudience(viewerEmail: string, rooms: UsagePrivateRoom[]): Promise<void> {
        if (!rooms.length) return;
        const row = (
            await this.pool.query<{ revoked: boolean }>(
                `SELECT EXISTS(
            SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS selected("projectId" text,"roomId" uuid)
            WHERE NOT EXISTS(SELECT 1 FROM project_chat_rooms room
                WHERE room.project_id=selected."projectId" AND room.id=selected."roomId" AND room.visibility='PRIVATE'
                AND (room.creator_email=$2 OR EXISTS(SELECT 1 FROM project_chat_room_members member
                    WHERE member.project_id=room.project_id AND member.room_id=room.id AND member.email=$2)))) AS revoked`,
                [JSON.stringify(rooms), viewerEmail],
            )
        ).rows[0];
        if (row?.revoked !== false)
            throw new ForbiddenException('Доступ к приватному диалогу изменился. Обновите журнал.');
    }
}
