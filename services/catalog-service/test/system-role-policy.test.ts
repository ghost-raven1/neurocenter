import { describe, expect, it, vi } from 'vitest';
import { SystemRolePolicy } from '../src/system-roles/system-role.policy';
import { roleHash } from '../src/system-roles/system-role.definitions';
import { modelFromRow } from '../src/models/model-history';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { startRoleRun } from '../src/system-roles/system-role.validation';
const project = 'prj-one', id = '12345678-1234-1234-1234-123456789abc';
function fixture() {
    const actor = { email: 'admin@example.test', activeRole: 'Админ проекта', claims: { email: 'admin@example.test', userRoles: ['Админ проекта'], projects: [{ projectId: project, role: 'Админ проекта' }] } };
    const row = { id: 'model-one', name: 'One', descriptor: { runtime: 'remote-openai', model: 'exact/model', capability: 'chat', verificationSha256: 'a'.repeat(64), source: 'custom', dimension: null, manifestSha256: null }, revision: 1, created_at: new Date(), updated_at: new Date(), archived_at: null };
    const models = { actor: vi.fn(async () => actor), resolveProject: vi.fn(async (_req, selected, minimum) => { if (minimum > 3) throw Error('forbidden'); return { id: selected }; }) };
    let assigned = true;
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM project_models')) return { rows: assigned ? [{ model_id: row.id }] : [], rowCount: assigned ? 1 : 0 };
        if (sql.includes('FROM model_catalog')) return { rows: [row] };
        return { rows: [], rowCount: 0 };
    });
    const policy = new SystemRolePolicy(models as never);
    return { actor, row, models, query, policy, revoke: () => { assigned = false; } };
}
describe('System role authority, identity and dialog source fences', () => {
    it('keeps service-chat runs private even from another administrator of the same project', async () => {
        const f = fixture(), row = { actor: 'other@example.test', project_id: project, request: { source: { kind: 'system-role-chat' } } };
        await expect(f.policy.read({ headers: {} } as never, row as never)).rejects.toHaveProperty('status', 404);
        row.actor = f.actor.email; expect((await f.policy.read({ headers: {} } as never, row as never)).email).toBe(f.actor.email);
        row.actor = 'other@example.test'; row.request = {} as never;
        await expect(f.policy.read({ headers: {} } as never, row as never)).resolves.toMatchObject({ email: f.actor.email });
    });
    it('project admins require current assignment and exact verified model pin; main may choose global catalog', async () => {
        const f = fixture(), pin = projectEmbeddingPin(modelFromRow(f.row as never));
        expect((await f.policy.modelInTransaction({ query: f.query } as never, f.actor as never, project, f.row.id, pin)).id).toBe(f.row.id);
        f.revoke(); await expect(f.policy.modelInTransaction({ query: f.query } as never, f.actor as never, project, f.row.id, pin)).rejects.toThrow('назначена');
        f.actor.activeRole = 'Главный админ'; await f.policy.modelInTransaction({ query: f.query } as never, f.actor as never, project, f.row.id, pin);
        f.row.descriptor.model = 'changed/model'; await expect(f.policy.modelInTransaction({ query: f.query } as never, f.actor as never, project, f.row.id, pin)).rejects.toThrow('pin');
    });
    it('checks source actor/dialog/project/request/hash plus cancellation under shared row locks', async () => {
        const f = fixture(), query = vi.fn(async () => ({ rowCount: 1, rows: [] })), input = { projectId: project, requestId: id, sourceFeature: 'system_role_chat', source: { kind: 'system-role-chat', dialogId: id, turnId: id } } as const;
        await f.policy.source({ query } as never, f.actor.email, 'agent-ai-admin', input as never, 'f'.repeat(64));
        expect(query.mock.calls[0][0]).toContain('NOT i.cancel_requested FOR SHARE OF i,d');
        expect(query.mock.calls[0][1]).toEqual([id, id, f.actor.email, id, 'agent-ai-admin', 'f'.repeat(64), project]);
        query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); await expect(f.policy.source({ query } as never, f.actor.email, 'agent-ai-admin', input as never, 'f'.repeat(64))).rejects.toThrow('отменено');
    });
    it('requires paired typed dialog source/feature and pins it in canonical request identity', () => {
        const input = { projectId: project, instruction: 'Advice', diagnostics: [], targets: [], requestId: id, modelId: 'model-one', expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: 'b'.repeat(64), consentDigest: 'c'.repeat(64),
            sourceFeature: 'system_role_chat', source: { kind: 'system-role-chat', dialogId: id, turnId: id } };
        const parsed = startRoleRun('agent-ai-admin', input); expect(parsed.source).toEqual(input.source);
        expect(roleHash({ id: 'agent-ai-admin', input: parsed })).not.toBe(roleHash({ id: 'agent-ai-admin', input: { ...parsed, source: { ...parsed.source, turnId: 'other' } } }));
        expect(() => startRoleRun('agent-ai-admin', { ...input, source: undefined })).toThrow();
        expect(() => startRoleRun('agent-ai-admin', { ...input, sourceFeature: undefined })).toThrow();
        expect(() => startRoleRun('agent-ai-admin', { ...input, source: { ...input.source, command: 'docker exec' } })).toThrow();
    });
    it('device headers cannot turn a bridge job into a human system-role execution', async () => {
        const f = fixture(); await expect(f.policy.actor({ headers: { 'x-neurocenter-device-id': 'device' } } as never, project)).rejects.toThrow('пользователь'); expect(f.models.actor).not.toHaveBeenCalled();
    });
});
