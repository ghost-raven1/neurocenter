import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SystemRoleRunner } from '../src/system-roles/system-role.runner';
import { coordinatorContext, coordinatorPlan } from '../src/system-roles/system-role.coordinator';
import { roleCallBudget, roleDefinitionPin } from '../src/system-roles/system-role.definitions';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { requiredRouteFeatures } from '../../shared/feature-policy.cjs';
import { allowSystemRoleRoute } from '../src/system-roles/system-role.access';
import type { RolePrepared, RoleRunRow, SystemRoleId } from '../src/system-roles/system-role.types';
const diagnosis = (summary: string) => ({ kind: 'diagnosis', summary, findings: [], nextSteps: [], changes: [] });
const task = (roleId: SystemRoleId, targetKeys: string[] = [], diagnostics: string[] = []) => ({ roleId, instruction: 'Проверь свою часть задачи.', targetKeys, diagnostics });
const plan = (...delegations: ReturnType<typeof task>[]) => JSON.stringify({ delegations });
function fixture(tasks = [task('agent-ai-admin'), task('agent-indexer')]) {
    const selection = { projectId: null, instruction: 'Проверь настройки и состояние индекса.', diagnostics: ['health', 'index'],
        targets: [{ kind: 'adapter', id: 'adapter-one' }, { kind: 'prompt', id: 'prompt-one', text: 'SELECTED PROMPT' }] };
    const snapshot = { selection, definitionPin: roleDefinitionPin('agent-coordinator'), consentDigest: 'digest', targets: [
        { key: 'adapter:adapter-one', kind: 'adapter', id: 'adapter-one', modelContent: 'PRIVATE ADAPTER CONTEXT', before: {}, editable: true },
        { key: 'prompt:prompt-one', kind: 'prompt', id: 'prompt-one', modelContent: 'SELECTED PROMPT', before: {}, editable: true }], preview: '' } as unknown as RolePrepared;
    snapshot.preview = JSON.stringify({ instruction: selection.instruction, delegation: coordinatorContext(snapshot) });
    const row = { id: '12345678-1234-1234-1234-123456789abc', agent_id: 'agent-coordinator', actor: 'admin@example.test', actor_role: 'Главный админ',
        project_id: null, state: 'running', phase: 'collecting', lease_token: 'lease', calls_started: 0, result: null, facts: [], snapshot,
        request: { ...selection, modelId: 'model-one', expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: snapshot.definitionPin, consentDigest: 'digest' } } as unknown as RoleRunRow;
    const control = { authorized: true, context: true, disabled: new Set<string>() }, controller = new AbortController();
    const model = { id: 'model-one', runtime: 'ollama', capability: 'chat', manifestSha256: 'a'.repeat(64) };
    const features = vi.fn(async (flags: string[]) => { if (flags.some(flag => control.disabled.has(flag))) throw new Error('feature disabled'); });
    const policy = { current: vi.fn(async () => { if (!control.authorized) throw new Error('authority revoked'); return model; }), models: { pool: { query: vi.fn(async () => ({ rows: [] })) } } };
    const targets = { prepare: vi.fn(async () => ({ consentDigest: control.context ? 'digest' : 'changed', targets: snapshot.targets })), replacement: vi.fn() };
    const repository = { pool: {}, fenced: vi.fn(async (_id, _lease, work) => { if (row.state !== 'running') throw new ConflictException('lease fenced'); return work({}, row); }),
        change: vi.fn(async (_db, current, state, phase, message, patch) => Object.assign(current, { state, phase, message }, patch)),
        reserveCall: vi.fn(async (_id, _lease, authorize) => { await authorize({}, row); if (row.calls_started >= roleCallBudget(row.agent_id)) throw new Error('budget'); row.calls_started++; return row; }) };
    const calls: Array<{ id: string | undefined; flags: unknown; messages: unknown }> = [];
    let coordinations = 0;
    const infer = vi.fn(async (_model, _capability, input, _signal?: AbortSignal) => { const usage = currentModelUsage(); await usage.beforeInference?.();
        calls.push({ id: usage.agentId, flags: usage.requiredFeatures, messages: input.messages });
        const content = usage.agentId === 'agent-coordinator' && coordinations++ === 0 ? plan(...tasks) : JSON.stringify(diagnosis(usage.agentId === 'agent-coordinator' ? 'Проверены независимые ответы.' : 'Ответ ' + usage.agentId));
        return { done_reason: 'stop', message: { role: 'assistant', content } }; });
    const diagnostic = vi.fn(async (kind: string) => ({ id: 'fact-' + kind, kind, checkedAt: '2026-10-24T00:00:00Z', status: 'measured', data: {} }));
    const runner = new SystemRoleRunner(repository as never, policy as never, targets as never, { infer }, async () => undefined, features as never, diagnostic as never);
    return { row, snapshot, control, controller, calls, infer, features, targets, repository, run: () => runner.run({} as never, row, controller.signal) };
}

