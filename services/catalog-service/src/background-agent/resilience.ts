import type { PoolClient } from 'pg';
import {
    AGENT_RESULT_VERIFICATION_PROTOCOL,
    assertAgentResultAccepted,
    normalizeVerificationIntent,
    type IVerificationIntent,
} from '../../../shared/agent-result-verification.cjs';
import {
    backgroundAgentDigest,
    normalizeBackgroundAgentPayload,
    type IBackgroundAgentCheck,
    type IBackgroundAgentPayload,
} from '../../../shared/background-agent.cjs';
import { securityEvent, type ISecurityEvent } from '../access/security-events';
import { BackgroundContextError, TaskContext } from './context';
import type { IAgentRuntime, IAgentRuntimeOptions, IRuntimeInput, IRuntimeResult } from './runtime';
import { BackgroundWorkerError, type IBackgroundAgentStore, type IResultSink } from './worker';

/**
 * FR-305 crash-resilience for the server background agent (agt-11): crash policy, idempotency,
 * observability and recovery. This module DECORATES the Phase A seams (IBackgroundAgentStore /
 * IAgentRuntime / IResultSink / TaskContext / the FR-304 acceptance gate) — it does not rewrite them.
 *
 * Four properties (frozen intent):
 * 1. Crash policy — a crash (OOM/kill/container restart) applies a bounded policy at the JOB level
 *    (job-lifecycle, not in-process): retry with exponential backoff → dead-letter → explicit stop.
 *    «Catch and live on» is FORBIDDEN (epic 6 entry 10): a crash propagates as BackgroundCrashError;
 *    the process supervisor performs the controlled exit and docker restarts the container (AD-O5).
 * 2. Idempotency — the epic-8 entry 12 contract («шаг, уже потребивший бюджет, не повторяется после
 *    перезапуска»; pattern chat-discussion.runner.ts:79 / chat-discussion.repository.ts begin): every
 *    effect is checkpointed by request_key/phase. request_key = backgroundAgentDigest (the receipt
 *    idempotency digest of the normalized immutable payload). A journaled paid step is never
 *    re-dispatched: reopening an uncertain step never authorizes a replay.
 * 3. Observability — a crash is recorded in the error store (AD-O5, epic 6 entry 10: error_events
 *    service/ts/level/requestId/message-safe/stack-hint) and as a security/operations event (AD-O7,
 *    epic 6 entry 14: security_events via access/security-events.ts, unified history audit-history.ts).
 * 4. Recovery — docs/features/agent-method-workflows.md §«Отмена и восстановление»: the result is
 *    recorded BEFORE the ACK; a lost ACK re-delivers the SAME receipt (never a new result); after a
 *    restart where only a started marker is found the state is `unknown` with NO re-execution (no
 *    automatic paid retry after an unknown outcome); recovery preserves already-recorded facts and
 *    passed checks.
 */

/** Named limits — each limit is an enforcement point (NFR-6); the idiom follows DISCUSSION_LIMITS. */
export const BACKGROUND_AGENT_RESILIENCE = Object.freeze({
    service: 'catalog-service',
    /** Bounded retry budget (crash attempts) before the job is dead-lettered (global default; per-job override via policy). */
    maxAttempts: 3,
    /** Exponential backoff: base * factor^(attempt-1), capped. */
    backoffBaseMs: 500,
    backoffFactor: 2,
    backoffCapMs: 30_000,
    /** AD-O5 OQ-1: stack-hint = frames (file:line) + messages, truncated, never variable values. */
    stackHintFrames: 20,
    stackHintMaxBytes: 4096,
    /** AD-O5 OQ-2: a crash is always critical (alerts key off critical). */
    errorLevel: 'critical' as const,
});

/**
 * Effect phases checkpointed by request_key/phase (epic-8 entry 12 contract):
 * - `execution` — the paid runtime step (model turn + checks; consumes budget, writes workspace
 *   artifacts). Journaled ONCE BEFORE dispatch; conservative: a journaled step without a recorded
 *   result is never re-executed (a paid retry after an unknown outcome is forbidden).
 * - `result` — the recorded result («завершённый результат записывается до ACK»); journaled before
 *   recording so a crash between journal and record never double-records (artifact).
 * - `publish` — delivery of the immutable receipt (ACK-based): re-delivery of the SAME receipt is
 *   safe, so a lost ACK is recovered by re-delivery, never by a new result.
 */
