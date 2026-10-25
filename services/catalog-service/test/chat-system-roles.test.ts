import {ForbiddenException} from '@nestjs/common';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ChatSystemRolesService} from '../src/chat-system-roles/chat-system-roles.service';
import {chatSystemRoleOrigin} from '../src/chat-system-roles/chat-system-roles.validation';
import {assertChatSystemRoleOrigin, assertChatSystemRoleSource} from '../src/chat-system-roles/chat-system-roles.origin-policy';
import {SystemRoleChatService} from '../src/system-role-chat/system-role-chat.service';
import {SystemRoleApplication} from '../src/system-roles/system-role.apply';
import {roleDefinitionPin} from '../src/system-roles/system-role.definitions';
import {allowRequest} from '../src/access/access-policy';
const {features} = vi.hoisted(() => ({features: vi.fn(async () => undefined)}));
vi.mock('../src/features/require-feature-enabled', () => ({requireFeaturesEnabled: features}));
const owner = 'owner@origin.test', project = 'prj-origin', originId = '11111111-1111-4111-8111-111111111111', dialogId = '22222222-2222-4222-8222-222222222222';
const origin = {kind: 'model-chat' as const, originId, projectId: project};
const request = (level = 3, email = owner) => ({email, level, headers: {}}) as never;
function fixture() {
    const state = {bound: false, mode: 'model', source: true, canonical: project as string | null, private: false, invited: false};
    const dialog = {id: dialogId, owner_email: owner, project_id: project, title: 'Задачи системным агентам', created_at: new Date(), updated_at: new Date()};
    const binding = {dialog_id: dialogId, owner_email: owner, origin_kind: 'model-chat', origin_id: originId, project_id: project};
    const query = vi.fn(async (sql: string, args: unknown[] = []) => {
        let rows: unknown[] = [];
        if (sql.includes('FROM chat_system_role_origins o')) rows = state.bound && args[0] === owner ? [dialog] : [];
        else if (sql.includes('FROM chat_system_role_origins WHERE')) rows = state.bound ? [binding] : [];
        else if (sql.includes('FROM model_chat_conversations')) rows = state.source && args[1] === owner ? [{project_id: state.canonical, mode: state.mode}] : [];
        else if (sql.includes('FROM project_chat_rooms')) rows = state.source ? [{project_id: project, id: originId, visibility: state.private ? 'PRIVATE' : 'PUBLIC', creator_email: 'another@origin.test'}] : [];
        else if (sql.includes('FROM project_chat_room_members')) rows = state.invited ? [{email: owner}] : [];
        else if (sql.includes('FROM system_role_dialogs')) rows = args[1] === owner ? [dialog] : [];
        else if (sql.includes('INSERT INTO system_role_dialogs')) rows = [{...dialog, id: args[0]}];
        else if (sql.includes('INSERT INTO chat_system_role_origins')) state.bound = true;
        return {rows, rowCount: rows.length};
    });
    const actor = async (req: {email: string}) => ({email: req.email, activeRole: 'Админ проекта'});
    const roles = {policy: {actor: vi.fn(async (req: {email: string; level: number}, _project: unknown, minimum = 3) => {
        if (req.level < minimum) throw new ForbiddenException('Current role does not allow new work'); return actor(req);
    }), authorize: vi.fn(async () => undefined)}, repository: {transaction: async work => work({query})}, prepare: vi.fn()};
    const models = {ready: async () => undefined, actor, pool: {query}};
    return {state, dialog, binding, query, roles, models, db: {query} as never, service: new ChatSystemRolesService(models as never, roles as never)};
}
beforeEach(() => {features.mockReset(); features.mockResolvedValue(undefined);});

