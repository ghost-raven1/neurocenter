/**
 * FR-305 (agt-11, phase B): the executor-process crash handler (the AD-O5 pattern for the
 * background-agent process boundary). The handler is installed on the real `process` and driven by
 * emitting `uncaughtException`/`unhandledRejection` (the listeners Node attaches by default are
 * replaced by ours while installed). Every test installs a fresh handler and tears the listeners
 * down afterwards: one handler per process is the contract.
 */
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_AGENT_PROCESS_CRASH, installCrashHandler } from '../crash-handler';
import { BACKGROUND_AGENT_RESILIENCE } from '../resilience';

const REQUEST_ID = '22222222-4222-4222-8222-222222222222';
/** backgroundAgentDigest shape: 64 hex chars (the idempotency key). */
const REQUEST_KEY = 'a'.repeat(64);
const NOW = 1_760_000_000_000;

/** Records every query; simulates PG-down by rejecting. */
class FakeClient {
    rows: Array<{ sql: string; values: unknown[] }> = [];
    fail = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pg overloads shape is not asserted here
    async query(sql: any, values?: any): Promise<any> {
        if (this.fail) throw new Error('PG down (simulated)');
        this.rows.push({ sql, values: values ?? [] });
        return { rows: [] };
    }
}
/** The pg/lease store seam as the handler sees it (findRow/recordCrash only). */
class FakeStore {
    row: { request_key: string; attempts: number } | undefined = { request_key: REQUEST_KEY, attempts: 0 };
    findCalls: string[] = [];
    crashCalls: Array<{ requestKey: string; now: number; backoffMs: number }> = [];
    fail = false;
    async findRow(requestId: string) {
        this.findCalls.push(requestId);
        if (this.fail) throw new Error('store down (simulated)');
        return this.row;
    }
    async recordCrash(requestKey: string, now: number, backoffMs: number) {
        if (this.fail) throw new Error('store down (simulated)');
        this.crashCalls.push({ requestKey, now, backoffMs });
        return { attempts: (this.row?.attempts ?? 0) + 1, nextAttemptAt: now + backoffMs };
    }
}

/** Install a fresh handler with controlled deps; returns the spies and the mutable in-flight state. */
const install = (opts: { inFlightId?: string | null; failClient?: boolean; failStore?: boolean } = {}) => {
    const client = new FakeClient();
    const store = new FakeStore();
    if (opts.failClient) client.fail = true;
    if (opts.failStore) store.fail = true;
    const exit = vi.fn();
    const state = { inFlightId: opts.inFlightId ?? null };
    installCrashHandler({
        client,
        store,
        inFlight: () => state.inFlightId,
        now: () => NOW,
        exit,
    });
    return { client, store, exit, state };
};
const errorRows = (client: FakeClient) => client.rows.filter((row) => row.sql.includes('INSERT INTO error_events'));
const securityRows = (client: FakeClient) =>
    client.rows.filter((row) => row.sql.includes('INSERT INTO security_events'));
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0])).join('');