export const BACKGROUND_AGENT_EFFECT_PHASES = Object.freeze(['execution', 'result', 'publish'] as const);
export type TBackgroundAgentEffectPhase = (typeof BACKGROUND_AGENT_EFFECT_PHASES)[number];

/** AD-O8: the crash message is a fixed classifier — raw error text (paths, payloads, secrets) never crosses. */
export const CRASH_SAFE_MESSAGE = 'Background agent run crashed (process-level failure: OOM/kill/restart).';
const DEAD_LETTER_SAFE_MESSAGE = 'Background agent job dead-lettered: retry budget exhausted (crash policy).';

/**
 * A process-level crash of a run (OOM/kill/restart) — NOT a verified run failure (those are results,
 * per the FR-304 contract). The signal propagates to the supervisor: controlled exit + docker restart
 * (AD-O5); «catch and live on» is forbidden.
 */
export class BackgroundCrashError extends Error {}

/** Job-level lifecycle state (pg/lease implementation lands with the compose service, phase B). */
export interface IBackgroundAgentJobState {
    /** backgroundAgentDigest of the normalized payload — the idempotency key of the task. */
    requestKey: string;
    /** Recorded crash runs (job-lifecycle attempts, not swallowed in-process exceptions). */
    attempts: number;
    /** Backoff deadline (epoch ms) before the next attempt is eligible; null when eligible. */
    nextAttemptAt: number | null;
    deadLetter: boolean;
    deadLetterReason?: string;
    /** Started marker without a verified result: outcome unknown, re-execution forbidden. */
    unknown: boolean;
    result: IRuntimeResult | null;
    /** The recorded receipt was acknowledged (delivered); otherwise a re-delivery is pending. */
    delivered: boolean;
}

/**
 * Job-level state + effect checkpoint seam (sibling to IBackgroundAgentStore, which stays frozen).
 * The in-memory implementation is the test/phase-A reference; the pg/lease implementation (surviving
 * process restarts) lands with the compose service in phase B.
 */
export interface IBackgroundAgentResilienceStore {
    getState(requestKey: string): Promise<IBackgroundAgentJobState | undefined>;
    /** Job-lifecycle crash: attempts+1 and the backoff deadline for the next attempt. */
    recordCrash(requestKey: string, now: number, backoffMs: number): Promise<IBackgroundAgentJobState>;
    markDeadLetter(requestKey: string, reason: string): Promise<IBackgroundAgentJobState>;
    markUnknown(requestKey: string): Promise<IBackgroundAgentJobState>;
    recordResult(requestKey: string, result: IRuntimeResult): Promise<IBackgroundAgentJobState>;
    markDelivered(requestKey: string): Promise<IBackgroundAgentJobState>;
    hasEffect(requestKey: string, phase: TBackgroundAgentEffectPhase): Promise<boolean>;
    journalEffect(requestKey: string, phase: TBackgroundAgentEffectPhase): Promise<void>;
}

/** In-memory resilience store (phase A / tests); the durable pg/lease implementation is phase B. */
export class MemoryBackgroundAgentResilienceStore implements IBackgroundAgentResilienceStore {
    private readonly jobs = new Map<string, IBackgroundAgentJobState>();
    private readonly effects = new Map<string, Set<TBackgroundAgentEffectPhase>>();

    private job(requestKey: string): IBackgroundAgentJobState {
        let job = this.jobs.get(requestKey);
        if (!job) {
            job = {
                requestKey,
                attempts: 0,
                nextAttemptAt: null,
                deadLetter: false,
                unknown: false,
                result: null,
                delivered: false,
            };
            this.jobs.set(requestKey, job);
        }
        return job;
    }

