/**
 * FR-305 (agt-11, phase B): the executor-process crash handler (the AD-O5 pattern for this process
 * boundary). uncaughtException/unhandledRejection → structured log (safe fields, AD-O8) →
 * error-store (best-effort, the frozen AD-O5 column contract) → the job-level crash record
 * (attempts+1, backoff deadline, the row back to pending; AD-O7 security/operations event) → the
 * controlled exit(1). «Catch and live on» is forbidden (epic 6 entry 10): the handler always ends
 * with the controlled exit; docker restarts the container and the NEXT pass applies the job-level
 * policy (retry with backoff / dead-letter / unknown without re-execution).
 *
 * The shared crash-handler.cjs for the six NestJS entrypoints is the scope of the AD-O5 story
 * (ready-for-dev, not in main): this module serves the background-agent executor boundary only. It
 * reuses the named resilience constants and the frozen observability contracts (error_events
 * shape, securityEvent) — it does not invent a second crash mechanism.
 *
 * A process-level crash (OOM/SIGKILL) cannot run this handler at all (no code runs on SIGKILL):
 * that path is the lease/reaper (pg-store) settling the journaled run as `unknown` without
 * re-execution. This handler covers the crashes the process still sees (uncaught exception /
 * unhandled rejection) — they are recorded at the JOB level (attempts + backoff), so the retry
 * budget and the dead-letter policy apply exactly as for an in-seam crash.
 */
import type { PoolClient } from 'pg';
import { securityEvent, type ISecurityEvent } from '../access/security-events';
import { BACKGROUND_AGENT_RESILIENCE, defaultCrashPolicy, type IBackgroundAgentCrashPolicy } from './resilience';

/** Fixed classifiers (AD-O8): a process-level crash never carries the raw error text. */
export const BACKGROUND_AGENT_PROCESS_CRASH = Object.freeze({
    code: 'PROCESS_CRASH',
    safeMessage: 'Background agent process crashed (uncaught exception or unhandled rejection).',
    /** The error_events request id when no job was in flight (the AD-O5 «crash» marker). */
    noJobRequestId: 'crash',
    /** The hard deadline of the controlled exit (a hung best-effort write never blocks the exit). */
    exitDeadlineMs: 10_000,
});

export interface ICrashHandlerDeps {
    /** Direct catalog access (the error store insert; the same shape CatalogCrashObservability uses). */
    client: Pick<PoolClient, 'query'>;
    /** The job-level state seam (findRow/recordCrash of the pg/lease store). */
    store: {
        findRow(requestId: string): Promise<{ request_key: string; attempts: number } | undefined>;
        recordCrash(
            requestKey: string,
            now: number,
            backoffMs: number,
        ): Promise<{ attempts: number; nextAttemptAt: number | null }>;
    };
    /** The request id of the in-flight job (null between tasks). */
    inFlight: () => string | null;
    policy?: IBackgroundAgentCrashPolicy;
    now?: () => number;
    /** Injectable for tests; defaults to process.exit. */
    exit?: (code: number) => void;
}

/** Frames + messages, truncated (AD-O5 OQ-1: top-20 frames, 4KB); never variable values. */
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

async function bestEffort(work: () => unknown): Promise<void> {
    try {
        await work();
    } catch {
        // best-effort by design (AD-O5: a visibility failure never blocks the crash path).
    }
}
async function bestEffortQuery<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
        return await work();
    } catch {
        return undefined;
    }
}

/**
 * Install the crash handler on this process. One handler per process; the handler is re-entrancy
 * guarded (a crash inside the crash path exits immediately) and deadline-bounded (the controlled
 * exit is guaranteed even if a best-effort write hangs).
 */
export function installCrashHandler(deps: ICrashHandlerDeps): void {
    const policy = deps.policy ?? defaultCrashPolicy;
    const now = deps.now ?? Date.now;
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    let active = false;

    const record = async (type: 'uncaughtException' | 'unhandledRejection', error: unknown): Promise<void> => {
        // 1. The structured log first (AD-O5 order: log → error-store → exit). A fixed classifier
        //    (AD-O8): the raw error text never crosses; the journal (docker log) stays the channel.
        try {
            process.stderr.write(
                JSON.stringify({ event: 'process-crash', code: BACKGROUND_AGENT_PROCESS_CRASH.code, type }) + '\n',
            );
        } catch {
            // the log channel itself is dead — the controlled exit below is the contract.
        }
        const inFlightId = deps.inFlight();
        const requestId = inFlightId ?? BACKGROUND_AGENT_PROCESS_CRASH.noJobRequestId;
        // 2. The error store (AD-O5, epic 6 entry 10): best-effort — a PG-down never blocks the crash path.
        await bestEffort(() =>
            deps.client.query(
                'INSERT INTO error_events(service,ts,level,request_id,message,stack_hint) VALUES($1,$2,$3,$4,$5,$6)',
                [
                    BACKGROUND_AGENT_RESILIENCE.service,
                    new Date(now()).toISOString(),
                    BACKGROUND_AGENT_RESILIENCE.errorLevel,
                    requestId,
                    BACKGROUND_AGENT_PROCESS_CRASH.safeMessage,
                    stackHintOf(error),
                ],
            ),
        );
        // 3. The job-level crash record (best-effort): attempts+1 + the backoff deadline, the row
        //    back to pending. The NEXT pass applies the policy: a journaled paid step settles as
        //    `unknown` without re-execution; an unconsumed step retries (the policy, not the
        //    handler, decides — the handler only records).
        if (inFlightId) {
            const row = await bestEffortQuery(() => deps.store.findRow(inFlightId));
            if (row) {
                const attempt = row.attempts + 1;
                const updated = await bestEffortQuery(() =>
                    deps.store.recordCrash(row.request_key, now(), policy.backoffMs(row.request_key, attempt)),
                );
                if (updated) {
                    const event: ISecurityEvent = {
                        actor: 'background-agent',
                        action: 'background_agent.crash',
                        resourceId: inFlightId,
                        before: { requestKey: row.request_key, phase: type },
                        after: { attempts: updated.attempts, nextAttemptAt: updated.nextAttemptAt },
                    };
                    await bestEffort(() => securityEvent(deps.client, event));
                }
            }
        }
        // 4. The controlled exit (epic 6 entry 10): «catch and live on» is forbidden.
        exit(1);
    };

    const handle = (type: 'uncaughtException' | 'unhandledRejection', error: unknown): void => {
        if (active) {
            // A crash inside the crash path: exit immediately (no second recording).
            exit(1);
            return;
        }
        active = true;
        const deadline = setTimeout(() => exit(1), BACKGROUND_AGENT_PROCESS_CRASH.exitDeadlineMs);
        if (typeof deadline.unref === 'function') deadline.unref();
        void record(type, error);
    };

    process.on('uncaughtException', (error) => handle('uncaughtException', error));
    process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason));
}
