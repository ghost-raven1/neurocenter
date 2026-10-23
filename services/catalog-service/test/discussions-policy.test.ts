import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscussionsPolicy, type DiscussionActor } from '../src/discussions/discussions.policy';
import type { HelpService } from '../src/help/help.service';
import type { Pool } from 'pg';
const identity = { email: 'reader@fixture.test', activeRole: 'Разработчик' };

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
        query.mockResolvedValue({ rows: [], rowCount: 0 }); vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'fixture-internal');
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
});
