import { describe, expect, it, vi } from 'vitest';
import { SystemRoleTargets } from '../src/system-roles/system-role.targets';
import { roleHash } from '../src/system-roles/system-role.definitions';
import { readRolePackageSource } from '../src/system-roles/system-role.package-source';
const project = 'prj-one', req = {} as never, selection = { projectId: project, instruction: 'Improve', diagnostics: [], targets: [{ kind: 'agent', id: 'agent-one' }] } as const;
function agentFixture() {
    let revision = 3;
    const card = { id: 'agent-one', name: 'Agent', version: 1, definition: { prompt: 'Original', mode: 'primary' } }, assignment = { agentId: card.id, card, effective: { ...card.definition, prompt: 'Before' }, overrides: { prompt: 'Before', steps: 7, model: 'fixed/model' }, removed: false };
    const list = vi.fn(async () => ({ items: [card], assignments: [assignment], revision }));
    const save = vi.fn(async (_req, _project, _id, patch) => { expect(patch.expectedRevision).toBe(revision); assignment.overrides = { ...patch.overrides }; assignment.effective.prompt = patch.overrides.prompt; revision++; return { revision }; });
    const actor = { email: 'admin@example.test', activeRole: 'Админ проекта' }, policy = { actor: vi.fn(async () => actor), models: {} };
    const targets = new SystemRoleTargets(policy as never, { list, configure: save, projects: { update: save } } as never, {} as never, {} as never);
    return { targets, assignment, save, snapshot: () => targets.read(req, selection as never, selection.targets[0]) };
}
describe('System role target owners and immutable source evidence', () => {
    it('uses the same exact consent digest for preview and start without self-including request/source/model envelope', async () => {
        const f = agentFixture(), first = await f.targets.prepare(req, 'agent-autoconfigurator', selection as never);
        const start = { ...selection, modelId: 'model-one', requestId: 'new-request', consentDigest: first.consentDigest, expectedModelPin: 'a'.repeat(64), sourceFeature: 'system_role_chat' };
        const repeated = await f.targets.prepare(req, 'agent-autoconfigurator', start as never);
        expect(repeated.consentDigest).toBe(first.consentDigest); expect(repeated.selection).toEqual(selection); expect(repeated.preview).toBe(first.preview);
    });
    it('changes only selected agent prompt and preserves model/options, then rolls back exact owner receipt', async () => {
        const f = agentFixture(), target = await f.snapshot(), prepared = { selection, targets: [target] } as never;
        const receipt = await f.targets.write(req, prepared, target, 'Improved', 'key');
        expect(f.save).toHaveBeenCalledOnce(); expect(f.save.mock.calls[0][3].overrides).toEqual({ prompt: 'Improved', steps: 7, model: 'fixed/model' });
        expect(receipt.version).toBe(4);
        const rolledBack = await f.targets.write(req, prepared, target, 'ignored', 'rollback-key', receipt);
        expect(rolledBack.version).toBe(5); expect(f.assignment.overrides).toEqual({ prompt: 'Before', steps: 7, model: 'fixed/model' });
    });
    it('rejects changed current source or an unconfirmed concurrent owner version', async () => {
        const f = agentFixture(), target = await f.snapshot(); f.assignment.overrides.steps = 9;
        await expect(f.targets.write(req, { selection, targets: [target] } as never, target, 'New', 'key')).rejects.toThrow('версия'); expect(f.save).not.toHaveBeenCalled();
        const g = agentFixture(), original = await g.snapshot(); g.save.mockImplementation(async () => ({ revision: 99 }));
        await expect(g.targets.write(req, { selection, targets: [original] } as never, original, 'New', 'key')).rejects.toThrow('версия');
    });
    it('reads selected public messages through the actual room owner and rejects private-room context', async () => {
        const id = '12345678-1234-1234-1234-123456789abc', page = vi.fn(async () => ({ messages: [{ id: 'message', position: 1, kind: 'user', content: 'Public selected text', status: 'done', author_email: 'private-name@example.test' }] }));
        let visibility = 'PUBLIC';
        const scoped = vi.fn(async (_project, _actor, _level, _write, work) => work({}, { revision: 8, visibility }));
        const chats = { policy: { input: () => ({ email: 'user@example.test' }) }, repository: { scoped, page } };
        const targets = new SystemRoleTargets({ actor: async () => ({ activeRole: 'Главный админ' }) } as never, {} as never, {} as never, {} as never, vi.fn(), chats as never);
        const target = await targets.read(req, { projectId: project } as never, { kind: 'public-chat', id });
        expect(target.editable).toBe(false); expect(target.modelContent).toContain('Public selected text'); expect(target.modelContent).not.toContain('private-name');
        expect(scoped.mock.calls[0].slice(0, 4)).toEqual([project, { email: 'user@example.test' }, 1, false]);
        visibility = 'PRIVATE'; await expect(targets.read(req, { projectId: project } as never, { kind: 'public-chat', id })).rejects.toThrow('публичный');
    });
    it('package inspection is pinned readonly metadata, not evidence of successful runtime or permission to another dialog', async () => {
        const descriptor = { type: 'npm', name: 'Fixture', package: '@fixture/server', version: '1.2.3', entrypoint: 'dist/main.js', candidates: ['dist/main.js'], supportedTargets: ['darwin-arm64'] }, pin = roleHash(descriptor);
        const query = vi.fn(async () => ({ rows: [{ dialog_id: 'dialog-one', descriptor, pin }] }));
        expect(await readRolePackageSource({ query } as never, '12345678-1234-1234-1234-123456789abc', 'owner@example.test', project, 'dialog-one')).toMatchObject({ descriptor, pin });
        expect(query.mock.calls[0][0]).toContain('s.expires_at>now()'); expect(query.mock.calls[0][1]).toEqual(['12345678-1234-1234-1234-123456789abc', 'owner@example.test', project]);
        await expect(readRolePackageSource({ query } as never, '12345678-1234-1234-1234-123456789abc', 'owner@example.test', project, 'other-dialog')).rejects.toThrow('диалогу');
        query.mockResolvedValueOnce({ rows: [{ dialog_id: 'dialog-one', descriptor: { ...descriptor, headers: 'secret' }, pin }] });
        await expect(readRolePackageSource({ query } as never, '12345678-1234-1234-1234-123456789abc', 'owner@example.test', project)).rejects.toThrow('источника');
    });
});