    async getState(requestKey: string): Promise<IBackgroundAgentJobState | undefined> {
        return this.jobs.get(requestKey);
    }
    async recordCrash(requestKey: string, now: number, backoffMs: number): Promise<IBackgroundAgentJobState> {
        const job = this.job(requestKey);
        job.attempts += 1;
        job.nextAttemptAt = now + backoffMs;
        return job;
    }
    async markDeadLetter(requestKey: string, reason: string): Promise<IBackgroundAgentJobState> {
        const job = this.job(requestKey);
        job.deadLetter = true;
        job.deadLetterReason = reason;
        return job;
    }
    async markUnknown(requestKey: string): Promise<IBackgroundAgentJobState> {
        const job = this.job(requestKey);
        job.unknown = true;
        return job;
    }
    async recordResult(requestKey: string, result: IRuntimeResult): Promise<IBackgroundAgentJobState> {
        const job = this.job(requestKey);
        job.result = result;
        return job;
    }
    async markDelivered(requestKey: string): Promise<IBackgroundAgentJobState> {
        const job = this.job(requestKey);
        job.delivered = true;
        return job;
    }
    async hasEffect(requestKey: string, phase: TBackgroundAgentEffectPhase): Promise<boolean> {
        return this.effects.get(requestKey)?.has(phase) ?? false;
    }
    async journalEffect(requestKey: string, phase: TBackgroundAgentEffectPhase): Promise<void> {
        let phases = this.effects.get(requestKey);
        if (!phases) {
            phases = new Set();
            this.effects.set(requestKey, phases);
        }
        phases.add(phase);
    }
}

/** Crash policy: global named constants + per-job override (open question 3 of the ticket). */
export interface IBackgroundAgentCrashPolicy {
    /** The retry budget of the job (the global default or a per-job override). */
    maxAttempts(requestKey: string): number;
    /** Exponential backoff (capped) before the next attempt; `attempt` is the just-crashed attempt. */
    backoffMs(requestKey: string, attempt: number): number;
}

export interface ICrashPolicyOptions {
    maxAttempts?: number;
    backoffBaseMs?: number;
    backoffFactor?: number;
    backoffCapMs?: number;
}

/** The global policy over the named constants; a per-job override is a policy that varies by requestKey. */
export function backgroundAgentCrashPolicy(options: ICrashPolicyOptions = {}): IBackgroundAgentCrashPolicy {
    const maxAttempts = options.maxAttempts ?? BACKGROUND_AGENT_RESILIENCE.maxAttempts;
    const base = options.backoffBaseMs ?? BACKGROUND_AGENT_RESILIENCE.backoffBaseMs;
    const factor = options.backoffFactor ?? BACKGROUND_AGENT_RESILIENCE.backoffFactor;
    const cap = options.backoffCapMs ?? BACKGROUND_AGENT_RESILIENCE.backoffCapMs;
    return {
        maxAttempts: () => maxAttempts,
        backoffMs: (_requestKey, attempt) => Math.min(cap, base * factor ** Math.max(0, attempt - 1)),
    };
}

export const defaultCrashPolicy: IBackgroundAgentCrashPolicy = backgroundAgentCrashPolicy();

/** An error_events row — the AD-O5 contract (epic 6 entry 10): service/ts/level/requestId/message-safe/stack-hint. */
export interface IErrorEventRow {
    service: string;
    ts: string;
    level: 'error' | 'critical';
    requestId: string;
    /** A fixed classifier, never the raw error text (AD-O8). */
    message: string;
    /** Truncated frames without variable values (AD-O5); absent when unavailable. */
    stackHint?: string;
}

/**
 * Crash → observability seam: error store (AD-O5) + security/operations events (AD-O7).
 * Unit tests inject the recording implementation; the catalog adapter consumes the real stores.
 */
export interface ICrashObservability {
    reportError(row: IErrorEventRow): Promise<void>;
    reportSecurityEvent(event: ISecurityEvent): Promise<void>;
}

