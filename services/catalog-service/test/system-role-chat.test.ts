import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemRoleChatService } from '../src/system-role-chat/system-role-chat.service';
import { allowSystemRoleChatRoute } from '../src/system-role-chat/system-role-chat.access';
import { roleHash } from '../src/system-roles/system-role.definitions';
import { sendSystemTurn } from '../src/system-role-chat/system-role-chat.validation';
import type { SystemDialogRow, SystemTurnRow } from '../src/system-role-chat/system-role-chat.types';
import type { RoleRunView } from '../src/system-roles/system-role.types';

const { features } = vi.hoisted(() => ({ features: vi.fn(async () => undefined) }));
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: features }));
const request = (email = 'owner@test', project = 'prj-chat', level = 3) => ({ email, project, level }) as never;
const dialogId = randomUUID();
const selection = { projectId: 'prj-chat', instruction: 'Проверь проект', diagnostics: [], targets: [] };
const input = () => ({ ...selection, requestId: randomUUID(), modelId: 'model-chat', expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: 'b'.repeat(64), consentDigest: 'c'.repeat(64) });

/** Boundary fixture supplies stored receipts and the existing role owner; it never simulates model execution. */
function fixture() {
    const dialogs = new Map<string, SystemDialogRow>(), turns = new Map<string, SystemTurnRow>(), runs = new Map<string, RoleRunView>();
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const actor = vi.fn(async (req: { email: string }) => ({ email: req.email, activeRole: 'Админ проекта' }));
    const policyActor = vi.fn(async (req: { email: string; project: string; level: number }, project: string, minimum = 3) => {
        if (req.project !== project || req.level < minimum) throw new ForbiddenException();
        return actor(req);
    });
    const roles = {
        policy: { actor: policyActor, authorize: vi.fn(async () => undefined) },
        repository: { transaction: async work => work({ query }) },
        prepare: vi.fn(async () => ({ preview: 'Only selected data', consentDigest: 'c'.repeat(64), definitionPin: 'b'.repeat(64), targets: [] })),
        detail: vi.fn(async (_req, _role, id) => { const run = runs.get(id); if (!run) throw new NotFoundException(); return run; }),
        start: vi.fn(async (req, agentId, accepted, receipt) => {
            await features(['system_role_chat']);
            await receipt.before({ query });
            const id = randomUUID(), run = { id, agentId, state: 'queued', phase: 'queued', revision: 0, canCancel: true, result: null, createdAt: new Date(turns.get(accepted.requestId)!.created_at).toISOString() } as RoleRunView;
            runs.set(id, run);
            await receipt.accepted({ query }, { id, actor: req.email, request: accepted, request_hash: roleHash({ id: agentId, input: accepted }) });
            return run;
        }),
        cancel: vi.fn(async (_req, _role, id, action) => {
            const run = runs.get(id)!; if (run.revision !== action.expectedRevision) throw new Error('revision changed');
            Object.assign(run, { state: 'cancelled', revision: run.revision + 1, canCancel: false }); return run;
        }),
    };
    const service = new SystemRoleChatService({ pool: { query }, ready: async () => undefined, actor } as never, roles as never);
    const dialog: SystemDialogRow = { id: dialogId, owner_email: 'owner@test', project_id: selection.projectId, title: 'Сервисный диалог', created_at: new Date(), updated_at: new Date() };
    dialogs.set(dialog.id, dialog);
    vi.spyOn(service.repository, 'dialog').mockImplementation(async (id, owner) => { const item = dialogs.get(id); if (!item || item.owner_email !== owner) throw new NotFoundException(); return item; });
    vi.spyOn(service.repository, 'dialogs').mockImplementation(async (owner, project) => [...dialogs.values()].filter(item => item.owner_email === owner && item.project_id === project));
    vi.spyOn(service.repository, 'turns').mockImplementation(async (id, owner) => [...turns.values()].filter(item => item.dialog_id === id && item.owner_email === owner));
    vi.spyOn(service.repository, 'turn').mockImplementation(async (id, owner, key) => [...turns.values()].find(item => item.dialog_id === id && item.owner_email === owner && item.request_id === key));
    vi.spyOn(service.repository, 'accept').mockImplementation(async (_db, d, agent, accepted, hash) => {
        turns.set(accepted.requestId, { id: accepted.requestId, dialog_id: d.id, owner_email: d.owner_email, request_id: accepted.requestId, agent_id: agent, request_hash: hash,
            input: accepted, run_id: '', cancel_requested: false, created_at: new Date() });
    });
    vi.spyOn(service.repository, 'attach').mockImplementation(async (_db, run) => { turns.get(run.request.source!.turnId)!.run_id = run.id; });
    return { service, roles, turns, runs, query, dialog };
}

