import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { backgroundAgentDigest, type IBackgroundAgentPayload } from '../../../../shared/background-agent.cjs';
import { AGENT_RESULT_VERIFICATION_PROTOCOL } from '../../../../shared/agent-result-verification.cjs';
import { TaskContext, type IContextDescriptor, type IContextProvider } from '../context';
import type { IAgentRuntime, IRuntimeInput, IRuntimeResult } from '../runtime';
import type { IBackgroundAgentStore, IResultSink } from '../worker';
import {
    BACKGROUND_AGENT_RESILIENCE,
    BackgroundCrashError,
    CatalogCrashObservability,
    CrashResilientBackgroundWorker,
    CRASH_SAFE_MESSAGE,
    MemoryBackgroundAgentResilienceStore,
    RecordingCrashObservability,
    backgroundAgentCrashPolicy,
    type IErrorEventRow,
    type IResilienceWorkerDeps,
} from '../resilience';

const okCheck = { command: 'node', args: ['-e', 'process.exit(0)'] };
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
/** The instruction carries a fake secret: AD-O8 — it must never reach the error store / events. */
const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    protocol: 'background-agent-v1',
    workflowId: '11111111-1111-4111-8111-111111111111',
    requestId: REQUEST_ID,
    projectId: 'prj-bg',
    method: 'openspec',
    methodVersion: '1.15.0',
    instruction: 'Фоновая задача с TOPSECRET значением',
    checks: [okCheck],
    deadlineAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    runtime: 'opencode',
    ...overrides,
});

/** Phase A job store (in-memory reference; the lease/pg implementation lands with the compose service, phase B). */
class MemoryJobStore implements IBackgroundAgentStore {
    admitted: IBackgroundAgentPayload[] = [];
    completed: Array<{ requestId: string; result: IRuntimeResult }> = [];
    async admit(p: IBackgroundAgentPayload): Promise<void> {
        if (!this.admitted.some((row) => row.requestId === p.requestId)) this.admitted.push(p);
    }
    async claim(requestId: string): Promise<IBackgroundAgentPayload | undefined> {
        return this.admitted.find((row) => row.requestId === requestId);
    }
    async complete(requestId: string, result: IRuntimeResult): Promise<void> {
        this.completed.push({ requestId, result });
    }
}
class RecordingSink implements IResultSink {
    delivered: Array<{ requestId: string; result: IRuntimeResult }> = [];
    /** Simulated lost ACKs (process death during publish) for the next N deliveries. */
    lostAcks = 0;
    async deliver(requestId: string, result: IRuntimeResult): Promise<void> {
        if (this.lostAcks > 0) {
            this.lostAcks -= 1;
            throw new Error('ACK lost (simulated process death during publish)');
        }
        this.delivered.push({ requestId, result });
    }
}
/**
 * Scripted runtime: the paid boundary is the start of the run (the model turn consumes budget and the
 * workspace artifact is written); an Error step is a process-level crash (OOM/kill) after the budget
 * is consumed, a result step is a verified FR-304 outcome.
 */
class ScriptedRuntime implements IAgentRuntime {
    calls = 0;
    budget = 0;
    artifacts = 0;
    constructor(private readonly step: () => IRuntimeResult | Error) {}
    async run(_input: IRuntimeInput): Promise<IRuntimeResult> {
        this.calls += 1;
        this.budget += 1;
        this.artifacts += 1;
        const out = this.step();
        if (out instanceof Error) throw out;
        return out;
    }
}
const succeeded = (): IRuntimeResult => ({
    protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
    state: 'succeeded',
    stage: 'completed',
    checks: [{ command: okCheck.command, args: [...okCheck.args], exitCode: 0, signal: null, state: 'passed' }],
});
const crashMidTurn = () => new Error('simulated OOM kill mid-turn');
/** A context provider that process-crashes (a plain, non-BackgroundContextError rejection) N times: a kill mid-run before the paid step. */
class CrashContextProvider implements IContextProvider {
    readonly source = 'project' as const;
    private failures: number;
    constructor(failures = Infinity) {
        this.failures = failures;
    }
    async prepare(): Promise<IContextDescriptor> {
        if (this.failures > 0) {
            this.failures -= 1;
            throw new Error('simulated kill -9 during the run (before the paid step)');
        }
        return { source: 'project', rendered: 'Project working directory: /data/projects/prj-bg' };
    }
}

