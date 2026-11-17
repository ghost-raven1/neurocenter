/**
 * FR-305 (agt-07, phase B): the background-agent executor process (compose service `background-agent`).
 *
 * `--check` — the compose healthcheck: production environment (shared runtime.cjs), the pinned
 * autonomous-package engine (OQ-2) and the catalog schema (read-only readiness). No side effects.
 *
 * No arguments — the supervisor loop: scan → the worker's atomic claim (pg/lease) → context →
 * pinned opencode run → fail-closed acceptance → record-before-ACK → chat publication. A job-level
 * crash is a controlled exit(1) (docker restart); the crash policy (backoff → dead letter, unknown
 * without re-execution) applies on the NEXT pass. A run-level worker error releases the lease and
 * the loop continues. The chat is never blocked: admission happens in catalog-service, here only
 * the durable rows are processed.
 */
import { BackgroundAgentChatSink } from './chat-sink';
import { TaskContext } from './context';
import { installCrashHandler } from './crash-handler';
import { writeDeadLetterAlert } from './dead-letter-alert';
import { BackgroundEngineError, assertBackgroundAgentEngine, type IBackgroundAgentEngine } from './engine';
import { BACKGROUND_AGENT_LEASE, PgBackgroundAgentStore } from './pg-store';
import { BackgroundCrashError, CatalogCrashObservability, CrashResilientBackgroundWorker } from './resilience';
import { OpenCodeAgentRuntime, PinnedEngineRuntime } from './runtime';
import { BackgroundWorkerError } from './worker';
import { checkCatalogSchema, ensureCatalogSchema } from '../database/catalog-schema';
import { createPool } from '../database/pool';

const POLL_MS = 5_000;
const RENEW_MS = 60_000;
const REAP_MS = 30_000;
const GRACE_MS = 30_000;