/** Catalog adapter over the real stores. */
export class CatalogCrashObservability implements ICrashObservability {
    constructor(private readonly client: Pick<PoolClient, 'query'>) {}
    async reportError(row: IErrorEventRow): Promise<void> {
        // AD-O5 (epic-res-obs entry 10): error_events — the column shape follows the frozen AD-O5
        // contract (id/service/ts/level/request_id/message/stack_hint); the table + migration ship
        // with that story. Call sites are best-effort: a visibility failure never blocks the crash path.
        await this.client.query(
            'INSERT INTO error_events(service,ts,level,request_id,message,stack_hint) VALUES($1,$2,$3,$4,$5,$6)',
            [row.service, row.ts, row.level, row.requestId, row.message, row.stackHint ?? null],
        );
    }
    async reportSecurityEvent(event: ISecurityEvent): Promise<void> {
        // The real store (AD-O7): security_events via access/security-events.ts; visible in the
        // unified history (catalog/audit-history.ts).
        await securityEvent(this.client, event);
    }
}

/** Recording observability (unit tests / dev): the crash seam without PG. */
export class RecordingCrashObservability implements ICrashObservability {
    errorEvents: IErrorEventRow[] = [];
    securityEvents: ISecurityEvent[] = [];
    async reportError(row: IErrorEventRow): Promise<void> {
        this.errorEvents.push(row);
    }
    async reportSecurityEvent(event: ISecurityEvent): Promise<void> {
        this.securityEvents.push(event);
    }
}

/** Frames + messages, truncated (AD-O5 OQ-1: 4KB, top-20 frames); never variable values. */
function stackHintOf(error: unknown): string | undefined {
    if (!(error instanceof Error) || !error.stack) return undefined;
    const frames = error.stack
        .split('\n')
        .slice(1, BACKGROUND_AGENT_RESILIENCE.stackHintFrames + 1)
        .map((frame) => frame.trim())
        .filter((frame) => frame.length > 0);
    const hint = Buffer.from(frames.join('\n'))
        .subarray(0, BACKGROUND_AGENT_RESILIENCE.stackHintMaxBytes)
        .toString('utf8');
    return hint.length > 0 ? hint : undefined;
}

/** Best-effort visibility: a PG-down / observability failure never blocks the crash path (AD-O5). */
async function bestEffort(work: () => unknown): Promise<void> {
    try {
        await work();
    } catch {
        // best-effort by design (AD-O5: «error-store — best-effort, PG-down не блокирует exit»).
    }
}

interface ICrashRecorder {
    resilience: IBackgroundAgentResilienceStore;
    observability?: ICrashObservability;
    policy: IBackgroundAgentCrashPolicy;
    now: () => number;
}

/**
 * Record one job-lifecycle crash: error store first (AD-O5 order: log → error-store → exit), then the
 * job state (attempts + backoff deadline), then the security/operations event. Always ends by
 * throwing BackgroundCrashError — the crash is never swallowed («catch and live on» is forbidden).
 */
async function recordJobCrash(
    recorder: ICrashRecorder,
    requestKey: string,
    requestId: string,
    error: unknown,
    phase: string,
): Promise<never> {
    const now = recorder.now();
    await bestEffort(() =>
        recorder.observability?.reportError({
            service: BACKGROUND_AGENT_RESILIENCE.service,
            ts: new Date(now).toISOString(),
            level: BACKGROUND_AGENT_RESILIENCE.errorLevel,
            requestId,
            message: CRASH_SAFE_MESSAGE,
            stackHint: stackHintOf(error),
        }),
    );
    const previous = await recorder.resilience.getState(requestKey);
    const attempt = (previous?.attempts ?? 0) + 1;
    const updated = await recorder.resilience.recordCrash(
        requestKey,
        now,
        recorder.policy.backoffMs(requestKey, attempt),
    );
    await bestEffort(() =>
        recorder.observability?.reportSecurityEvent({
            actor: 'background-agent',
            action: 'background_agent.crash',
            resourceId: requestId,
            before: { requestKey, phase },
            after: { attempts: updated.attempts, nextAttemptAt: updated.nextAttemptAt },
        }),
    );
    throw new BackgroundCrashError(CRASH_SAFE_MESSAGE);
}

/**
 * The explicit unknown outcome (docs §«Отмена и восстановление»): a started marker without a result.
 * `new-request` is the actionable: the operator inspects and creates a new explicit request; an
 * automatic paid retry is forbidden.
 */
