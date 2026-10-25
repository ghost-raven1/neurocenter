import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { SystemRoleRunner } from '../src/system-roles/system-role.runner';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { roleDefinitionPin } from '../src/system-roles/system-role.definitions';
import type { RoleRunRow } from '../src/system-roles/system-role.types';

const result = { kind: 'diagnosis', summary: 'Измерения доступны', findings: [], nextSteps: [], changes: [] };
function fixture() {
    const row = { id: '12345678-1234-1234-1234-123456789abc', agent_id: 'agent-ai-admin', project_id: null, actor: 'admin@example.test', actor_role: 'Главный админ',
        state: 'running', phase: 'collecting', lease_token: 'nonce', calls_started: 0, facts: [], result: null,
        request: { modelId: 'model-one', expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: roleDefinitionPin('agent-ai-admin'), consentDigest: 'digest', diagnostics: ['health'] },
        snapshot: { selection: {}, preview: 'SELECTED SAFE TEXT', consentDigest: 'digest', targets: [] } } as unknown as RoleRunRow;
    const model = { id: 'model-one', runtime: 'ollama', capability: 'chat', manifestSha256: 'a'.repeat(64) };
    const signal = new AbortController(), control = { feature: true, valid: true, selected: true };
    const features = vi.fn(async () => { if (!control.feature) throw new Error('feature disabled'); });
    const policy = { current: vi.fn(async () => { if (!control.valid) throw new Error('authority or pin changed'); return model; }), models: { pool: { query: vi.fn(async () => ({ rows: [] })) } } };
    const targets = { prepare: vi.fn(async () => ({ consentDigest: control.selected ? 'digest' : 'changed' })), replacement: vi.fn() };
    const repository = { pool: {}, fenced: vi.fn(async (_id, _lease, work) => { if (row.state !== 'running') throw new ConflictException('fenced'); return work({}, row); }),
        change: vi.fn(async (_db, current, state, phase, _message, patch) => Object.assign(current, { state, phase }, patch)),
        reserveCall: vi.fn(async (_id, _lease, authorize) => { await authorize({}, row); row.calls_started++; return row; }) };
    const infer = vi.fn(async () => { await currentModelUsage().beforeInference?.(); return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }; });
    const diagnostic = vi.fn(async () => ({ id: 'fact-health', kind: 'health', status: 'measured', checkedAt: '2026-10-23T00:00:00.000Z', data: { available: true, catalog: 'ready' } }));
    const runner = new SystemRoleRunner(repository as never, policy as never, targets as never, { infer }, async () => undefined, features, diagnostic as never);
    return { row, model, signal, control, features, policy, targets, repository, infer, diagnostic, run: () => runner.run({} as never, row, signal.signal) };
}
describe('Common bounded role runner', () => {
    it('uses explicit exact model, selected safe context, attributed usage and safe durable facts', async () => {
        const f = fixture(); let context;
        f.infer.mockImplementation(async () => { context = currentModelUsage(); await context.beforeInference?.(); return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }; });
        await f.run(); expect(f.infer).toHaveBeenCalledOnce(); expect(f.row).toMatchObject({ state: 'succeeded', calls_started: 1, result });
        expect(context).toMatchObject({ purpose: 'agent', actorEmail: f.row.actor,actorRole:f.row.actor_role, agentId: 'agent-ai-admin', operationId: f.row.id, requiredFeatures: ['system_ai_admin'] });
        // The actual usage ledger stores operation_id as UUID, independently of the Operations display ID.
        expect(context.operationId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
        expect(f.infer.mock.calls[0][0]).toBe(f.model); expect(JSON.stringify(f.infer.mock.calls[0][2])).toContain('SELECTED SAFE TEXT');
    });
    it('spends at most two calls repairing only malformed model JSON', async () => {
        const f = fixture(); f.infer.mockResolvedValue({ done_reason: 'stop', message: { role: 'assistant', content: '{}' } });
        await expect(f.run()).rejects.toThrow('JSON-контракта'); expect(f.infer).toHaveBeenCalledTimes(2); expect(f.row.calls_started).toBe(2);
    });
    it('does not buy a repair for provider/infrastructure failure', async () => {
        const f = fixture(); f.infer.mockRejectedValue(new Error('provider timeout with unknown outcome'));
        await expect(f.run()).rejects.toThrow('provider timeout'); expect(f.infer).toHaveBeenCalledOnce();
    });
    it('reports incomplete length output explicitly and never buys an automatic continuation or repair', async () => {
        const f = fixture(); f.infer.mockResolvedValue({done_reason: 'length',message: {role: 'assistant',content: JSON.stringify(result)}});
        await expect(f.run()).rejects.toThrow('Ответ не завершён'); expect(f.infer).toHaveBeenCalledOnce(); expect(f.row.result).toBeNull();
    });
    it.each(['feature', 'valid', 'selected'] as const)('rechecks %s after admission wait before physical request', async key => {
        const f = fixture(); let physical = 0;
        f.infer.mockImplementation(async () => { f.control[key] = false; await currentModelUsage().beforeInference?.(); physical++; return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }; });
        await expect(f.run()).rejects.toThrow(); expect(physical).toBe(0); expect(f.infer).toHaveBeenCalledOnce();
    });
    it('retains an already paid result if only the new-work flag turns off', async () => {
        const f = fixture(); f.infer.mockImplementation(async () => { await currentModelUsage().beforeInference?.(); f.control.feature = false; return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }; });
        await f.run(); expect(f.row.state).toBe('succeeded'); expect(f.row.result).toEqual(result);
    });
    it('fences cancellation and a late provider response without retry', async () => {
        const f = fixture(); f.infer.mockImplementation(async () => { f.row.state = 'cancelled'; return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }; });
        await expect(f.run()).rejects.toThrow('fenced'); expect(f.row.result).toBeNull(); expect(f.infer).toHaveBeenCalledOnce();
    });
    it('does not enter a model call after an abort', async () => {
        const f = fixture(); f.signal.abort(new Error('cancelled'));
        await expect(f.run()).rejects.toThrow('cancelled'); expect(f.infer).not.toHaveBeenCalled();
    });
});
