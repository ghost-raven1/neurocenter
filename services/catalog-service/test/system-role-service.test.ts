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

/** The public service owns admission, scheduling, failure persistence and the later historical read. */
function executionFixture() {
    const f = fixture(), definitionPin = roleDefinitionPin('agent-coordinator');
    f.input.expectedDefinitionPin = definitionPin; f.row.agent_id = 'agent-coordinator'; f.row.request = f.input;
    f.row.state = 'running'; f.row.lease_token = 'lease'; f.row.lease_until = new Date(Date.now() + 120000);
    f.row.snapshot.definitionPin = definitionPin; f.prepare.mockResolvedValue(f.row.snapshot);
    Object.assign(f.service.policy.models.pool, { query: vi.fn(async () => ({ rows: [] })) });
    vi.spyOn(f.service.policy, 'current').mockResolvedValue(f.row.model);
    vi.mocked(f.service.repository.claim).mockResolvedValueOnce(f.row);
    vi.spyOn(f.service.repository, 'fenced').mockImplementation(async (_id, _lease, work) => work({} as never, f.row));
    vi.spyOn(f.service.repository, 'reserveCall').mockImplementation(async (_id, _lease, authorize) => { await authorize({} as never, f.row); f.row.calls_started++; return f.row; });
    vi.spyOn(f.service.repository, 'transaction').mockImplementation(async work => work({} as never));
    vi.spyOn(f.service.repository, 'get').mockImplementation(async () => f.row);
    vi.spyOn(f.service.repository, 'change').mockImplementation(async (_db, _row, state, phase, message, patch) => Object.assign(f.row, { state, phase, message, revision: f.row.revision + 1 }, patch));
    return f;
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

describe('Durable failures expose a safe next action', () => {
    it('persists an actionable planning timeout without replay and preserves its historical receipt', async () => {
        vi.useFakeTimers(); const f = executionFixture(); features.mockResolvedValue(undefined);
        try {
            let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
            f.infer.mockImplementation(async (_model, _endpoint, _body, signal: AbortSignal) => { started();
                return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
            await f.service.start({ headers: {} } as never, 'agent-coordinator', f.input); await waiting; await vi.advanceTimersByTimeAsync(40000);
            const receipt = await f.service.detail({ headers: {} } as never, 'agent-coordinator', f.row.id);
            expect(receipt).toMatchObject({ state: 'failed', callsStarted: 1 });
            expect(receipt.message).toContain('Координатор не дождался плана');
            expect(receipt.message).toContain('Проверьте подключение компьютера и доступность модели');
            expect(receipt.message).toContain('явно запустите задачу снова'); expect(f.infer).toHaveBeenCalledOnce();
        } finally { await f.service.onApplicationShutdown(); vi.useRealTimers(); }
    });
    it('keeps unknown provider failures generic and never persists their raw private message', async () => {
        const f = executionFixture(); features.mockResolvedValue(undefined);
        try {
            f.infer.mockRejectedValue(new Error('private provider detail do-not-persist'));
            await f.service.start({ headers: {} } as never, 'agent-coordinator', f.input);
            await vi.waitFor(async () => expect(await f.service.detail({ headers: {} } as never, 'agent-coordinator', f.row.id)).toMatchObject({ state: 'failed', callsStarted: 1 }));
            const receipt = await f.service.detail({ headers: {} } as never, 'agent-coordinator', f.row.id);
            expect(receipt.message).toContain('Причина сбоя не определена');
            expect(receipt.message).toContain('Зарезервировано шагов модели: 1');
            expect(receipt.message).toContain('Автоматического повтора нет');
            expect(receipt.message).not.toContain('private provider detail'); expect(receipt.result).toBeNull(); expect(f.infer).toHaveBeenCalledOnce();
        } finally { await f.service.onApplicationShutdown(); }
    });
});