export function unknownExecutionReceipt(checks: IBackgroundAgentCheck[]): IRuntimeResult {
    return {
        protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
        state: 'unknown',
        stage: 'execution',
        checks: checks.map((check) => ({
            command: check.command,
            args: [...check.args],
            exitCode: null,
            signal: null,
            state: 'not_run' as const,
        })),
        failure: { code: 'UNKNOWN_OUTCOME', action: 'new-request' },
    };
}

/**
 * Resilient runtime: decorates the Phase A IAgentRuntime (the paid step). Idempotency (epic-8 entry
 * 12): the execution effect is journaled exactly once before dispatch (the started marker); a journaled
 * execution without a recorded result is NEVER re-executed — it yields the unknown receipt instead
 * (pattern chat-discussion.repository.ts begin: an uncertain step never authorizes a replay). A crash inside the run is recorded (error store + security event + job attempts/backoff)
 * and re-thrown as BackgroundCrashError — the process supervisor performs the controlled exit.
 */
export class ResilientAgentRuntime implements IAgentRuntime {
    constructor(
        private readonly inner: IAgentRuntime,
        private readonly requestKey: string,
        private readonly requestId: string,
        private readonly resilience: IBackgroundAgentResilienceStore,
        private readonly observability?: ICrashObservability,
        private readonly policy: IBackgroundAgentCrashPolicy = defaultCrashPolicy,
        private readonly now: () => number = Date.now,
    ) {}

    async run(input: IRuntimeInput, options?: IAgentRuntimeOptions): Promise<IRuntimeResult> {
        if (await this.resilience.hasEffect(this.requestKey, 'execution')) {
            const job = await this.resilience.getState(this.requestKey);
            if (job?.result) return job.result; // the same receipt — never a new result
            return unknownExecutionReceipt(input.checks); // started marker, no result: unknown, no re-execution
        }
        await this.resilience.journalEffect(this.requestKey, 'execution'); // journaled once before dispatch
        try {
            return await this.inner.run(input, options);
        } catch (error) {
            return await recordJobCrash(
                { resilience: this.resilience, observability: this.observability, policy: this.policy, now: this.now },
                this.requestKey,
                this.requestId,
                error,
                'execution',
            );
        }
    }
}

export interface IResilienceWorkerDeps {
    /** The Phase A job store (admit/claim/complete); the pg/lease implementation is phase B. */
    store: IBackgroundAgentStore;
    /** The Phase A runtime (decorated with ResilientAgentRuntime per attempt). */
    runtime: IAgentRuntime;
    /** Job-level state + effect checkpoint (in-memory here; pg/lease in phase B). */
    resilience: IBackgroundAgentResilienceStore;
    context?: TaskContext;
    sink?: IResultSink;
    policy?: IBackgroundAgentCrashPolicy;
    observability?: ICrashObservability;
    renderPrompt?: (instruction: string, rendered: string[]) => string;
    /** Injectable clock (backoff is testable without real delays). */
    now?: () => number;
}

/**
 * The crash-resilient background worker (FR-305): composes the Phase A seams with the job-lifecycle
 * crash policy, the request_key/phase effect checkpoints and the recovery semantics. Admission is the
 * Phase A normalized immutable task; the run is claim → context → runtime → fail-closed acceptance →
 * record-before-ACK → publish, with a checkpoint around every effect. A crash propagates as
 * BackgroundCrashError (controlled exit + docker restart); the NEXT pass (after the restart) applies
 * the policy: retry with backoff → dead-letter → explicit stop, or `unknown` without re-execution.
 */
export class CrashResilientBackgroundWorker {
    private readonly store: IBackgroundAgentStore;
    private readonly runtime: IAgentRuntime;
    private readonly resilience: IBackgroundAgentResilienceStore;
    private readonly context: TaskContext;
    private readonly sink?: IResultSink;
    private readonly policy: IBackgroundAgentCrashPolicy;
    private readonly observability?: ICrashObservability;
    private readonly renderPrompt: (instruction: string, rendered: string[]) => string;
    private readonly now: () => number;