describe('System role chat: private receipts over the existing role owner', () => {
    beforeEach(() => { features.mockResolvedValue(undefined); });
    it('previews without execution, accepts one turn and reopens its queued then completed result', async () => {
        const f = fixture(), body = { agentId: 'agent-coordinator', input: input() };
        const preview = await f.service.prepare(request(), dialogId, { agentId: body.agentId, selection, includeContext: false });
        expect(preview).toMatchObject({ selection, prepared: { preview: 'Only selected data' } }); expect(f.roles.start).not.toHaveBeenCalled();
        const receipt = await f.service.send(request(), dialogId, body);
        expect(receipt).toMatchObject({ id: body.input.requestId, instruction: selection.instruction, run: { state: 'queued' } });
        expect((await f.service.detail(request(), dialogId)).turns[0]).toEqual(receipt);
        Object.assign(f.runs.get(receipt.run.id)!, { state: 'succeeded', result: { summary: 'Измерено', delegations: [{ roleId: 'agent-indexer', state: 'failed', message: 'Unavailable' }] } });
        expect((await f.service.detail(request(), dialogId)).turns[0].run.result).toMatchObject({ summary: 'Измерено', delegations: [{ state: 'failed' }] });
        expect(f.roles.start).toHaveBeenCalledOnce();
    });
    it('unknown POST ACK recovers by readonly key and exact replay, including with feature OFF', async () => {
        const f = fixture(), body = { agentId: 'agent-coordinator', input: input() };
        const accepted = await f.service.send(request(), dialogId, body); // Response can be lost after this commit.
        features.mockRejectedValue(new ForbiddenException('disabled'));
        await expect(f.service.request(request(), dialogId, body.input.requestId)).resolves.toEqual(accepted);
        await expect(f.service.send(request(), dialogId, body)).resolves.toEqual(accepted);
        expect(f.roles.start).toHaveBeenCalledOnce();
        await expect(f.service.send(request(), dialogId, { ...body, input: { ...body.input, instruction: 'Different' } })).rejects.toThrow('другому');
        await expect(f.service.send(request(), dialogId, { ...body, input: input() })).rejects.toThrow('disabled');
    });
    it('keeps reading and explicit cancellation available after demotion and feature OFF', async () => {
        const f = fixture(), body = { agentId: 'agent-coordinator', input: input() }, accepted = await f.service.send(request(), dialogId, body);
        features.mockRejectedValue(new ForbiddenException('disabled'));
        expect((await f.service.list(request('owner@test', selection.projectId, 1), selection.projectId)).map(item => item.id)).toEqual([dialogId]);
        expect((await f.service.cancel(request('owner@test', selection.projectId, 1), dialogId, accepted.id, { requestId: randomUUID(), expectedRevision: 0 })).run.state).toBe('cancelled');
        await expect(f.service.prepare(request('owner@test', selection.projectId, 1), dialogId, { agentId: body.agentId, selection })).rejects.toHaveProperty('status', 403);
        expect(f.roles.start).toHaveBeenCalledOnce();
    });
    it('hides another owner and blocks project switches/revoked rights before new work', async () => {
        const f = fixture(), body = { agentId: 'agent-coordinator', input: input() };
        await expect(f.service.detail(request('other@test'), dialogId)).rejects.toHaveProperty('status', 404);
        expect(await f.service.list(request('other@test'), selection.projectId)).toEqual([]);
        await expect(f.service.send(request('owner@test', 'prj-other'), dialogId, body)).rejects.toHaveProperty('status', 403);
        await expect(f.service.send(request('owner@test', selection.projectId, 1), dialogId, body)).rejects.toHaveProperty('status', 403);
        await expect(f.service.send(request(), dialogId, { ...body, input: { ...body.input, projectId: 'prj-other' } })).rejects.toThrow('другому проекту');
        expect(f.roles.start).not.toHaveBeenCalled();
    });
    it('rejects forged source and automatic prior-chat context before the role owner', async () => {
        const f = fixture();
        expect(() => sendSystemTurn(dialogId, { agentId: 'agent-coordinator', input: { ...input(), source: { dialogId } } })).toThrow();
        await expect(f.service.prepare(request(), dialogId, { agentId: 'agent-coordinator', selection: { ...selection, targets: [{ kind: 'dialog-context', id: randomUUID() }] } })).rejects.toThrow('подтверждением');
        expect(f.roles.prepare).not.toHaveBeenCalled(); expect(f.roles.start).not.toHaveBeenCalled();
    });
    it('readonly status for an unknown key cannot create a turn or role run', async () => {
        const f = fixture(); await expect(f.service.request(request(), dialogId, randomUUID())).rejects.toHaveProperty('status', 404);
        expect(f.roles.start).not.toHaveBeenCalled(); expect(f.turns.size).toBe(0);
    });
    it('admits only known methods and leaves owner/ACL checks to the executor', () => {
        expect(allowSystemRoleChatRoute('Админ проекта', 'POST', '/api/system-role-chats/' + dialogId + '/turns')).toBe(true);
        expect(allowSystemRoleChatRoute('Наблюдатель', 'POST', '/api/system-role-chats/' + dialogId + '/turns')).toBe(false);
        expect(allowSystemRoleChatRoute('Наблюдатель', 'POST', '/api/system-role-chats/' + dialogId + '/turns/' + randomUUID() + '/cancel')).toBe(true);
        expect(allowSystemRoleChatRoute('Админ проекта', 'POST', '/api/system-role-chats/' + dialogId + '/unknown')).toBe(false);
        expect(allowSystemRoleChatRoute('Админ проекта', 'GET', '/api/projects')).toBeUndefined();
    });
});