describe('Private system tasks bind saved chat metadata', () => {
    it('rejects arbitrary metadata, mixed scope and unsaved identifiers before storage', () => {
        expect(chatSystemRoleOrigin(origin)).toEqual(origin);
        for (const bad of [null, {...origin, originId: 'draft'}, {...origin, content: 'must not be copied'}, {...origin, kind: 'system-chat'}, {...origin, kind: 'project-chat', projectId: null}]) expect(() => chatSystemRoleOrigin(bad)).toThrow();
    });
    it('accepts the same manual and legacy canonical project IDs as existing system dialogs', () => {
        for (const projectId of ['Manual.Project_7', 'legacy-project', 'M' + 'x'.repeat(127)]) expect(chatSystemRoleOrigin({...origin, projectId}).projectId).toBe(projectId);
        expect(() => chatSystemRoleOrigin({...origin, projectId: 'x'.repeat(129)})).toThrow();
    });
    it('accepts an authorized empty project’s virtual default room without creating a shared row', async () => {
        const f = fixture(); f.state.source = false;
        await expect(assertChatSystemRoleSource(f.db, owner, {...origin, kind: 'project-chat', originId: '00000000-0000-0000-0000-000000000000'})).resolves.toBeUndefined();
        expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
    });
    it('routes read/replay for a demoted reader while the executor gates new binding at admin level', async () => {
        const claims = {email: owner, userRoles: ['Наблюдатель'], projects: [], pluginIds: [], skillPaths: []};
        expect(allowRequest(claims, 'Наблюдатель', {method: 'POST', path: '/api/chat-system-roles/origin'})).toBe(true);
        const f = fixture(); await expect(f.service.bind(request(1), origin)).rejects.toThrow('Current role');
        expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
    });
    it('reads and replays only the caller’s binding after origin loss and feature OFF', async () => {
        const f = fixture(); f.state.bound = true; f.state.source = false; features.mockRejectedValue(new ForbiddenException('OFF'));
        expect(await f.service.read(request(1), origin)).toMatchObject({id: dialogId});
        expect(await f.service.bind(request(1), origin)).toMatchObject({id: dialogId}); expect(features).not.toHaveBeenCalled();
        expect(await f.service.read(request(1, 'other@origin.test'), origin)).toBeNull();
        expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
    });
    it('rejects a mismatched original project before creating any private dialog', async () => {
        const f = fixture(); f.state.canonical = 'prj-other'; await expect(f.service.bind(request(), origin)).rejects.toThrow('другому проекту');
        expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
    });
    it('feature OFF rejects a new binding before any INSERT without touching ordinary chats', async () => {
        const f = fixture(); features.mockRejectedValue(new ForbiddenException('OFF')); await expect(f.service.bind(request(), origin)).rejects.toThrow('OFF');
        expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
    });
    it('checks the original private owner and the existing single/group chat feature separately', async () => {
        const f = fixture(); await expect(assertChatSystemRoleSource(f.db, 'other@origin.test', origin)).rejects.toThrow('недоступен');
        await assertChatSystemRoleSource(f.db, owner, origin); expect(features).toHaveBeenLastCalledWith(['chat_system_roles', 'system_role_chat', 'model_chat']);
        f.state.mode = 'group'; await assertChatSystemRoleSource(f.db, owner, origin); expect(features).toHaveBeenLastCalledWith(['chat_system_roles', 'system_role_chat', 'group_chat']);
    });
    it('does not give a project administrator implicit membership in a PRIVATE source room', async () => {
        const f = fixture(); f.state.private = true; const room = {...origin, kind: 'project-chat' as const};
        await expect(assertChatSystemRoleSource(f.db, owner, room)).rejects.toThrow('не найден'); expect(features).not.toHaveBeenCalled();
        f.state.invited = true; await assertChatSystemRoleSource(f.db, owner, room); expect(features).toHaveBeenCalledWith(['chat_system_roles', 'system_role_chat', 'project_chat', 'project_chat_dialogs']);
    });
    it('keeps legacy dialogs untouched and rechecks a bound original on every new checkpoint', async () => {
        const f = fixture(); await assertChatSystemRoleOrigin(f.db, dialogId, owner, project); expect(features).not.toHaveBeenCalled();
        f.state.bound = true; await assertChatSystemRoleOrigin(f.db, dialogId, owner, project);
        f.state.source = false; await expect(assertChatSystemRoleOrigin(f.db, dialogId, owner, project)).rejects.toThrow('недоступен');
    });
    it('checks a lost source before collecting any new preview or private dialog context', async () => {
        const f = fixture(); f.state.bound = true; f.state.source = false;
        const chats = new SystemRoleChatService(f.models as never, f.roles as never);
        await expect(chats.prepare(request(), dialogId, {agentId: 'agent-ai-admin', selection: {projectId: project, instruction: 'Проверь проект', diagnostics: [], targets: []}, includeContext: true})).rejects.toThrow('недоступен');
        expect(f.roles.prepare).not.toHaveBeenCalled(); expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO system_role_dialog_contexts'))).toBe(false);
    });
});

function application() {
    const row = {id: 'run', agent_id: 'agent-autoconfigurator', project_id: project, state: 'awaiting_review', revision: 1, applied: [], request_hash: 'a'.repeat(64),
        request: {source: {kind: 'system-role-chat', dialogId, turnId: originId}, expectedDefinitionPin: roleDefinitionPin('agent-autoconfigurator')},
        result: {kind: 'proposal', changes: [{targetKey: 'agent:one', replacement: 'New prompt'}]}, snapshot: {targets: [{key: 'agent:one', editable: true}]}};
    const repository = {transaction: async work => work({}), get: async () => row, applying: async () => row, change: vi.fn(async (_db, _row, state, phase, _message, patch) => Object.assign(row, {state, phase, revision: row.revision + 1}, patch))};
    const policy = {actor: vi.fn(async () => ({email: owner})), authorize: vi.fn(), source: vi.fn()}, receipt = {targetKey: 'agent:one', version: 2, pin: 'b'.repeat(64), owner: 'agent'};
    const targets = {write: vi.fn(async () => receipt)}, features = vi.fn();
    const service = new SystemRoleApplication(repository as never, policy as never, targets as never, features);
    return {row, repository, policy, targets, receipt, apply: (rollback = false) => service.apply({} as never, row as never, row.revision, originId, rollback)};
}
it('a lost origin blocks a new apply before it records or writes a mutation', async () => {
    const f = application(); f.policy.source.mockRejectedValue(new ForbiddenException('Origin revoked'));
    await expect(f.apply()).rejects.toThrow('Origin revoked'); expect(f.repository.change).not.toHaveBeenCalled(); expect(f.targets.write).not.toHaveBeenCalled();
});
it('a checkpoint revoked after apply admission prevents the first actual owner write', async () => {
    const f = application(); f.policy.source.mockResolvedValueOnce(undefined).mockRejectedValue(new ForbiddenException('Origin revoked'));
    await expect(f.apply()).resolves.toMatchObject({phase: 'unconfirmed'}); expect(f.policy.source).toHaveBeenCalledTimes(2); expect(f.targets.write).not.toHaveBeenCalled();
});
it('confirmed owner receipts can still roll back with the source unavailable', async () => {
    const f = application(); await f.apply(); f.policy.source.mockClear(); f.policy.source.mockRejectedValue(new ForbiddenException('Origin revoked'));
    await expect(f.apply(true)).resolves.toMatchObject({phase: 'rolled_back', applied: []}); expect(f.policy.source).not.toHaveBeenCalled();
});
