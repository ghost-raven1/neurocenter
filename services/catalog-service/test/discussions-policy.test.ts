import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscussionsPolicy, type DiscussionActor } from '../src/discussions/discussions.policy';
import type { HelpService } from '../src/help/help.service';
import type { Pool } from 'pg';
const identity = { email: 'reader@fixture.test', activeRole: 'Разработчик' };
const project = (projectId: string, role = 'Разработчик') => ({ projectId, projectName: projectId, role });
const skillActor = (activeRole = identity.activeRole, projects = [project('prj-own')]): DiscussionActor => ({
    ...identity, activeRole, displayName: 'Reader', claims: { email: identity.email, userRoles: [...new Set([...projects.map(row => row.role), activeRole])], projects, pluginIds: [], skillPaths: [] },
});

describe('Discussion fresh role and exact-target authorization', () => {
    const query = vi.fn(), db = { query } as unknown as Pool;
    const help = { files: { read: vi.fn(async () => ({ content: '# Help' })) } } as unknown as HelpService;
    const policy = new DiscussionsPolicy(help);
    beforeEach(() => { query.mockReset(); });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
    it('rejects a disabled account and a stale active role before accessing any target', async () => {
        query.mockResolvedValue({ rows: [{ enabled: false, is_main_admin: true }] }); await expect(policy.actor(db, identity)).rejects.toMatchObject({ status: 403 });
        query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM platform_users') ? [{ enabled: true, is_main_admin: false, display_name: 'Reader' }] : [{ projectId: 'prj-own', projectName: 'Own', role: 'Наблюдатель' }] }));
        await expect(policy.actor(db, identity)).rejects.toMatchObject({ status: 403 });
    });
    it('reads current grants and holds author/account/project rows when admitting a mutation', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM platform_users') ? [{ enabled: true, is_main_admin: false, display_name: 'Reader' }] : [{ projectId: 'prj-own', projectName: 'Own', role: 'Разработчик' }] }));
        const actor = await policy.actor(db, identity, true); expect(actor.claims.projects).toEqual([{ projectId: 'prj-own', projectName: 'Own', role: 'Разработчик' }]);
        expect(query.mock.calls.every(([sql]) => String(sql).endsWith(' FOR SHARE'))).toBe(true);
    });
    it('keeps project scope in target SQL and locks its assignment before a write', async () => {
        const actor: DiscussionActor = { ...identity, displayName: 'Reader', claims: { email: identity.email, userRoles: ['Разработчик'], projects: [{ projectId: 'prj-own', projectName: 'Own', role: 'Разработчик' }], pluginIds: [], skillPaths: [] } };
        query.mockResolvedValue({ rows: [{ id: 'sample' }], rowCount: 1 }); await policy.target(db, actor, { type: 'catalog', id: 'mcp:sample' }, true);
        expect(query.mock.calls[0][0]).toContain('FROM project_assets'); expect(query.mock.calls[0][0]).toContain('FOR SHARE');
        expect(query.mock.calls[0][1]).toEqual(['sample', 'mcp', ['prj-own']]); expect(query.mock.calls[1][1]).toEqual(['sample', 'mcp', false, ['prj-own']]);
        query.mockResolvedValue({ rows: [], rowCount: 0 }); await expect(policy.target(db, actor, { type: 'catalog', id: 'mcp:foreign' })).rejects.toMatchObject({ status: 404 });
    });
    it('validates a skill against the real internal catalog and refuses foreign project paths', async () => {
        const actor: DiscussionActor = { ...identity, displayName: 'Reader', claims: { email: identity.email, userRoles: ['Разработчик'], projects: [{ projectId: 'prj-own', projectName: 'Own', role: 'Разработчик' }], pluginIds: [], skillPaths: [] } };
        query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM platform_users') ? [{ enabled: true, is_main_admin: false, display_name: 'Reader' }]
            : sql.includes('FROM project_members') ? actor.claims.projects : [], rowCount: 0 })); vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'fixture-internal');
        const request = vi.fn(async () => new Response(JSON.stringify([{ path: 'project-prj-own/helper', meta: {} }]), { status: 200 })); vi.stubGlobal('fetch', request);
        await policy.target(db, actor, { type: 'catalog', id: 'skill:project-prj-own/helper' }); expect(request).toHaveBeenCalledOnce();
        await expect(policy.target(db, actor, { type: 'catalog', id: 'skill:project-prj-other/helper' })).rejects.toMatchObject({ status: 404 }); expect(request).toHaveBeenCalledOnce();
        request.mockResolvedValue(new Response('[]', { status: 200 })); await expect(policy.target(db, actor, { type: 'catalog', id: 'skill:project-prj-own/unknown' })).rejects.toMatchObject({ status: 404 });
    });
    it('does not confuse an owned project name with another project permanent id', async () => {
        const actor: DiscussionActor = { ...identity, displayName: 'Reader', claims: { email: identity.email, userRoles: ['Разработчик'], projects: [{ projectId: 'prj-own', projectName: 'prj-foreign', role: 'Разработчик' }], pluginIds: [], skillPaths: [] } };
        query.mockResolvedValue({ rows: [], rowCount: 0 }); vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'fixture-internal');
        const request = vi.fn(async () => new Response(JSON.stringify([{ path: 'project-prj-foreign/private', meta: {} }]), { status: 200 })); vi.stubGlobal('fetch', request);
        await expect(policy.target(db, actor, { type: 'catalog', id: 'skill:project-prj-foreign/private' })).rejects.toMatchObject({ status: 404 }); expect(request).not.toHaveBeenCalled();
    });
    it.each([
        { scope: 'native', path: 'project-prj-own/helper', role: 'Разработчик', assigned: false },
        { scope: 'assigned', path: 'vendor/helper', role: 'Разработчик', assigned: true },
        { scope: 'common', path: 'common/helper', role: 'Главный админ', assigned: false },
        { scope: 'common-project-admin', path: 'common/helper', role: 'Админ проекта', assigned: false },
    ])('keeps a current $scope skill readable after exactly one catalog request', async ({ path, role, assigned }) => {
        const actor = skillActor(role, [project('prj-own', role === 'Главный админ' ? 'Разработчик' : role)]);
        query.mockImplementation(async (sql: string) => {
            const rows = sql.includes('FROM platform_users') ? [{ enabled: true, is_main_admin: role === 'Главный админ', display_name: 'Reader' }]
                : sql.includes('FROM project_members') ? actor.claims.projects : assigned ? [{}] : [];
            return { rows, rowCount: rows.length };
        });
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'fixture-internal');
        const request = vi.fn(async () => new Response(JSON.stringify([{ path, meta: {} }]), { status: 200 })); vi.stubGlobal('fetch', request);
        await expect(policy.target(db, actor, { type: 'catalog', id: 'skill:' + path })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledOnce();
        expect(query.mock.calls.filter(([sql]) => String(sql).includes('FROM platform_users'))).toHaveLength(1);
        expect(query.mock.calls.filter(([sql]) => String(sql).includes('FROM project_assets'))).toHaveLength(2);
    });
    it.each(['native-project', 'assigned-project', 'explicit-assignment', 'disabled-account', 'active-role'] as const)(
        'denies a delayed skill response after revoking %s without fetching the catalog twice', async revoked => {
            const path = revoked.startsWith('assigned') || revoked === 'explicit-assignment' ? 'vendor/helper' : 'project-prj-own/helper';
            const actor = skillActor('Разработчик', [project('prj-own'), project('prj-other')]);
            let enabled = true, projects = actor.claims.projects, assignment = path === 'vendor/helper';
            query.mockImplementation(async (sql: string, values: unknown[] = []) => {
                const rows = sql.includes('FROM platform_users') ? [{ enabled, is_main_admin: false, display_name: 'Reader' }]
                    : sql.includes('FROM project_members') ? projects
                        : assignment && (values[1] as string[]).includes('prj-own') ? [{}] : [];
                return { rows, rowCount: rows.length };
            });
            let entered!: () => void, release!: () => void;
            const begun = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
            vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'fixture-internal');
            const request = vi.fn(async () => {
                entered(); await held; return new Response(JSON.stringify([{ path, meta: {} }]), { status: 200 });
            }); vi.stubGlobal('fetch', request);
            const pending = policy.target(db, actor, { type: 'catalog', id: 'skill:' + path });
            await begun;
            if (revoked === 'disabled-account') enabled = false;
            else if (revoked === 'active-role') projects = [project('prj-other', 'Наблюдатель')];
            else if (revoked === 'explicit-assignment') assignment = false;
            else projects = [project('prj-other')]; // The selected role remains valid, but this target's project grant is gone.
            release();
            await expect(pending).rejects.toMatchObject({ status: revoked === 'disabled-account' || revoked === 'active-role' ? 403 : 404 });
            expect(request).toHaveBeenCalledOnce();
        });
    it('refreshes common authority after JSON parsing and never expands common access to a private prefix', async () => {
        const actor = skillActor('Админ проекта', [project('prj-own', 'Админ проекта'), project('prj-other', 'Разработчик')]);
        let projects = actor.claims.projects, parsed!: () => void, finish!: () => void;
        const begun = new Promise<void>(resolve => { parsed = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
        query.mockImplementation(async (sql: string) => {
            const rows = sql.includes('FROM platform_users') ? [{ enabled: true, is_main_admin: false, display_name: 'Reader' }]
                : sql.includes('FROM project_members') ? projects : [];
            return { rows, rowCount: rows.length };
        });
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'fixture-internal');
        const request = vi.fn(async () => ({ ok: true, json: async () => { parsed(); await held; return [{ path: 'common/helper', meta: {} }]; } })); vi.stubGlobal('fetch', request);
        const pending = policy.target(db, actor, { type: 'catalog', id: 'skill:common/helper' });
        await begun; projects = [project('prj-other', 'Разработчик')]; finish();
        await expect(pending).rejects.toMatchObject({ status: 403 }); expect(request).toHaveBeenCalledOnce();
        await expect(policy.target(db, actor, { type: 'catalog', id: 'skill:project-prj-foreign/helper' })).rejects.toMatchObject({ status: 404 });
        expect(request).toHaveBeenCalledOnce();
    });
    it('keeps write locks during the fresh post-response account and assignment checks', async () => {
        const actor = skillActor();
        query.mockImplementation(async (sql: string) => {
            const rows = sql.includes('FROM platform_users') ? [{ enabled: true, is_main_admin: false, display_name: 'Reader' }]
                : sql.includes('FROM project_members') ? actor.claims.projects : [];
            return { rows, rowCount: rows.length };
        });
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'fixture-internal');
        const request = vi.fn(async () => new Response(JSON.stringify([{ path: 'project-prj-own/helper', meta: {} }]), { status: 200 })); vi.stubGlobal('fetch', request);
        await policy.target(db, actor, { type: 'catalog', id: 'skill:project-prj-own/helper' }, true);
        const reads = query.mock.calls.filter(([sql]) => String(sql).includes('FROM platform_users') || String(sql).includes('FROM project_members') || String(sql).includes('SELECT 1 FROM project_assets'));
        expect(reads).toHaveLength(4); expect(reads.every(([sql]) => String(sql).endsWith(' FOR SHARE'))).toBe(true);
        expect(request).toHaveBeenCalledOnce();
    });
});