describe('Coordinator plan is an untrusted bounded selection', () => {
    it.each([
        ['empty', []], ['self', [task('agent-coordinator')]], ['unknown', [task('invented' as never)]],
        ['duplicate', [task('agent-indexer'), task('agent-indexer')]],
        ['fanout', [task('agent-ai-admin'), task('agent-indexer'), task('agent-autoconfigurator'), task('agent-packager')]],
        ['foreign target', [task('agent-indexer', ['adapter:adapter-one'])]],
        ['unselected target', [task('agent-ai-admin', ['adapter:other'])]],
        ['unselected diagnostic', [task('agent-ai-admin', [], ['bridge'])]],
        ['wrong role diagnostic', [task('agent-indexer', [], ['health'])]],
        ['duplicate targets', [task('agent-ai-admin', ['adapter:adapter-one', 'adapter:adapter-one'])]],
        ['malformed task', [{ ...task('agent-indexer'), instruction: '' }]],
        ['nested delegation', [{ ...task('agent-indexer'), delegations: [task('agent-ai-admin')] }]],
    ])('rejects %s before any child request', (_name, tasks) => {
        const f = fixture(); expect(() => coordinatorPlan(JSON.stringify({ delegations: tasks }), f.snapshot)).toThrow('План делегирования');
    });
    it('exposes exact role capabilities and limits in prepared context', () => {
        const f = fixture(), context = coordinatorContext(f.snapshot);
        expect(context).toMatchObject({ maxDelegations: 3, maxDepth: 1, maxCalls: 5 });
        expect(context.roles.find(role => role.id === 'agent-ai-admin')).toMatchObject({ targetKeys: ['adapter:adapter-one'], diagnostics: ['health'] });
        expect(context.roles.find(role => role.id === 'agent-indexer')).toMatchObject({ targetKeys: [], diagnostics: ['index'] });
        expect(context.roles.some(role => role.id === 'agent-coordinator')).toBe(false);
    });
});