afterEach(() => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('installCrashHandler (FR-305 agt-11 phase B: the executor-process crash boundary)', () => {
    it('a crash with no job in flight: the fixed-classifier error row (request id "crash") + the controlled exit(1), no job touch', async () => {
        const { client, store, exit } = install();
        const stderr = vi.spyOn(process.stderr, 'write');
        process.emit('uncaughtException', new Error('boom TOPSECRET-path /data/secret.json'));
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        // 1. The structured log first (the journal channel), fixed classifier, no raw text.
        const journal = lines(stderr);
        expect(journal).toContain('"event":"process-crash"');
        expect(journal).toContain(`"code":"${BACKGROUND_AGENT_PROCESS_CRASH.code}"`);
        expect(journal).toContain('"type":"uncaughtException"');
        expect(journal).not.toContain('TOPSECRET');
        // 2. The error store: one row, the AD-O5 column contract, the «crash» marker id.
        const rows = errorRows(client);
        expect(rows).toHaveLength(1);
        expect(rows[0].values).toEqual([
            BACKGROUND_AGENT_RESILIENCE.service,
            new Date(NOW).toISOString(),
            BACKGROUND_AGENT_RESILIENCE.errorLevel,
            BACKGROUND_AGENT_PROCESS_CRASH.noJobRequestId,
            BACKGROUND_AGENT_PROCESS_CRASH.safeMessage,
            expect.any(String),
        ]);
        // 3. No job in flight: the job seam and the security channel are untouched.
        expect(store.findCalls).toHaveLength(0);
        expect(store.crashCalls).toHaveLength(0);
        expect(securityRows(client)).toHaveLength(0);
    });

    it('a crash mid-job: the job-level crash record (attempts+1, the named backoff) + the security/operations event', async () => {
        const { client, store, exit } = install({ inFlightId: REQUEST_ID });
        process.emit('uncaughtException', new Error('OOM mid-turn'));
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        // The policy backoff: 500ms * 2^(attempt-1) for the first recorded attempt.
        expect(store.crashCalls).toEqual([
            { requestKey: REQUEST_KEY, now: NOW, backoffMs: BACKGROUND_AGENT_RESILIENCE.backoffBaseMs },
        ]);
        // The error row carries the in-flight job id (not the «crash» marker).
        expect(errorRows(client)[0].values[3]).toBe(REQUEST_ID);
        // The security/operations event: the fixed action + the job digests, the attempt facts.
        const sec = securityRows(client);
        expect(sec).toHaveLength(1);
        expect(sec[0].values).toEqual([
            expect.any(String),
            'background-agent',
            'background_agent.crash',
            REQUEST_ID,
            JSON.stringify({ requestKey: REQUEST_KEY, phase: 'uncaughtException' }),
            JSON.stringify({ attempts: 1, nextAttemptAt: NOW + BACKGROUND_AGENT_RESILIENCE.backoffBaseMs }),
        ]);
    });

    it('a crash with PG down: best-effort — the structured log and the controlled exit still happen (never blocked)', async () => {
        const { client, store, exit } = install({ inFlightId: REQUEST_ID, failClient: true, failStore: true });
        const stderr = vi.spyOn(process.stderr, 'write');
        process.emit('uncaughtException', new Error('boom while PG is down'));
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        // The journal line is the last channel and it still fires.
        expect(lines(stderr)).toContain(`"code":"${BACKGROUND_AGENT_PROCESS_CRASH.code}"`);
        // Every best-effort write failed: nothing landed, but the exit was not blocked.
        expect(client.rows).toHaveLength(0);
        expect(store.crashCalls).toHaveLength(0);
        expect(exit).toHaveBeenCalledTimes(1);
    });

    it('an unhandledRejection: the same path with the rejection classifier', async () => {
        const { client, exit } = install();
        const stderr = vi.spyOn(process.stderr, 'write');
        process.emit('unhandledRejection', new Error('rejected with TOPSECRET detail'), Promise.resolve());
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        expect(lines(stderr)).toContain('"type":"unhandledRejection"');
        expect(lines(stderr)).not.toContain('TOPSECRET');
        // The raw reason never crosses into the store values (AD-O8).
        const rows = errorRows(client);
        expect(rows).toHaveLength(1);
        expect(rows[0].values[4]).toBe(BACKGROUND_AGENT_PROCESS_CRASH.safeMessage);
        expect(JSON.stringify(rows[0].values)).not.toContain('TOPSECRET');
    });

    it('AD-O8: the raw error text never crosses into any store value', async () => {
        const { client, exit } = install({ inFlightId: REQUEST_ID });
        const raw = 'TOPSECRET-raw-error-abcdef123';
        process.emit('uncaughtException', new Error(raw));
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        expect(client.rows.length).toBeGreaterThan(0);
        for (const row of client.rows) {
            expect(JSON.stringify(row.values)).not.toContain(raw);
        }
    });

    it('a crash inside the crash path: the re-entrancy guard exits immediately, no second recording', async () => {
        const { client, store, exit } = install({ inFlightId: REQUEST_ID });
        process.emit('uncaughtException', new Error('first crash'));
        // A second crash before the first record settles (the handler is already active).
        process.emit('uncaughtException', new Error('second crash'));
        // The guard's exit(1) happens synchronously on the second crash; the first record then
        // completes with its own exit. The second crash recorded nothing (one job record total).
        await vi.waitFor(() => expect(exit.mock.calls.length).toBeGreaterThanOrEqual(2));
        expect(errorRows(client)).toHaveLength(1);
        expect(securityRows(client)).toHaveLength(1);
        expect(store.crashCalls).toHaveLength(1);
    });

    it('AD-O5 OQ-1: the stack hint is truncated (top-20 frames, 4KB) and never carries the message line', async () => {
        const { client, exit } = install();
        const frames = Array.from(
            { length: 60 },
            (_, i) => `    at frame${i} (${'x'.repeat(200)}${i}.js:${i + 1}:${i + 1})`,
        );
        const err = new Error('truncation-secret-message');
        err.stack = `Error: truncation-secret-message\n${frames.join('\n')}`;
        process.emit('uncaughtException', err);
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
        const row = errorRows(client)[0];
        const hint = row.values[5];
        expect(typeof hint).toBe('string');
        expect(String(hint).split('\n').length).toBeLessThanOrEqual(BACKGROUND_AGENT_RESILIENCE.stackHintFrames);
        expect(Buffer.byteLength(String(hint), 'utf8')).toBeLessThanOrEqual(
            BACKGROUND_AGENT_RESILIENCE.stackHintMaxBytes,
        );
        expect(String(hint)).not.toContain('truncation-secret-message');
        expect(JSON.stringify(row.values)).not.toContain('truncation-secret-message');
    });

    it('a hung best-effort write: the hard deadline still guarantees the controlled exit', async () => {
        vi.useFakeTimers();
        const exit = vi.fn();
        const never = (): Promise<never> => new Promise(() => {});
        installCrashHandler({
            client: { query: never } as unknown as Pick<PoolClient, 'query'>,
            store: { findRow: never, recordCrash: never },
            inFlight: () => REQUEST_ID,
            exit,
        });
        process.emit('uncaughtException', new Error('a write that never settles'));
        expect(exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(BACKGROUND_AGENT_PROCESS_CRASH.exitDeadlineMs);
        expect(exit).toHaveBeenCalledWith(1);
    });
});