    constructor(deps: IResilienceWorkerDeps) {
        this.store = deps.store;
        this.runtime = deps.runtime;
        this.resilience = deps.resilience;
        this.context = deps.context ?? TaskContext.defaults();
        this.sink = deps.sink;
        this.policy = deps.policy ?? defaultCrashPolicy;
        this.observability = deps.observability;
        this.renderPrompt =
            deps.renderPrompt ??
            ((instruction, rendered) =>
                rendered.length ? `${instruction}\n\nTask context:\n${rendered.join('\n')}` : instruction);
        this.now = deps.now ?? Date.now;
    }

    /** Admission: the normalized immutable task (server-fixed fields, declared checks); the store pins the digest. */
    async admit(value: unknown): Promise<IBackgroundAgentPayload> {
        const payload = normalizeBackgroundAgentPayload(value);
        await this.store.admit(payload);
        return payload;
    }

    /**
     * Process an admitted task — or recover it after a crash/restart. Job-level policy, in order:
     * unknown (settled or detected from a started marker) → dead-letter (explicit stop) → recorded
     * result (re-delivery of the SAME receipt on a lost ACK, idempotent re-process otherwise) →
     * retry budget exhausted (dead-letter + error store + event) → backoff (explicit «not yet») →
     * a new checkpointed attempt. A crash rejects with BackgroundCrashError — it is never swallowed.
     */
    async process(requestId: string): Promise<IRuntimeResult> {
        const payload = await this.store.claim(requestId);
        if (!payload) throw new BackgroundWorkerError(`Фоновая задача ${requestId} не найдена или уже завершена.`);
        const checked = normalizeBackgroundAgentPayload(payload);
        const requestKey = backgroundAgentDigest(checked);
        const intent = normalizeVerificationIntent({
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            checks: checked.checks,
        });
        const job = await this.resilience.getState(requestKey);

        // Recovery: unknown outcome — a started marker without a verified result. The same unknown
        // receipt, NO re-execution (docs §«Отмена и восстановление»; no automatic paid retry).
        if (job?.unknown)
            return this.settleReceipt(
                requestId,
                requestKey,
                intent,
                job.result ?? unknownExecutionReceipt(checked.checks),
            );
        if (job && !job.result && !job.deadLetter && (await this.resilience.hasEffect(requestKey, 'execution'))) {
            await this.resilience.markUnknown(requestKey);
            return this.settleReceipt(requestId, requestKey, intent, unknownExecutionReceipt(checked.checks));
        }
        // Recovery: dead-lettered — explicit stop; the same receipt, no re-execution.
        if (job?.deadLetter)
            return this.settleReceipt(
                requestId,
                requestKey,
                intent,
                job.result ?? unknownExecutionReceipt(checked.checks),
            );
        // Recovery: a recorded result — a lost ACK re-delivers the SAME receipt (same digest/result,
        // never a new result); a settled job re-processes idempotently to the same recorded receipt.
        if (job?.result) return this.settleReceipt(requestId, requestKey, intent, job.result);

        // Crash policy: the retry budget is exhausted → dead-letter (recorded + error store + event),
        // explicit stop with a receipt (I/O row 3–4).
        if (job && job.attempts >= this.policy.maxAttempts(requestKey)) {
            const updated = await this.resilience.markDeadLetter(requestKey, 'Retry budget exhausted (crash policy).');
            await this.reportDeadLetter(updated, requestId);
            return this.settleReceipt(requestId, requestKey, intent, unknownExecutionReceipt(checked.checks));
        }
        // Crash policy: the backoff deadline has not passed — the retry is scheduled; an explicit
        // «not yet» (no silent waiting, NFR-2). The supervisor re-processes after the deadline.
        if (job?.nextAttemptAt && this.now() < job.nextAttemptAt)
            throw new BackgroundWorkerError(
                `Фоновая задача ${requestId}: повтор запланирован, backoff до ${new Date(job.nextAttemptAt).toISOString()}.`,
            );

        return this.runAttempt(requestId, requestKey, checked, intent);
    }