describe('Coordinator delegates through the durable runtime', () => {
    it('keeps saved history and cancellation accessible after new work is disabled', () => {
        const root = '/api/system-roles/agent-coordinator', run = root + '/runs/12345678-1234-1234-1234-123456789abc';
        expect(requiredRouteFeatures('POST', root + '/prepare')).toEqual(['system_coordinator']);
        expect(requiredRouteFeatures('GET', run)).toEqual([]); expect(requiredRouteFeatures('POST', run + '/cancel')).toEqual([]);
        expect(allowSystemRoleRoute('Наблюдатель', 'GET', run)).toBe(true);
        expect(allowSystemRoleRoute('Наблюдатель', 'POST', run + '/cancel')).toBe(true);
        expect(allowSystemRoleRoute('Наблюдатель', 'POST', root + '/runs')).toBe(false);
    });
    it('runs real role contracts on only their chosen scope and persists collected answers with usage attribution', async () => {
        const f = fixture([task('agent-ai-admin', ['adapter:adapter-one'], ['health']), task('agent-autoconfigurator', ['prompt:prompt-one'])]);
        f.snapshot.preview = JSON.stringify({ targets: f.snapshot.targets.map(target => ({ key: target.key, content: target.modelContent })) });
        await f.run();
        expect(f.row).toMatchObject({ state: 'succeeded', calls_started: 4, result: { summary: 'Проверены независимые ответы.', delegations: [
            { roleId: 'agent-ai-admin', state: 'succeeded' }, { roleId: 'agent-autoconfigurator', state: 'succeeded' }] } });
        expect(f.calls.map(call => call.id)).toEqual(['agent-coordinator', 'agent-ai-admin', 'agent-autoconfigurator', 'agent-coordinator']);
        expect(f.calls[1].flags).toEqual(['system_coordinator', 'system_ai_admin']);
        expect(f.calls[2].flags).toEqual(['system_coordinator', 'system_autoconfigurator']);
        expect(JSON.stringify(f.calls[0].messages)).not.toContain('PRIVATE ADAPTER CONTEXT');
        expect(JSON.stringify(f.calls[0].messages)).not.toContain('SELECTED PROMPT');
        expect(JSON.stringify(f.calls[1].messages)).toContain('PRIVATE ADAPTER CONTEXT');
        expect(JSON.stringify(f.calls[1].messages)).not.toContain('SELECTED PROMPT');
        expect(JSON.stringify(f.calls[2].messages)).not.toContain('PRIVATE ADAPTER CONTEXT');
        expect(JSON.stringify(f.calls[2].messages)).toContain('SELECTED PROMPT');
    });
    it('reaches the five-call bound with three independent roles and one synthesis', async () => {
        const f = fixture([task('agent-ai-admin'), task('agent-indexer'), task('agent-packager')]); await f.run();
        expect(f.row.calls_started).toBe(5); expect(f.calls).toHaveLength(5); expect(f.row.result?.delegations).toHaveLength(3);
    });
    it('rejects an invalid model plan without child inference or an automatic repair', async () => {
        const f = fixture([task('agent-coordinator')]); await expect(f.run()).rejects.toThrow('План делегирования');
        expect(f.calls.map(call => call.id)).toEqual(['agent-coordinator']); expect(f.row.result).toBeNull();
    });
    it('keeps raw instruction credentials out of final synthesis as well as prepared context', async () => {
        const f = fixture(); f.snapshot.selection.instruction = 'Проверь проект\nAPI_KEY=do-not-transmit'; await f.run();
        expect(JSON.stringify(f.calls)).not.toContain('do-not-transmit');
    });
});

