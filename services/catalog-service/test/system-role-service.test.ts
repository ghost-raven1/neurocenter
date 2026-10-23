import { describe, expect, it, vi } from 'vitest';
import { roleDefinitionPin, roleHash } from '../src/system-roles/system-role.definitions';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { SystemRoleService } from '../src/system-roles/system-role.service';
import type { IModel } from '../src/models/model.types';
import type { RoleRunRow } from '../src/system-roles/system-role.types';
const { features } = vi.hoisted(() => ({ features: vi.fn(async () => undefined) }));
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: features }));
vi.mock('../src/system-roles/system-role.operations', () => ({ projectRoleOperation: vi.fn(), notifyRoleOperations: vi.fn(async () => undefined) }));
function fixture() {
    const actor = { email: 'admin@example.test', activeRole: 'Главный админ', claims: { userRoles: ['Главный админ'], projects: [] } };
    const model = { id: 'model-one', name: 'Model', runtime: 'ollama', capability: 'chat', manifestSha256: 'a'.repeat(64), model: 'fixed:model', revision: 1, source: 'custom', description: '', dimension: null, createdAt: '2026-10-23', updatedAt: '2026-10-23' } as IModel;
    const models = { pool: {}, actor: vi.fn(async () => actor), ready: vi.fn(async () => undefined), getUsable: vi.fn(async () => model) }, infer = vi.fn();
    const service = new SystemRoleService(models as never, {} as never, {} as never, {} as never, { infer } as never, {} as never);
    vi.spyOn(service.policy, 'authorize').mockResolvedValue(undefined); vi.spyOn(service.policy, 'modelInTransaction').mockResolvedValue(model);
    vi.spyOn(service.repository, 'claim').mockResolvedValue(null);
    const selection = { projectId: null, instruction: 'Give advice', diagnostics: [], targets: [] }, definitionPin = roleDefinitionPin('agent-ai-admin');
    const prepare = vi.spyOn(service.targets, 'prepare').mockResolvedValue({ selection, definitionPin, consentDigest: 'b'.repeat(64), preview: 'SAFE', targets: [] });
    const input = { ...selection, requestId: '12345678-1234-1234-1234-123456789abc', modelId: model.id, expectedModelPin: projectEmbeddingPin(model), expectedDefinitionPin: definitionPin, consentDigest: 'b'.repeat(64) };
    const row = { id: input.requestId, agent_id: 'agent-ai-admin', project_id: null, actor: actor.email, actor_role: actor.activeRole, request_id: input.requestId,
        request_hash: roleHash({ id: 'agent-ai-admin', input }), request: input, snapshot: { selection, definitionPin, consentDigest: input.consentDigest, preview: 'SAFE', targets: [] }, model,
        state: 'queued', phase: 'queued', revision: 0, calls_started: 0, facts: [], result: null, steps: [], applied: [], message: 'Queued', created_at: new Date(), finished_at: null } as unknown as RoleRunRow;
    const existing = vi.spyOn(service.repository, 'existing').mockResolvedValue(null);
    const create = vi.spyOn(service.repository, 'create').mockImplementation(async (_input, authorize) => { await authorize({} as never); return row; });
    return { service, actor, infer, prepare, input, row, existing, create };
}
describe('Explicit role service admission and free historical reads', () => {
    it('prepare is free and explicit start revalidates consent/model before one durable intent', async () => {
        features.mockResolvedValue(undefined); const f = fixture();
        expect(await f.service.prepare({ headers: {} } as never, 'agent-ai-admin', { projectId: null, instruction: 'Give advice', diagnostics: [], targets: [] })).toMatchObject({ preview: 'SAFE' });
        expect(f.infer).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
        expect(await f.service.start({ headers: {} } as never, 'agent-ai-admin', f.input)).toMatchObject({ id: f.row.id, state: 'queued' });
        expect(f.create).toHaveBeenCalledOnce(); expect(f.service.policy.modelInTransaction).toHaveBeenCalledWith(expect.anything(), f.actor, null, f.input.modelId, f.input.expectedModelPin);
    });
    it('same accepted intent is readable/repeatable after feature OFF and changed payload cannot reuse its key', async () => {
        features.mockResolvedValue(undefined); const f = fixture(); f.existing.mockResolvedValue(f.row); features.mockRejectedValue(new Error('feature off'));
        expect(await f.service.start({ headers: {} } as never, 'agent-ai-admin', f.input)).toMatchObject({ id: f.row.id });
        expect(await f.service.request({ headers: {} } as never, 'agent-ai-admin', f.input.requestId, f.row.request_hash)).toMatchObject({ id: f.row.id });
        await expect(f.service.request({ headers: {} } as never, 'agent-ai-admin', f.input.requestId, 'f'.repeat(64))).rejects.toThrow('другому');
        await expect(f.service.start({ headers: {} } as never, 'agent-ai-admin', { ...f.input, instruction: 'different' })).rejects.toThrow('другому');
        expect(f.create).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.infer).not.toHaveBeenCalled();
    });
    it('a changed source/definition consent fails before durable job admission or inference', async () => {
        features.mockResolvedValue(undefined); const f = fixture();
        await expect(f.service.start({ headers: {} } as never, 'agent-ai-admin', { ...f.input, consentDigest: 'c'.repeat(64) })).rejects.toThrow('Контекст изменился');
        expect(f.create).not.toHaveBeenCalled(); expect(f.infer).not.toHaveBeenCalled();
    });
});
