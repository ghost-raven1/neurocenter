import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscussionsStorage } from '../src/discussions/discussions.storage';
import type { AttachmentRow } from '../src/discussions/discussions.types';
const bytes = Buffer.from('same bytes');
const row = { id: '00000000-0000-0000-0000-000000000001', storage_id: 'a'.repeat(64), bucket: 'private', object_key: 'opaque', version_id: null, bytes: bytes.length, sha256: 'b'.repeat(64) } as AttachmentRow;

describe('Discussion S3 unknown acknowledgement recovery', () => {
    const statObject = vi.fn(), put = vi.fn(), read = vi.fn(), assertPrivate = vi.fn(), initialize = vi.fn(); let storage: DiscussionsStorage;
    beforeEach(() => {
        statObject.mockReset(); put.mockReset().mockResolvedValue('new-version'); read.mockReset().mockResolvedValue(bytes); assertPrivate.mockReset().mockResolvedValue(undefined); initialize.mockReset().mockResolvedValue(undefined);
        storage = Object.assign(Object.create(DiscussionsStorage.prototype), { objects: { client: { statObject }, put, read, assertPrivate, initialize } }) as DiscussionsStorage;
    });
    it('reuses the exact previously written version after a lost PUT ACK, without another write', async () => {
        statObject.mockResolvedValue({ size: bytes.length, versionId: 'existing-version' });
        expect(await storage.put(row, bytes)).toBe('existing-version'); expect(put).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ version_id: 'existing-version', sha256: row.sha256 }), undefined); expect(assertPrivate).toHaveBeenCalledOnce();
    });
    it('writes and reads back a genuinely absent object once', async () => {
        statObject.mockRejectedValue({ code: 'NoSuchKey' }); expect(await storage.put(row, bytes)).toBe('new-version'); expect(put).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ version_id: 'new-version' }), undefined);
    });
    it('does not overwrite an object after an ambiguous stat error or a corrupt existing version', async () => {
        statObject.mockRejectedValue({ code: 'AccessDenied' }); await expect(storage.put(row, bytes)).rejects.toMatchObject({ status: 503 }); expect(put).not.toHaveBeenCalled();
        statObject.mockResolvedValue({ size: bytes.length + 1, versionId: 'corrupt' }); await expect(storage.put(row, bytes)).rejects.toMatchObject({ status: 409 }); expect(put).not.toHaveBeenCalled();
        statObject.mockResolvedValue({ size: bytes.length, versionId: 'corrupt' }); read.mockRejectedValue(new Error('checksum-mismatch')); await expect(storage.put(row, bytes)).rejects.toThrow('checksum-mismatch'); expect(put).not.toHaveBeenCalled();
    });
});
