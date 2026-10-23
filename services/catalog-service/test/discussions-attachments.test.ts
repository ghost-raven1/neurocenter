import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import { DiscussionAttachments } from '../src/discussions/discussions.attachments';
import { DiscussionsStorage } from '../src/discussions/discussions.storage';
import type { DiscussionsPolicy } from '../src/discussions/discussions.policy';
import type { DiscussionsRepository } from '../src/discussions/discussions.repository';
import type { AttachmentRow } from '../src/discussions/discussions.types';
import { requireFeaturesEnabled } from '../src/features/require-feature-enabled';
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: vi.fn() }));
const id = '00000000-0000-0000-0000-000000000001', requestKey = '00000000-0000-0000-0000-000000000002';
const actor = { email: 'author@fixture.test', activeRole: 'Разработчик', displayName: 'Автор' };
const request = (text = 'file bytes', key = requestKey): Request => Object.assign(Readable.from([Buffer.from(text)]), { headers: { 'content-length': String(Buffer.byteLength(text)), 'x-file-name': encodeURIComponent('данные.txt'), 'x-request-key': key }, query: { targetType: 'catalog', targetId: 'mcp:sample' } }) as unknown as Request;

describe('Discussion upload intent, replay and deletion boundaries', () => {
    let row: AttachmentRow | undefined, inTransaction: boolean, revoked: boolean, deniedOwner: boolean, leaseHeld: boolean;
    const query = vi.fn(), put = vi.fn(), read = vi.fn(), remove = vi.fn(), release = vi.fn();
    let service: DiscussionAttachments;
    beforeEach(() => {
        row = undefined; inTransaction = false; revoked = false; deniedOwner = false; leaseHeld = false; release.mockReset(); vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);
        put.mockReset().mockResolvedValue(null); read.mockReset().mockResolvedValue(Buffer.from('file bytes')); remove.mockReset().mockResolvedValue(undefined);
        query.mockReset().mockImplementation(async (sql: string, values: unknown[] = []) => {
            if (sql.startsWith('SELECT pg_try_advisory_lock')) { const locked = !leaseHeld; if (locked) leaseHeld = true; return { rows: [{ locked }] }; }
            if (sql.startsWith('SELECT pg_advisory_unlock')) { const unlocked = leaseHeld; leaseHeld = false; return { rows: [{ unlocked }] }; }
            if (sql.startsWith('SELECT * FROM discussion_attachments WHERE owner_email') || sql.startsWith('SELECT * FROM discussion_attachments WHERE id')) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            if (sql.startsWith('SELECT count(*) AS count,COALESCE')) return { rows: [{ count: '0', bytes: '0' }] };
            if (sql.startsWith('INSERT INTO discussion_attachments')) {
                row = { id: String(values[0]), target_type: 'catalog', target_id: 'mcp:sample', owner_email: actor.email, name: String(values[4]), media_type: String(values[5]), bytes: Number(values[6]), sha256: String(values[7]), storage_id: String(values[8]), bucket: String(values[9]), object_key: String(values[10]), version_id: null, state: 'UPLOADING', comment_id: null, request_key: String(values[11]), created_at: '2026-10-23T00:00:00.000Z' };
                return { rows: [row], rowCount: 1 };
            }
            if (sql.startsWith("UPDATE discussion_attachments SET state='READY'")) { if (row?.state !== 'UPLOADING') return { rows: [], rowCount: 0 }; row = { ...row, state: 'READY', version_id: values[1] as string | null }; return { rows: [row], rowCount: 1 }; }
            if (sql.startsWith("UPDATE discussion_attachments SET state='DELETED'")) { if (row) row = { ...row, state: 'DELETED' }; return { rows: [], rowCount: row ? 1 : 0 }; }
            if (sql.startsWith("SELECT * FROM discussion_attachments WHERE state='DELETED'")) return { rows: row?.state === 'DELETED' ? [row] : [] };
            if (sql.startsWith("UPDATE discussion_attachments SET state='PURGED'")) { if (row) row = { ...row, state: 'PURGED' }; }
            if (sql.startsWith('SELECT 1 FROM discussion_comments')) return { rows: [{}], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        });
        const repository = { pool: { query, connect: async () => ({ query, release }) }, transaction: async (run: (db: unknown) => Promise<unknown>) => { inTransaction = true; try { return await run({ query }); } finally { inTransaction = false; } } } as unknown as DiscussionsRepository;
        const policy = { input: () => actor, actor: async () => { if (revoked) throw Object.assign(new Error('access-revoked'), { status: 403 }); return deniedOwner ? { ...actor, email: 'other@fixture.test' } : actor; }, target: async () => undefined } as unknown as DiscussionsPolicy;
        const bounded = new DiscussionsStorage();
        const storage = { objects: {}, consume: bounded.consume.bind(bounded), intent: () => ({ storage_id: 'a'.repeat(64), bucket: 'private', object_key: 'opaque', sha256: 'unused' }), put, read, remove } as unknown as DiscussionsStorage;
        service = new DiscussionAttachments(repository, policy, storage);
    });
    it('publishes metadata only after a completed object write and replays exact same bytes without S3 or flags', async () => {
        const first = await service.upload(request()); expect(row?.state).toBe('READY'); expect(put).toHaveBeenCalledOnce();
        vi.mocked(requireFeaturesEnabled).mockReset().mockRejectedValue(new Error('off'));
        expect(await service.upload(request())).toEqual(first); expect(put).toHaveBeenCalledOnce(); expect(requireFeaturesEnabled).not.toHaveBeenCalled();
        await expect(service.upload(request('other bytes'))).rejects.toMatchObject({ status: 409 }); expect(put).toHaveBeenCalledOnce();
    });
    it('does not create an intent or an object when a new upload is disabled', async () => {
        vi.mocked(requireFeaturesEnabled).mockRejectedValue(new Error('off'));
        await expect(service.upload(request())).rejects.toThrow('off'); expect(row).toBeUndefined(); expect(put).not.toHaveBeenCalled();
    });
    it('does not send two PUTs for concurrent requests sharing an unfinished upload key', async () => {
        let finish!: () => void, entered!: () => void;
        const begun = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { finish = resolve; });
        put.mockImplementation(async () => { entered(); await waiting; return null; });
        const first = service.upload(request()); await begun;
        await expect(service.upload(request())).rejects.toMatchObject({ status: 409 }); expect(put).toHaveBeenCalledOnce();
        finish(); const saved = await first; expect(await service.upload(request())).toEqual(saved); expect(put).toHaveBeenCalledOnce(); expect(leaseHeld).toBe(false);
    });
    it('keeps an unfinished durable intent when object acknowledgement fails', async () => {
        put.mockRejectedValue(new Error('lost-put-ack'));
        await expect(service.upload(request())).rejects.toThrow('lost-put-ack'); expect(row?.state).toBe('UPLOADING');
        expect(query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE discussion_attachments SET state='READY'"))).toBe(false);
    });
    it('does not activate an object if the account is revoked while the bytes are stored', async () => {
        put.mockImplementation(async () => { revoked = true; return null; });
        await expect(service.upload(request())).rejects.toMatchObject({ status: 403 }); expect(row?.state).toBe('UPLOADING');
    });
    it('does not resurrect an upload cancelled while S3 is acknowledging its write', async () => {
        put.mockImplementation(async () => { row = { ...row!, state: 'DELETED' }; return null; });
        await expect(service.upload(request())).rejects.toMatchObject({ status: 409 }); expect(row?.state).toBe('DELETED');
    });
    it('commits the tombstone before object removal; failed removal remains retryable', async () => {
        await service.upload(request()); remove.mockImplementation(async () => { expect(inTransaction).toBe(false); expect(row?.state).toBe('DELETED'); throw new Error('lost-delete-ack'); });
        await service.reap(); expect(row?.state).toBe('DELETED');
        remove.mockImplementation(async () => { expect(inTransaction).toBe(false); expect(row?.state).toBe('DELETED'); });
        await service.reap(); expect(row?.state).toBe('PURGED'); expect(remove).toHaveBeenCalledTimes(2);
    });
    it('cannot purge an object while the owner still holds the upload lease', async () => {
        let finish!: () => void, entered!: () => void;
        const begun = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { finish = resolve; });
        put.mockImplementation(async () => { entered(); await waiting; return null; });
        const upload = service.upload(request()); await begun; row = { ...row!, state: 'DELETED' };
        await service.reap(); expect(remove).not.toHaveBeenCalled(); expect(row.state).toBe('DELETED');
        finish(); await expect(upload).rejects.toMatchObject({ status: 409 }); await service.reap(); expect(remove).toHaveBeenCalledOnce(); expect(row.state).toBe('PURGED');
    });
    it('checks unbound draft ownership before reading S3 and rechecks revoked access after download', async () => {
        const upload = await service.upload(request()); deniedOwner = true;
        await expect(service.download({} as Request, upload.id)).rejects.toMatchObject({ status: 404 }); expect(read).not.toHaveBeenCalled();
        deniedOwner = false; read.mockImplementation(async () => { revoked = true; return Buffer.from('file bytes'); });
        await expect(service.download({} as Request, upload.id)).rejects.toMatchObject({ status: 403 });
    });
    it('does not let a draft delete detach another author or an already published attachment', async () => {
        const upload = await service.upload(request()); row = { ...row!, comment_id: id };
        await expect(service.remove({} as Request, upload.id)).rejects.toMatchObject({ status: 403 }); expect(row.comment_id).toBe(id);
        row = { ...row, comment_id: null }; deniedOwner = true;
        await expect(service.remove({} as Request, upload.id)).rejects.toMatchObject({ status: 404 }); expect(row.state).toBe('READY');
    });
});