const log = (object: unknown): void => {
    console.log(JSON.stringify(object));
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared environment gate: the service refuses to run (or pass healthcheck) on a bad environment. */
function assertEnvironment(): void {
    require('../../../shared/runtime.cjs');
}

/** The compose healthcheck (I/O row 3: a missing component is an explicit error, never a fallback). */
async function runCheck(): Promise<void> {
    const fail = (code: string, message: string): void => {
        console.log(JSON.stringify({ ok: false, error: { code, message } }));
        process.exit(1);
    };
    try {
        assertEnvironment();
    } catch (error) {
        fail('ENVIRONMENT', error instanceof Error ? error.message : String(error));
        return;
    }
    let engine: IBackgroundAgentEngine;
    try {
        engine = await assertBackgroundAgentEngine();
    } catch (error) {
        if (error instanceof BackgroundEngineError) fail('ENGINE', error.message);
        throw error;
    }
    const url = process.env.CATALOG_PG_URL?.trim();
    if (!url) fail('DATABASE', 'Настройте закрытое подключение CATALOG_PG_URL.');
    const pool = createPool({ connectionString: url, max: 1 }, 'background-agent-check');
    try {
        const readiness = await checkCatalogSchema(pool, true);
        console.log(
            JSON.stringify({
                ok: true,
                engine: { version: engine.version, sha256: engine.sha256 },
                database: { ready: readiness.ready },
            }),
        );
    } catch (error) {
        fail('SCHEMA', error instanceof Error ? error.message : String(error));
    } finally {
        await pool.end().catch(() => undefined);
    }
}

/** The supervisor loop (one executor today; the claim/lease stay correct at scale, OQ-1). */
async function runLoop(): Promise<void> {
    try {
        assertEnvironment();
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'startup-failed',
                code: 'ENVIRONMENT',
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        process.exit(1);
    }
    let engine: IBackgroundAgentEngine;
    try {
        engine = await assertBackgroundAgentEngine();
    } catch (error) {
        if (error instanceof BackgroundEngineError) {
            console.error(JSON.stringify({ event: 'startup-failed', code: 'ENGINE', message: error.message }));
            process.exit(1);
        }
        throw error;
    }
    const url = process.env.CATALOG_PG_URL?.trim();
    if (!url) {
        console.error(
            JSON.stringify({ event: 'startup-failed', code: 'DATABASE', message: 'Настройте CATALOG_PG_URL.' }),
        );
        process.exit(1);
    }
    const pool = createPool({ connectionString: url, max: 4 }, 'background-agent');
    try {
        await ensureCatalogSchema(pool);
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'startup-failed',
                code: 'SCHEMA',
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        await pool.end().catch(() => undefined);
        process.exit(1);
    }

    const store = new PgBackgroundAgentStore(pool);
    const worker = new CrashResilientBackgroundWorker({
        store,
        runtime: new PinnedEngineRuntime(new OpenCodeAgentRuntime(), engine.path),
        resilience: store,
        context: TaskContext.defaults(),
        sink: new BackgroundAgentChatSink(pool, store),
        observability: new CatalogCrashObservability(pool),
    });

    let stopping = false;
    let busy = false;
    let currentRequestId: string | null = null;
    const timers: { poll?: NodeJS.Timeout; renew?: NodeJS.Timeout; reap?: NodeJS.Timeout } = {};

    // The AD-O5 crash handler for this process boundary (agt-11): uncaught exception / unhandled
    // rejection → log → error store → job-level crash record (attempts + backoff) → controlled
    // exit(1). docker restarts the container; the NEXT pass applies the job-level policy.
    installCrashHandler({ client: pool, store, inFlight: () => currentRequestId });

    const shutdown = async (code: number, waitForRun = true): Promise<void> => {
        if (stopping) return;
        stopping = true;
        if (timers.poll) clearInterval(timers.poll);
        if (timers.renew) clearInterval(timers.renew);
        if (timers.reap) clearInterval(timers.reap);
        if (waitForRun) {
            const deadline = Date.now() + GRACE_MS;
            while (busy && Date.now() < deadline) await sleep(250);
        }
        // A still-claimed run gives its lease back: the reaper/next pass settles it (a journaled
        // paid step never re-executes — the unknown receipt).
        if (currentRequestId) await store.releaseLease(currentRequestId).catch(() => undefined);
        await pool.end().catch(() => undefined);
        process.exit(code);
    };

    const tick = async (): Promise<void> => {
        if (stopping || busy) return;
        busy = true;
        try {
            const [requestId] = await store.processableRequestIds(1);
            if (!requestId) return;
            currentRequestId = requestId;
            log({ event: 'dispatch', requestId });
            // E2E fault injection (agt-11): a REAL uncaughtException on the dispatch pass — before
            // the claim and the paid step — so the process-boundary crash handler (installed above)
            // is exercised end-to-end: structured log → error store → job-level crash record →
            // controlled exit(1) → the restart applies the job-level policy. Gated by an env the
            // production environment never sets (the compose environment-model would flag it as
            // drift); the injected error is the only synthetic part — the handler, the stores and
            // the exit are the real production path.
            if (process.env.BACKGROUND_AGENT_E2E_CRASH_DISPATCH) {
                process.emit('uncaughtException', new Error('e2e crash injection (dispatch pass)'));
                await new Promise<void>(() => {}); // the tick stops here; the handler exits the process
            }
            const before = await store.findRow(requestId);
            await worker.process(requestId);
            log({ event: 'processed', requestId });
            // The dead-letter alert channel (epic 6 entry 13): alerted exactly once on the
            // → dead_letter transition (re-processing a dead-lettered job does not re-alert).
            const after = await store.findRow(requestId);
            if (after?.state === 'dead_letter' && before?.state !== 'dead_letter') {
                await writeDeadLetterAlert({ requestKey: after.request_key, requestId });
                log({ event: 'dead-letter-alerted', requestId });
            }
        } catch (error) {
            if (error instanceof BackgroundCrashError) {
                // The crash policy already settled the row (attempts + backoff or dead letter);
                // the controlled exit lets docker restart and the NEXT pass apply the policy.
                console.error(JSON.stringify({ event: 'crash-exit', message: error.message }));
                await shutdown(1, false);
                return;
            }
            if (error instanceof BackgroundWorkerError) {
                // A legitimate not-yet/not-anymore: release the claim (a no-op when not running).
                if (currentRequestId) await store.releaseLease(currentRequestId).catch(() => undefined);
            } else {
                // A process-level surprise: the row keeps its lease; the reaper recovers it when the
                // lease expires. Log a fixed classifier, never the raw error text.
                console.error(JSON.stringify({ event: 'tick-failed', code: 'PROCESS_ERROR' }));
            }
        } finally {
            currentRequestId = null;
            busy = false;
        }
    };

    log({ event: 'started', engine: engine.version, leaseMs: BACKGROUND_AGENT_LEASE.leaseMs });
    timers.poll = setInterval(() => void tick(), POLL_MS);
    timers.renew = setInterval(() => {
        if (currentRequestId) void store.renewLease(currentRequestId).catch(() => undefined);
    }, RENEW_MS);
    timers.reap = setInterval(() => {
        void store.reapExpired().catch(() => undefined);
    }, REAP_MS);
    void tick();

    process.on('SIGTERM', () => void shutdown(0));
    process.on('SIGINT', () => void shutdown(0));
    // The timers and the pool keep the process alive until shutdown().
    await new Promise<void>(() => undefined);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') {
        void runCheck();
    } else if (args.length === 0) {
        void runLoop();
    } else {
        console.error('Используйте --check или запустите без аргументов.');
        process.exitCode = 2;
    }
}
