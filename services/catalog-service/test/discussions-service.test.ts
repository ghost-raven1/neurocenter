import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscussionsService } from '../src/discussions/discussions.service';
import type { DiscussionsRepository } from '../src/discussions/discussions.repository';
import type { DiscussionsPolicy, DiscussionActor } from '../src/discussions/discussions.policy';
import type { DiscussionsStorage } from '../src/discussions/discussions.storage';
import type { CommentRow } from '../src/discussions/discussions.types';
import type { Request } from 'express';
import { requireFeatureEnabled } from '../src/features/require-feature-enabled';
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeatureEnabled: vi.fn() }));
vi.mock('../../shared/feature-client.cjs', () => ({ readFeatures: vi.fn(async () => ({ flags: { discussions: true, discussion_attachments: true } })) }));
const id = '00000000-0000-0000-0000-000000000001', requestKey = '00000000-0000-0000-0000-000000000002';
const actor: DiscussionActor = { email: 'writer@fixture.test', activeRole: 'Разработчик', displayName: 'Автор', claims: { email: 'writer@fixture.test', projects: [], userRoles: ['Разработчик'], pluginIds: [], skillPaths: [] } };
const input = { targetType: 'catalog', targetId: 'mcp:sample', body: 'Комментарий', requestKey };
const initial = (): CommentRow => ({ id, target_type: 'catalog', target_id: 'mcp:sample', parent_id: null, body: 'Комментарий', author_email: actor.email, author_name: actor.displayName, version: 1, request_key: requestKey, request_hash: '', created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z', deleted_at: null });

describe('Discussion durable admission, replies and CAS', () => {
    let row: CommentRow | undefined, inserts: number, updates: number, liked: boolean;
    const query = vi.fn();
    let service: DiscussionsService, target: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        row = undefined; inserts = 0; updates = 0; liked = false; vi.mocked(requireFeatureEnabled).mockReset().mockResolvedValue(undefined);
        query.mockReset().mockImplementation(async (sql: string, values: unknown[] = []) => {
            if (sql.startsWith('SELECT * FROM discussion_comments WHERE author_email')) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            if (sql.startsWith('SELECT * FROM discussion_comments WHERE id')) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            if (sql.startsWith('INSERT INTO discussion_comments')) { inserts++; row = { ...initial(), id: String(values[0]), request_hash: String(values[8]) }; return { rows: [row], rowCount: 1 }; }
            if (sql.startsWith('UPDATE discussion_comments')) { updates++; row = { ...row!, body: String(values[1]), version: row!.version + 1, deleted_at: values[2] ? new Date() : null }; return { rows: [row], rowCount: 1 }; }
            if (sql.startsWith('SELECT 1 FROM catalog_reactions')) return { rows: liked ? [{}] : [], rowCount: liked ? 1 : 0 };
            if (sql.startsWith('INSERT INTO catalog_reactions')) { inserts++; liked = true; }
            if (sql.startsWith('DELETE FROM catalog_reactions')) { updates++; liked = false; }
            if (sql.startsWith('SELECT count(*) AS count FROM catalog_reactions')) return { rows: [{ count: liked ? '1' : '0' }], rowCount: 1 };
            if (sql.startsWith('SELECT count(*) AS count FROM discussion_comments')) return { rows: [{ count: row && !row.deleted_at ? '1' : '0' }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        });
        target = vi.fn(async () => undefined);
        const repository = { pool: { query }, transaction: async (run: (db: unknown) => Promise<unknown>) => run({ query }) } as unknown as DiscussionsRepository;
        const policy = { input: () => actor, actor: async () => actor, target } as unknown as DiscussionsPolicy;
        service = new DiscussionsService(repository, policy, { objects: null } as unknown as DiscussionsStorage);
    });
    it('blocks a new disabled comment but returns a matching committed request without another write or flag admission', async () => {
        const first = await service.create({} as Request, input); expect(inserts).toBe(1);
        vi.mocked(requireFeatureEnabled).mockReset().mockRejectedValue(new Error('feature-off'));
        expect(await service.create({} as Request, input)).toEqual(first); expect(inserts).toBe(1); expect(requireFeatureEnabled).not.toHaveBeenCalled();
        row = undefined; await expect(service.create({} as Request, { ...input, requestKey: id })).rejects.toThrow('feature-off'); expect(inserts).toBe(1);
    });
    it('preserves an accepted attachment replay when files are disabled but cannot bind a new staged file', async () => {
        const attachmentId = '00000000-0000-0000-0000-000000000003', base = query.getMockImplementation()!;
        const attachment = { id: attachmentId, target_type: 'catalog', target_id: 'mcp:sample', owner_email: actor.email, state: 'READY', comment_id: null, name: 'note.txt', media_type: 'text/plain', bytes: 4 };
        let bindings = 0;
        query.mockImplementation(async (sql: string, values: unknown[] = []) => {
            if (sql.startsWith('SELECT * FROM discussion_attachments WHERE id=ANY')) return { rows: [attachment], rowCount: 1 };
            if (sql.startsWith('UPDATE discussion_attachments SET comment_id=$2')) { bindings++; return { rows: [], rowCount: 1 }; }
            return base(sql, values);
        });
        const withFile = { ...input, attachmentIds: [attachmentId] }, accepted = await service.create({} as Request, withFile);
        expect(inserts).toBe(1); expect(bindings).toBe(1);
        vi.mocked(requireFeatureEnabled).mockReset().mockImplementation(async key => { if (key === 'discussion_attachments') throw new Error('attachments-off'); });
        expect(await service.create({} as Request, withFile)).toEqual(accepted);
        expect(requireFeatureEnabled).not.toHaveBeenCalled(); expect(inserts).toBe(1); expect(bindings).toBe(1);
        row = undefined;
        await expect(service.create({} as Request, { ...withFile, requestKey: id })).rejects.toThrow('attachments-off');
        expect(inserts).toBe(1); expect(bindings).toBe(1);
        expect(requireFeatureEnabled).toHaveBeenCalledWith('discussion_attachments');
    });
    it('rejects reusing a committed request for another body, target or reply', async () => {
        await service.create({} as Request, input);
        for (const patch of [{ body: 'Другой текст' }, { targetId: 'mcp:other' }, { parentId: id }]) await expect(service.create({} as Request, { ...input, ...patch })).rejects.toMatchObject({ status: 409 });
        expect(inserts).toBe(1);
    });
    it('rechecks current target access before returning a successful replay', async () => {
        await service.create({} as Request, input); target.mockRejectedValue(new Error('target-revoked'));
        await expect(service.create({} as Request, input)).rejects.toThrow('target-revoked'); expect(inserts).toBe(1);
    });
    it('does not return a loaded discussion after the target assignment is revoked under the same active role', async () => {
        const identity = { ...actor, claims: { ...actor.claims, projects: [{ projectId: 'prj-target', projectName: 'Target', role: 'Разработчик' }] } };
        const revoked = { ...actor, claims: { ...actor.claims, projects: [{ projectId: 'prj-other', projectName: 'Other', role: 'Разработчик' }] } };
        const actorPolicy = vi.fn().mockResolvedValue(revoked).mockResolvedValueOnce(identity);
        const targetPolicy = vi.fn(async (_db: unknown, current: DiscussionActor) => { if (!current.claims.projects.some(row => row.projectId === 'prj-target')) throw new Error('assignment-revoked'); });
        const changed = new DiscussionsService(service.repository, { input: () => actor, actor: actorPolicy, target: targetPolicy } as unknown as DiscussionsPolicy, service.storage);
        await expect(changed.list({} as Request, { targetType: 'catalog', targetId: 'mcp:sample' })).rejects.toThrow('assignment-revoked');
        expect(targetPolicy).toHaveBeenLastCalledWith(service.repository.pool, revoked, { type: 'catalog', id: 'mcp:sample' });
    });
    it('rejects a reply to a comment belonging to another target', async () => {
        row = { ...initial(), target_id: 'mcp:other' };
        // Parent exists, but it is not a duplicate mutation by this actor.
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM discussion_comments WHERE id') ? [row] : [], rowCount: sql.startsWith('SELECT * FROM discussion_comments WHERE id') ? 1 : 0 }));
        await expect(service.create({} as Request, { ...input, parentId: id })).rejects.toMatchObject({ status: 400 }); expect(inserts).toBe(0);
    });
    it('keeps the current text when CAS is stale and checks the author independently of feature access', async () => {
        row = { ...initial(), version: 2 };
        await expect(service.update({} as Request, id, { body: 'Черновик', expectedVersion: 1 })).rejects.toMatchObject({ status: 409 }); expect(updates).toBe(0); expect(row.body).toBe('Комментарий');
        row.author_email = 'other@fixture.test';
        await expect(service.update({} as Request, id, { body: 'Черновик', expectedVersion: 2 })).rejects.toMatchObject({ status: 403 }); expect(updates).toBe(0);
    });
    it('leaves a tombstone for replies and removes bound files without requiring a feature flag', async () => {
        row = initial(); vi.mocked(requireFeatureEnabled).mockRejectedValue(new Error('off'));
        await expect(service.remove({} as Request, id, '1')).resolves.toEqual({ ok: true }); expect(row.body).toBe(''); expect(row.deleted_at).toBeTruthy();
        expect(query.mock.calls.some(([sql]) => String(sql).includes("comment_id=NULL,state='DELETED'"))).toBe(true); expect(requireFeatureEnabled).not.toHaveBeenCalled();
    });
    it('uses desired-state hearts: a matching like and an unlike remain safe with the feature disabled', async () => {
        expect(await service.reaction({} as Request, 'mcp:sample', true)).toEqual({ liked: true, count: 1, commentCount: 0 });
        vi.mocked(requireFeatureEnabled).mockReset().mockRejectedValue(new Error('off'));
        expect(await service.reaction({} as Request, 'mcp:sample', true)).toEqual({ liked: true, count: 1, commentCount: 0 }); expect(requireFeatureEnabled).not.toHaveBeenCalled();
        expect(await service.reaction({} as Request, 'mcp:sample', false)).toEqual({ liked: false, count: 0, commentCount: 0 }); expect(requireFeatureEnabled).not.toHaveBeenCalled();
        await expect(service.reaction({} as Request, 'mcp:sample', true)).rejects.toThrow('off'); expect(inserts).toBe(1);
    });
    it('returns an authoritative target comment total independently of the loaded page', async () => {
        const base = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values: unknown[] = []) => sql.startsWith('SELECT count(*) AS count FROM discussion_comments')
            ? { rows: [{ count: '53' }], rowCount: 1 } : base(sql, values));
        const page = await service.list({} as Request, { targetType: 'help', targetId: 'models' });
        expect(page.items).toEqual([]); expect(page).toMatchObject({ totalCount: 53, canComment: true, canAttach: false });
        expect(await service.reaction({} as Request, 'mcp:sample')).toEqual({ liked: false, count: 0, commentCount: 53 });
        expect(requireFeatureEnabled).not.toHaveBeenCalled();
    });
    it('rechecks target access after reading counts and never returns revoked reaction metadata', async () => {
        const base = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, values: unknown[] = []) => {
            if (sql.startsWith('SELECT count(*) AS count FROM discussion_comments')) {
                target.mockRejectedValue(new Error('assignment-revoked')); return { rows: [{ count: '53' }], rowCount: 1 };
            }
            return base(sql, values);
        });
        await expect(service.reaction({} as Request, 'mcp:sample')).rejects.toThrow('assignment-revoked');
    });
    it('uses the stored microsecond boundary without changing the public cursor format', async () => {
        const base = query.getMockImplementation()!, at = '2026-10-23T00:00:00.123Z', boundary = '2026-10-23 00:00:00.123456+00';
        query.mockImplementation(async (sql: string, values: unknown[] = []) => sql.startsWith('SELECT created_at,created_at::text AS boundary')
            ? { rows: [{created_at: at, boundary}], rowCount: 1 } : base(sql, values));
        const cursor = Buffer.from(JSON.stringify({at, id})).toString('base64url');
        await service.list({} as Request, {targetType: 'catalog', targetId: 'mcp:sample', cursor});
        expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at,id LIMIT 51'), ['catalog', 'mcp:sample', boundary, id]);
        expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT created_at,created_at::text AS boundary'), [id, 'catalog', 'mcp:sample']);
    });
    it('rejects a foreign or stale cursor before loading another page', async () => {
        const cursor = Buffer.from(JSON.stringify({at: '2026-10-23T00:00:00.123Z', id})).toString('base64url');
        await expect(service.list({} as Request, {targetType: 'help', targetId: 'models', cursor})).rejects.toMatchObject({status: 400});
        expect(query.mock.calls.some(([sql]) => String(sql).includes('ORDER BY created_at,id LIMIT 51'))).toBe(false);
    });
    it.each(['list', 'read'] as const)('does not return %s after read access is revoked during the write-capability check', async operation => {
        row = initial();
        let entered!: () => void, release!: () => void, revoked = false;
        const begun = new Promise<void>(resolve => {entered = resolve;}), held = new Promise<void>(resolve => {release = resolve;});
        target.mockImplementation(async (_db: unknown, _actor: DiscussionActor, _target: unknown, write = false) => {
            if (write) {entered(); await held; revoked = true;}
            if (revoked) throw new Error('assignment-revoked');
        });
        const pending = operation === 'list' ? service.list({} as Request, {targetType: 'catalog', targetId: 'mcp:sample'}) : service.read({} as Request, id);
        await begun; release();
        await expect(pending).rejects.toThrow('assignment-revoked');
    });
});