const makeWorker = (deps: IResilienceWorkerDeps): CrashResilientBackgroundWorker =>
    new CrashResilientBackgroundWorker(deps);

describe('CrashResilientBackgroundWorker (FR-305 agt-11: crash policy, idempotency, observability, recovery)', () => {
    it('(a) a crash before the paid step: retry with backoff up to the named limit → dead-letter + error_events + events', async () => {
        const clock = { t: 0 };
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const observability = new RecordingCrashObservability();
        const sink = new RecordingSink();
        const runtime = new ScriptedRuntime(succeeded);
        const w = makeWorker({
            store,
            runtime,
            resilience,
            sink,
            observability,
            context: new TaskContext([new CrashContextProvider(Infinity)]),
            now: () => clock.t,
        });
        const admitted = await w.admit(payload());
        const requestKey = backgroundAgentDigest(admitted);

        // Attempt 1 (t=0): crash recorded (error store + event), attempt 1, backoff 500ms.
        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError);
        let job = (await resilience.getState(requestKey))!;
        expect(job.attempts).toBe(1);
        expect(job.nextAttemptAt! - clock.t).toBe(BACKGROUND_AGENT_RESILIENCE.backoffBaseMs); // 500ms

        // Backoff not elapsed: an explicit «not yet», no execution (no silent waiting, NFR-2).
        clock.t = 100;
        await expect(w.process(REQUEST_ID)).rejects.toThrow(/backoff/);
        expect(runtime.calls).toBe(0);

        // Attempt 2 (t=600): crash, attempt 2, backoff 1000ms.
        clock.t = 600;
        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError);
        job = (await resilience.getState(requestKey))!;
        expect(job.attempts).toBe(2);
        expect(job.nextAttemptAt! - clock.t).toBe(
            BACKGROUND_AGENT_RESILIENCE.backoffBaseMs * BACKGROUND_AGENT_RESILIENCE.backoffFactor,
        ); // 1000ms

        // Attempt 3 (t=1600): crash, attempt 3 (the named limit), backoff 2000ms recorded.
        clock.t = 1600;
        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError);
        job = (await resilience.getState(requestKey))!;
        expect(job.attempts).toBe(BACKGROUND_AGENT_RESILIENCE.maxAttempts);
        expect(job.nextAttemptAt! - clock.t).toBe(
            BACKGROUND_AGENT_RESILIENCE.backoffBaseMs * BACKGROUND_AGENT_RESILIENCE.backoffFactor ** 2,
        ); // 2000ms

        // Retry budget exhausted → dead-letter + error store + event, explicit stop with a receipt, no execution.
        clock.t = 2000;
        const result = await w.process(REQUEST_ID);
        job = (await resilience.getState(requestKey))!;
        expect(job.deadLetter).toBe(true);
        expect(job.deadLetterReason).toBeTruthy();
        expect(result.state).toBe('unknown');
        expect(result.failure).toEqual({ code: 'UNKNOWN_OUTCOME', action: 'new-request' });
        expect(runtime.calls).toBe(0); // the paid step is never executed
        expect(sink.delivered).toHaveLength(1); // the explicit stop receipt is delivered once
        expect(sink.delivered[0].result.state).toBe('unknown');

        // Observability: one error row + one security event per crash, plus the dead-letter record (NFR-2: no silent death).
        expect(observability.errorEvents).toHaveLength(4);
        expect(observability.errorEvents.slice(0, 3).every((row) => row.message === CRASH_SAFE_MESSAGE)).toBe(true);
        expect(observability.errorEvents[3].message).toMatch(/dead-letter/);
        expect(
            observability.errorEvents.every(
                (row) =>
                    row.level === 'critical' &&
                    row.service === BACKGROUND_AGENT_RESILIENCE.service &&
                    row.requestId === REQUEST_ID,
            ),
        ).toBe(true);
        expect(observability.securityEvents.map((event) => event.action)).toEqual([
            'background_agent.crash',
            'background_agent.crash',
            'background_agent.crash',
            'background_agent.dead_letter',
        ]);
        expect(observability.securityEvents.every((event) => event.resourceId === REQUEST_ID)).toBe(true);
    });

    it('(b) idempotency: a crash after the paid step is never re-executed — each effect exactly once per request_key/phase', async () => {
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const observability = new RecordingCrashObservability();
        const sink = new RecordingSink();
        const runtime = new ScriptedRuntime(crashMidTurn);
        const w = makeWorker({ store, runtime, resilience, sink, observability });
        const admitted = await w.admit(payload());
        const requestKey = backgroundAgentDigest(admitted);

        // Attempt 1: the paid step is journaled and dispatched (budget + artifact), then the process crashes.
        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError);

        // Restart: a fresh worker instance shares the durable job state (docker restarts the container).
        const w2 = makeWorker({ store, runtime, resilience, sink, observability });
        const recovered = await w2.process(REQUEST_ID);

        // The retried (recovery) run does NOT double-consume: budget/artifact/publish each fired exactly
        // once per request_key/phase — the execution checkpoint forbids re-dispatching a paid step
        // (epic-8 entry 12 contract).
        expect(runtime.calls).toBe(1);
        expect(runtime.budget).toBe(1);
        expect(runtime.artifacts).toBe(1);
        expect(sink.delivered).toHaveLength(1); // the unknown receipt is published once
        expect(recovered.state).toBe('unknown');
        for (const phase of ['execution', 'result', 'publish'] as const)
            expect(await resilience.hasEffect(requestKey, phase)).toBe(true);
    });

    it('(b2) a true retry (a crash before the paid step) re-runs the paid step once — no duplicated effects', async () => {
        const clock = { t: 0 };
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const sink = new RecordingSink();
        const runtime = new ScriptedRuntime(succeeded);
        const w = makeWorker({
            store,
            runtime,
            resilience,
            sink,
            context: new TaskContext([new CrashContextProvider(1)]), // attempt 1 crashes, attempt 2 recovers
            now: () => clock.t,
        });
        await w.admit(payload());

        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError); // attempt 1: nothing consumed
        clock.t += BACKGROUND_AGENT_RESILIENCE.backoffBaseMs; // the backoff elapsed
        const result = await w.process(REQUEST_ID); // the retry

        expect(result.state).toBe('succeeded');
        expect(runtime.calls).toBe(1); // the paid step ran once in total (attempt 1 consumed nothing)
        expect(runtime.budget).toBe(1);
        expect(runtime.artifacts).toBe(1);
        expect(store.completed).toHaveLength(1); // the result is recorded once
        expect(sink.delivered).toHaveLength(1); // published once
    });

    it('(c) a crash → an error_events row + a security/operations event (AD-O5 + AD-O7, via the recording seam)', async () => {
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const observability = new RecordingCrashObservability();
        const runtime = new ScriptedRuntime(crashMidTurn);
        const w = makeWorker({ store, runtime, resilience, observability });
        await w.admit(payload());

        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError);

        // The error store row (AD-O5: service/ts/level/requestId/message-safe/stack-hint).
        expect(observability.errorEvents).toHaveLength(1);
        const row = observability.errorEvents[0];
        expect(row.service).toBe(BACKGROUND_AGENT_RESILIENCE.service);
        expect(row.level).toBe(BACKGROUND_AGENT_RESILIENCE.errorLevel);
        expect(row.requestId).toBe(REQUEST_ID);
        expect(Number.isFinite(Date.parse(row.ts))).toBe(true);
        expect(row.message).toBe(CRASH_SAFE_MESSAGE);
        expect(row.stackHint).toBeTypeOf('string');
        expect(Buffer.byteLength(row.stackHint!)).toBeLessThanOrEqual(BACKGROUND_AGENT_RESILIENCE.stackHintMaxBytes);

        // The security/operations event (AD-O7).
        expect(observability.securityEvents).toHaveLength(1);
        const event = observability.securityEvents[0];
        expect(event.actor).toBe('background-agent');
        expect(event.action).toBe('background_agent.crash');
        expect(event.resourceId).toBe(REQUEST_ID);

        // AD-O8: no raw error text, no instruction secret crosses into the visibility records.
        const safe = JSON.stringify({ ...row, ...event });
        expect(safe).not.toContain('TOPSECRET');
        expect(safe).not.toContain('simulated OOM kill mid-turn');
        expect(safe).not.toContain('kill -9');
    });

    it('(d) recovery: a restart where only a started marker exists → state unknown, NO re-execution', async () => {
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const observability = new RecordingCrashObservability();
        const sink = new RecordingSink();
        const runtime = new ScriptedRuntime(crashMidTurn);
        const w = makeWorker({ store, runtime, resilience, sink, observability });
        const admitted = await w.admit(payload());
        const requestKey = backgroundAgentDigest(admitted);

        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError);
        const callsBeforeRecovery = runtime.calls; // the crashed attempt

        // Restart: only the started marker (the execution checkpoint) exists, no recorded result.
        const w2 = makeWorker({ store, runtime, resilience, sink, observability });
        const result = await w2.process(REQUEST_ID);

        expect(result.state).toBe('unknown');
        expect(result.stage).toBe('execution');
        expect(result.failure).toEqual({ code: 'UNKNOWN_OUTCOME', action: 'new-request' });
        expect(result.checks).toEqual([
            { command: okCheck.command, args: [...okCheck.args], exitCode: null, signal: null, state: 'not_run' },
        ]);
        expect(runtime.calls).toBe(callsBeforeRecovery); // 0 runtime invocations on the recovery pass
        const job = (await resilience.getState(requestKey))!;
        expect(job.unknown).toBe(true);
    });

    it('(e) a lost ACK → re-delivery of the SAME receipt (same digest/result), not a new result', async () => {
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const observability = new RecordingCrashObservability();
        const sink = new RecordingSink();
        sink.lostAcks = 1; // the first delivery (after the result is recorded) loses its ACK
        const runtime = new ScriptedRuntime(succeeded);
        const w = makeWorker({ store, runtime, resilience, sink, observability });
        await w.admit(payload());

        await expect(w.process(REQUEST_ID)).rejects.toThrow(/ACK lost/);
        expect(store.completed).toHaveLength(1); // the result was recorded BEFORE the ACK (docs §«Отмена и восстановление»)

        // Restart: the recorded result exists, the ACK was lost → re-delivery of the same receipt.
        const w2 = makeWorker({ store, runtime, resilience, sink, observability });
        const recovered = await w2.process(REQUEST_ID);

        expect(runtime.calls).toBe(1); // NO re-execution
        expect(sink.delivered).toHaveLength(1); // exactly one (re-)delivery
        expect(store.completed).toHaveLength(1); // no double record
        // The re-delivered receipt IS the recorded one: same object, same digest — not a new result.
        expect(sink.delivered[0].result).toBe(store.completed[0].result);
        expect(recovered).toBe(store.completed[0].result);
        expect(observability.errorEvents).toHaveLength(0); // a lost ACK is a delivery failure, not a crash
    });

    it('(f) recovery preserves already-recorded facts + passed checks', async () => {
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const sink = new RecordingSink();
        sink.lostAcks = 1;
        const runtime = new ScriptedRuntime(succeeded);
        const w = makeWorker({ store, runtime, resilience, sink });
        await w.admit(payload());

        await expect(w.process(REQUEST_ID)).rejects.toThrow(/ACK lost/);
        const w2 = makeWorker({ store, runtime, resilience, sink });
        const recovered = await w2.process(REQUEST_ID);

        // The recorded facts survive the restart: the result is intact with its passed checks
        // (not degraded to not_run), and it is the one delivered on recovery.
        expect(recovered.state).toBe('succeeded');
        expect(recovered.checks).toEqual([
            { command: okCheck.command, args: [...okCheck.args], exitCode: 0, signal: null, state: 'passed' },
        ]);
        expect(store.completed).toHaveLength(1);
        expect(sink.delivered[0].result).toBe(recovered);
        expect(runtime.calls).toBe(1);
    });

    it('a settled job re-processes idempotently to the same recorded receipt (no re-execution)', async () => {
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const sink = new RecordingSink();
        const runtime = new ScriptedRuntime(succeeded);
        const w = makeWorker({ store, runtime, resilience, sink });
        await w.admit(payload());

        const first = await w.process(REQUEST_ID);
        const second = await w.process(REQUEST_ID);

        expect(second).toBe(first);
        expect(runtime.calls).toBe(1);
        expect(sink.delivered).toHaveLength(1);
        expect(store.completed).toHaveLength(1);
    });

    it('a per-job retry override (open question 3): the job dead-letters on its own budget', async () => {
        const clock = { t: 0 };
        const store = new MemoryJobStore();
        const resilience = new MemoryBackgroundAgentResilienceStore();
        const observability = new RecordingCrashObservability();
        const runtime = new ScriptedRuntime(succeeded);
        const w = makeWorker({
            store,
            runtime,
            resilience,
            observability,
            policy: backgroundAgentCrashPolicy({ maxAttempts: 1 }), // per-job override of the global limit
            context: new TaskContext([new CrashContextProvider(Infinity)]),
            now: () => clock.t,
        });
        const admitted = await w.admit(payload());
        const requestKey = backgroundAgentDigest(admitted);

        await expect(w.process(REQUEST_ID)).rejects.toThrow(BackgroundCrashError); // the single allowed attempt
        clock.t += BACKGROUND_AGENT_RESILIENCE.backoffBaseMs;
        const result = await w.process(REQUEST_ID); // the override budget is exhausted → dead-letter

        const job = (await resilience.getState(requestKey))!;
        expect(job.deadLetter).toBe(true);
        expect(job.attempts).toBe(1);
        expect(result.state).toBe('unknown');
        expect(observability.securityEvents.map((event) => event.action)).toEqual([
            'background_agent.crash',
            'background_agent.dead_letter',
        ]);
    });

    it('the catalog adapter consumes the real stores: error_events (AD-O5 shape) + securityEvent (AD-O7)', async () => {
        const queries: Array<{ text: string; values: unknown[] }> = [];
        const client = {
            query: (text: string, values?: unknown[]) => {
                queries.push({ text, values: values ?? [] });
                return Promise.resolve({ rows: [] });
            },
        } as unknown as Pick<PoolClient, 'query'>;
        const observability = new CatalogCrashObservability(client);
        const row: IErrorEventRow = {
            service: BACKGROUND_AGENT_RESILIENCE.service,
            ts: new Date(0).toISOString(),
            level: 'critical',
            requestId: REQUEST_ID,
            message: CRASH_SAFE_MESSAGE,
            stackHint: 'at resilience.ts:1:1',
        };
        await observability.reportError(row);
        await observability.reportSecurityEvent({
            actor: 'background-agent',
            action: 'background_agent.crash',
            resourceId: REQUEST_ID,
            before: { requestKey: 'k', phase: 'execution' },
            after: { attempts: 1, nextAttemptAt: 500 },
        });

        // error_events: the frozen AD-O5 column shape (service/ts/level/request_id/message/stack_hint).
        expect(queries[0].text).toBe(
            'INSERT INTO error_events(service,ts,level,request_id,message,stack_hint) VALUES($1,$2,$3,$4,$5,$6)',
        );
        expect(queries[0].values).toEqual([row.service, row.ts, row.level, row.requestId, row.message, row.stackHint]);
        // security_events: the real securityEvent helper (access/security-events.ts, AD-O7).
        expect(queries[1].text).toMatch(/^INSERT INTO security_events\(/);
        expect(queries[1].values).toEqual([
            expect.any(String),
            'background-agent',
            'background_agent.crash',
            REQUEST_ID,
            JSON.stringify({ requestKey: 'k', phase: 'execution' }),
            JSON.stringify({ attempts: 1, nextAttemptAt: 500 }),
        ]);
    });
});
