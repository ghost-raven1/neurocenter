import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IBackgroundAgentPayload } from '../../../../shared/background-agent.cjs';
import { AGENT_RESULT_VERIFICATION_PROTOCOL } from '../../../../shared/agent-result-verification.cjs';
import { BackgroundAgentWorker, BackgroundWorkerError, type IBackgroundAgentStore, type IResultSink } from '../worker';
import { TaskContext } from '../context';
import type { IAgentRuntime, IRuntimeInput, IRuntimeResult } from '../runtime';

const ok = { command: 'node', args: ['-e', 'process.exit(0)'] };
const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    protocol: 'background-agent-v1',
    workflowId: '11111111-1111-4111-8111-111111111111',
    requestId: '22222222-2222-4222-8222-222222222222',
    projectId: 'prj-bg',
    method: 'openspec',
    methodVersion: '1.15.0',
    instruction: 'Фоновая задача',
    checks: [ok],
    deadlineAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    runtime: 'opencode',
    ...overrides,
});

/** In-memory store (the lease/pg implementation lands with the compose service, phase B). */
class MemoryStore implements IBackgroundAgentStore {
    admitted: IBackgroundAgentPayload[] = [];
    completed: Array<{ requestId: string; result: IRuntimeResult }> = [];
    async admit(payload: IBackgroundAgentPayload): Promise<void> {
        if (!this.admitted.some((row) => row.requestId === payload.requestId)) this.admitted.push(payload);
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
    async deliver(requestId: string, result: IRuntimeResult): Promise<void> {
        this.delivered.push({ requestId, result });
    }
}
class StubRuntime implements IAgentRuntime {
    seen: IRuntimeInput[] = [];
    constructor(private readonly result: (input: IRuntimeInput) => IRuntimeResult) {}
    async run(input: IRuntimeInput): Promise<IRuntimeResult> {
        this.seen.push(input);
        return this.result(input);
    }
}
const succeededResult = (): IRuntimeResult => ({
    protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
    state: 'succeeded',
    stage: 'completed',
    checks: [{ command: ok.command, args: [...ok.args], exitCode: 0, signal: null, state: 'passed' }],
});
const worker = (deps: {
    store: IBackgroundAgentStore;
    runtime: IAgentRuntime;
    sink?: IResultSink;
    context?: TaskContext;
}) => new BackgroundAgentWorker({ ...deps, context: deps.context ?? TaskContext.defaults() });

describe('BackgroundAgentWorker (FR-305: async core, fail-closed acceptance, seams)', () => {
    const originalRoot = process.env.PROJECTS_ROOT;
    afterEach(() => {
        if (originalRoot === undefined) delete process.env.PROJECTS_ROOT;
        else process.env.PROJECTS_ROOT = originalRoot;
    });

    it('admits only a normalized immutable task (server-fixed fields, declared checks)', async () => {
        const store = new MemoryStore();
        const w = worker({ store, runtime: new StubRuntime(succeededResult) });
        const admitted = await w.admit(payload());
        expect(admitted.methodVersion).toBe('1.15.0');
        expect(store.admitted).toHaveLength(1);
        // A caller-supplied method version is never trusted (server-fixed).
        await expect(w.admit(payload({ methodVersion: '9.9.9' }))).rejects.toThrow(TypeError);
        expect(store.admitted).toHaveLength(1);
    });

    it('processes a task end to end: context → runtime → verified result → delivery and completion', async () => {
        const base = mkdtempSync(path.join(tmpdir(), 'nc-bg-wk-'));
        process.env.PROJECTS_ROOT = base;
        const store = new MemoryStore();
        const sink = new RecordingSink();
        const runtime = new StubRuntime(succeededResult);
        const w = new BackgroundAgentWorker({ store, runtime, sink, context: TaskContext.defaults() });
        await w.admit(payload());
        const result = await w.process('22222222-2222-4222-8222-222222222222');
        expect(result.state).toBe('succeeded');
        // The runtime ran in the resolved project root with the instruction and rendered context.
        expect(runtime.seen).toHaveLength(1);
        expect(runtime.seen[0].root).toBe(path.resolve(base, 'prj-bg'));
        expect(runtime.seen[0].prompt).toContain('Фоновая задача');
        expect(runtime.seen[0].prompt).toContain('Task context');
        expect(sink.delivered).toHaveLength(1);
        expect(store.completed).toHaveLength(1);
        expect(store.completed[0].result.state).toBe('succeeded');
    });

    it('accepts a failed outcome only as an explicit verified failure (delivered and completed)', async () => {
        const failedResult: IRuntimeResult = {
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            state: 'failed',
            stage: 'checks',
            checks: [{ command: ok.command, args: [...ok.args], exitCode: 1, signal: null, state: 'failed' }],
            failure: { code: 'CHECK_FAILED', action: 'review-result' },
        };
        const store = new MemoryStore();
        const sink = new RecordingSink();
        const w = worker({ store, runtime: new StubRuntime(() => failedResult), sink });
        await w.admit(payload());
        const result = await w.process('22222222-2222-4222-8222-222222222222');
        expect(result.state).toBe('failed');
        expect(sink.delivered).toHaveLength(1);
        expect(store.completed[0].result.state).toBe('failed');
    });

    it('is fail-closed: a «succeeded» without passing checks is not accepted (FR-304)', async () => {
        const bogus: IRuntimeResult = {
            protocol: AGENT_RESULT_VERIFICATION_PROTOCOL,
            state: 'succeeded',
            stage: 'completed',
            checks: [],
        };
        const store = new MemoryStore();
        const w = worker({ store, runtime: new StubRuntime(() => bogus) });
        await w.admit(payload());
        await expect(w.process('22222222-2222-4222-8222-222222222222')).rejects.toThrow(TypeError);
        // Nothing is delivered and nothing is completed: the task is not silently lost.
        expect(store.completed).toHaveLength(0);
    });

    it('a context prerequisite failure is an explicit failed result before execution (all checks not_run)', async () => {
        const store = new MemoryStore();
        const sink = new RecordingSink();
        const runtime = new StubRuntime(succeededResult);
        const w = worker({ store, runtime, sink });
        await w.admit(payload({ context: { computer: {} } }));
        const result = await w.process('22222222-2222-4222-8222-222222222222');
        expect(result.state).toBe('failed');
        expect(result.stage).toBe('prerequisites');
        expect(result.failure).toEqual({ code: 'EXECUTION_FAILED', action: 'new-request' });
        expect(result.checks[0].state).toBe('not_run');
        expect(runtime.seen).toHaveLength(0);
        expect(store.completed).toHaveLength(1);
        expect(sink.delivered).toHaveLength(1);
    });

    it('refuses to process an unknown task (no silent loss)', async () => {
        const store = new MemoryStore();
        const w = worker({ store, runtime: new StubRuntime(succeededResult) });
        await expect(w.process('33333333-3333-4333-8333-333333333333')).rejects.toThrow(BackgroundWorkerError);
    });

    it('renders the requested context sources into the prompt (project + web)', async () => {
        const store = new MemoryStore();
        const runtime = new StubRuntime(succeededResult);
        const w = worker({ store, runtime });
        await w.admit(payload({ context: { project: {}, web: {} } }));
        await w.process('22222222-2222-4222-8222-222222222222');
        expect(runtime.seen[0].prompt).toContain('Project working directory');
        expect(runtime.seen[0].prompt).toMatch(/web/i);
    });
});