describe('Delegation failures and fresh authority', () => {
    it('does not start new work when the coordinator flag was disabled after preparation', async () => {
        const f = fixture(); f.control.disabled.add('system_coordinator'); await expect(f.run()).rejects.toThrow('feature disabled');
        expect(f.calls).toEqual([]); expect(f.row.calls_started).toBe(0);
    });
    it('preserves a completed answer and stops new calls when the coordinator flag turns off', async () => {
        const f = fixture(), normal = f.infer.getMockImplementation()!;
        f.infer.mockImplementation(async (...args) => { const value = await normal(...args);
            if (currentModelUsage().agentId === 'agent-ai-admin') f.control.disabled.add('system_coordinator'); return value; });
        await f.run(); expect(f.calls.map(call => call.id)).toEqual(['agent-coordinator', 'agent-ai-admin']);
        expect(f.row.result).toMatchObject({ summary: 'Получены ответы: 1 из 2.', delegations: [{ state: 'succeeded' }, { state: 'failed' }] });
    });
    it('keeps an independent answer when another provider call fails without replay', async () => {
        const f = fixture(), normal = f.infer.getMockImplementation()!;
        f.infer.mockImplementation(async (...args) => { if (currentModelUsage().agentId === 'agent-ai-admin') throw new ConflictException('unknown provider outcome'); return normal(...args); });
        await f.run(); expect(f.infer).toHaveBeenCalledTimes(4);
        expect(f.row.result?.delegations).toMatchObject([{ state: 'failed' }, { roleId: 'agent-indexer', state: 'succeeded' }]);
    });
    it('skips a disabled child without blocking an enabled role', async () => {
        const f = fixture(); f.control.disabled.add('system_ai_admin'); await f.run();
        expect(f.calls.map(call => call.id)).toEqual(['agent-coordinator', 'agent-indexer', 'agent-coordinator']);
        expect(f.row.result?.delegations).toMatchObject([{ state: 'failed' }, { state: 'succeeded' }]);
    });
    it.each(['authority', 'context', 'cancel'] as const)('fences %s revoked during child admission and stops every later call', async condition => {
        const f = fixture(), normal = f.infer.getMockImplementation()!;
        f.infer.mockImplementation(async (...args) => {
            if (currentModelUsage().agentId === 'agent-ai-admin') {
                if (condition === 'authority') f.control.authorized = false;
                if (condition === 'context') f.control.context = false;
                if (condition === 'cancel') f.row.state = 'cancelled';
            }
            return normal(...args);
        });
        await expect(f.run()).rejects.toThrow(); expect(f.calls.map(call => call.id)).toEqual(['agent-coordinator']);
        expect(f.infer).toHaveBeenCalledTimes(2); expect(f.row.result).toBeNull();
    });
    it('validates child proposals against the child target scope instead of the coordinator superset', async () => {
        const f = fixture(), normal = f.infer.getMockImplementation()!;
        f.infer.mockImplementation(async (...args) => {
            if (currentModelUsage().agentId === 'agent-ai-admin') return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
                ...diagnosis('Invalid change'), kind: 'proposal', changes: [{ targetKey: 'prompt:prompt-one', replacement: 'injected', explanation: 'wrong scope' }] }) } };
            return normal(...args);
        });
        await f.run(); expect(f.row.result?.delegations).toMatchObject([{ state: 'failed' }, { state: 'succeeded' }]); expect(f.targets.replacement).not.toHaveBeenCalled();
    });
    it('preserves completed child answers when synthesis fails', async () => {
        const f = fixture(), normal = f.infer.getMockImplementation()!;
        f.infer.mockImplementation(async (...args) => { if (currentModelUsage().agentId === 'agent-coordinator' && f.calls.length) throw new Error('synthesis unavailable'); return normal(...args); });
        await f.run(); expect(f.row.result).toMatchObject({ summary: 'Получены ответы: 2 из 2.', delegations: [{ state: 'succeeded' }, { state: 'succeeded' }] });
    });
    it('cancels a timed-out child and continues the independent role inside the parent deadline', async () => {
        vi.useFakeTimers();
        try {
            const f = fixture(), normal = f.infer.getMockImplementation()!; let started!: () => void;
            const waiting = new Promise<void>(resolve => { started = resolve; });
            f.infer.mockImplementation(async (...args) => {
                if (currentModelUsage().agentId === 'agent-ai-admin') { await currentModelUsage().beforeInference?.(); started();
                    return new Promise((_, reject) => args[3]!.addEventListener('abort', () => reject(args[3]!.reason), { once: true })); }
                return normal(...args);
            });
            const work = f.run(); await waiting; await vi.advanceTimersByTimeAsync(20000); await work;
            expect(f.row.result?.delegations).toMatchObject([{ state: 'failed' }, { roleId: 'agent-indexer', state: 'succeeded' }]);
            expect(f.calls.map(call => call.id)).toEqual(['agent-coordinator', 'agent-indexer', 'agent-coordinator']);
        } finally { vi.useRealTimers(); }
    });
    it('rechecks actor authority between completed child steps', async () => {
        const f = fixture(), change = f.repository.change.getMockImplementation()!;
        f.repository.change.mockImplementation(async (...args) => { const value = await change(...args);
            if (args[3] === 'delegating') f.control.authorized = false; return value; });
        await expect(f.run()).rejects.toThrow('authority revoked');
        expect(f.calls.map(call => call.id)).toEqual(['agent-coordinator', 'agent-ai-admin']); expect(f.row.result).toBeNull();
    });
    it('retains independent answers when final synthesis times out before the parent lease', async () => {
        vi.useFakeTimers();
        try {
            const f = fixture(), normal = f.infer.getMockImplementation()!; let started!: () => void;
            const waiting = new Promise<void>(resolve => { started = resolve; });
            f.infer.mockImplementation(async (...args) => {
                if (currentModelUsage().agentId === 'agent-coordinator' && f.calls.length) {
                    await currentModelUsage().beforeInference?.(); started();
                    return new Promise((_, reject) => args[3]!.addEventListener('abort', () => reject(args[3]!.reason), { once: true }));
                }
                return normal(...args);
            });
            const work = f.run(); await waiting; await vi.advanceTimersByTimeAsync(20000); await work;
            expect(f.row).toMatchObject({ state: 'succeeded', result: { summary: 'Получены ответы: 2 из 2.', delegations: [{ state: 'succeeded' }, { state: 'succeeded' }] } });
        } finally { vi.useRealTimers(); }
    });
});