    /** One attempt: context → runtime (checkpointed) → fail-closed acceptance → record-before-ACK → publish. */
    private async runAttempt(
        requestId: string,
        requestKey: string,
        checked: IBackgroundAgentPayload,
        intent: IVerificationIntent,
    ): Promise<IRuntimeResult> {
        // Context (prerequisites): a legitimate failure (BackgroundContextError) is the Phase A
        // verified failed receipt; any OTHER rejection is a process-level crash BEFORE the paid step
        // (no budget consumed) → the crash policy (a retry-eligible crash).
        let root: string;
        let rendered: string[];
        try {
            const prepared = await this.context.prepare(checked.projectId, checked.context);
            root = prepared.root;
            rendered = prepared.descriptors.map((descriptor) => descriptor.rendered);
        } catch (error) {
            if (error instanceof BackgroundContextError) {
                const receipt: IRuntimeResult = {
                    protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
                    state: 'failed',
                    stage: 'prerequisites',
                    checks: checked.checks.map((check) => ({
                        command: check.command,
                        args: [...check.args],
                        exitCode: null,
                        signal: null,
                        state: 'not_run' as const,
                    })),
                    failure: { code: 'EXECUTION_FAILED', action: 'new-request' },
                };
                return this.settleReceipt(requestId, requestKey, intent, receipt);
            }
            return await recordJobCrash(
                { resilience: this.resilience, observability: this.observability, policy: this.policy, now: this.now },
                requestKey,
                requestId,
                error,
                'context',
            );
        }
        // The paid step through the resilient runtime (the execution checkpoint + crash recording).
        const runtime = new ResilientAgentRuntime(
            this.runtime,
            requestKey,
            requestId,
            this.resilience,
            this.observability,
            this.policy,
            this.now,
        );
        const result = await runtime.run(
            {
                root,
                prompt: this.renderPrompt(checked.instruction, rendered),
                checks: checked.checks,
                deadlineAt: checked.deadlineAt,
            },
            {},
        );
        // Fail-closed acceptance (FR-304): «done» without verification is not accepted.
        assertAgentResultAccepted(result, result.state !== 'succeeded', intent);
        return this.settleReceipt(requestId, requestKey, intent, result);
    }

    /**
     * Record-before-ACK + publish with checkpoints: the `result` effect is journaled before recording
     * (no double record/artifact), the receipt is then delivered; an ACK is an explicit mark — a lost
     * ACK re-delivers the same immutable receipt (the `publish` phase is ACK-based, not pre-journaled).
     */
    private async settleReceipt(
        requestId: string,
        requestKey: string,
        intent: IVerificationIntent,
        receipt: IRuntimeResult,
    ): Promise<IRuntimeResult> {
        assertAgentResultAccepted(receipt, receipt.state !== 'succeeded', intent);
        if (!(await this.resilience.hasEffect(requestKey, 'result'))) {
            await this.resilience.journalEffect(requestKey, 'result');
            await this.store.complete(requestId, receipt);
            await this.resilience.recordResult(requestKey, receipt);
        }
        const job = await this.resilience.getState(requestKey);
        if (!job?.delivered) {
            // The `publish` effect is ACK-based: journaled (and the job marked delivered) exactly when
            // the delivery duty settles; a failed delivery (lost ACK) leaves no journal — the receipt
            // is re-delivered, never replaced.
            if (this.sink) await this.sink.deliver(requestId, receipt);
            await this.resilience.journalEffect(requestKey, 'publish');
            await this.resilience.markDelivered(requestKey);
        }
        return receipt;
    }

    /** Dead-letter visibility: error store (AD-O5) + security/operations event (AD-O7). */
    private async reportDeadLetter(job: IBackgroundAgentJobState, requestId: string): Promise<void> {
        await bestEffort(() =>
            this.observability?.reportError({
                service: BACKGROUND_AGENT_RESILIENCE.service,
                ts: new Date(this.now()).toISOString(),
                level: BACKGROUND_AGENT_RESILIENCE.errorLevel,
                requestId,
                message: DEAD_LETTER_SAFE_MESSAGE,
            }),
        );
        await bestEffort(() =>
            this.observability?.reportSecurityEvent({
                actor: 'background-agent',
                action: 'background_agent.dead_letter',
                resourceId: requestId,
                before: { requestKey: job.requestKey, attempts: job.attempts },
                after: { deadLetter: true, reason: job.deadLetterReason ?? null },
            }),
        );
    }
}
