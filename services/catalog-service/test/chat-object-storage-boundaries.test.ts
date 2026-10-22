import 'reflect-metadata';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatObjectStorage, chatObjectDigest, type ChatObjectReference } from '../src/model-chat/chat-object-storage';

const configuration = { endpoint: 'https://storage.example.test', region: 'us-east-1', accessKey: 'test-access', secretKey: 'test-secret', projectBucket: 'test-projects', personalBucket: 'test-personal' };
const fixture = () => {
    const objects = new ChatObjectStorage(configuration), bytes = Buffer.from('Private fixture bytes');
    vi.spyOn(objects.client, 'makeRequestAsync').mockImplementation(async options => {
        const acl = '<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>';
        return Object.assign(Readable.from([options.query === 'policy' ? '<Error><Code>NoSuchBucketPolicy</Code></Error>' : acl]), { statusCode: options.query === 'policy' ? 404 : 200 }) as never;
    });
    const reference: ChatObjectReference = { storage_id: objects.storageId, bucket: configuration.personalBucket,
        object_key: 'owners/' + chatObjectDigest('owner@fixture.test') + '/chats/' + randomUUID() + '/' + randomUUID(),
        version_id: 'pinned-version', bytes: bytes.length, sha256: chatObjectDigest(bytes) };
    return { objects, bytes, reference };
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Chat object bytes and immutable S3 coordinates', () => {
    it.each([{ storage_id: 'f'.repeat(64) }, { bucket: 'foreign-bucket' }, { object_key: '../foreign' }, { bytes: 0 }, { bytes: 10485761 }, { sha256: 'invalid' }])('rejects a changed reference before any SDK request: %j', async changed => {
        const { objects, reference } = fixture(), get = vi.spyOn(objects.client, 'getObject');
        await expect(objects.read({ ...reference, ...changed })).rejects.toBeInstanceOf(ConflictException); expect(get).not.toHaveBeenCalled();
    });
    it.each([Buffer.from('wrong length'), Buffer.from('X'.repeat(21))])('does not upload bytes that disagree with their durable checksum', async bytes => {
        const f = fixture(), put = vi.spyOn(f.objects.client, 'putObject');
        await expect(f.objects.put(f.reference, bytes)).rejects.toBeInstanceOf(ConflictException); expect(put).not.toHaveBeenCalled();
    });
    it.each(['pinned-version', null])('uses the recorded exact version, including the unversioned null version (%s)', async version => {
        const f = fixture(), get = vi.spyOn(f.objects.client, 'getObject').mockResolvedValue(Readable.from([f.bytes]));
        expect(await f.objects.read({ ...f.reference, version_id: version })).toEqual(f.bytes);
        expect(get).toHaveBeenCalledWith(f.reference.bucket, f.reference.object_key, { versionId: version ?? 'null' });
    });
    it.each(['short', 'oversized', 'changed-hash'])('rejects a %s download and destroys its stream without returning partial data', async kind => {
        const f = fixture(), content = kind === 'short' ? f.bytes.subarray(1) : kind === 'oversized' ? Buffer.concat([f.bytes, Buffer.from('x')]) : Buffer.alloc(f.bytes.length, 65);
        const stream = Readable.from([content]); vi.spyOn(f.objects.client, 'getObject').mockResolvedValue(stream);
        await expect(f.objects.read(f.reference)).rejects.toBeInstanceOf(ServiceUnavailableException); expect(stream.destroyed).toBe(true);
    });
    it('does not leak SDK errors or retry a failed download', async () => {
        const f = fixture(), get = vi.spyOn(f.objects.client, 'getObject').mockRejectedValue(new Error('test-secret private-endpoint'));
        let failure: unknown; try { await f.objects.read(f.reference); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ServiceUnavailableException); expect(String(failure)).not.toMatch(/test-secret|private-endpoint/); expect(get).toHaveBeenCalledOnce();
    });
    it('keeps cancellation distinct from S3 failure and removes the read listener', async () => {
        const f = fixture(), abort = new AbortController(), stopped = new Error('stop private download'), stream = new PassThrough();
        let received!: () => void; const ready = new Promise<void>(resolve => { received = resolve; });
        vi.spyOn(f.objects.client, 'getObject').mockImplementation(async () => { received(); return stream; });
        const pending = f.objects.read(f.reference, abort.signal); await ready; abort.abort(stopped);
        await expect(pending).rejects.toBe(stopped); expect(stream.destroyed).toBe(true); expect(getEventListeners(abort.signal, 'abort')).toEqual([]);
    });
    it('bounds an indefinitely paused download without accepting its partial bytes', async () => {
        vi.useFakeTimers(); const f = fixture(), stream = new PassThrough();
        vi.spyOn(f.objects.client, 'getObject').mockResolvedValue(stream);
        const pending = f.objects.read(f.reference); const rejected = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
        await vi.advanceTimersByTimeAsync(30001); await rejected; expect(stream.destroyed).toBe(true);
    });
});

describe('Chat object privacy and cleanup boundaries', () => {
    it('does not let an anonymous denial override a newly public signed bucket policy', async () => {
        const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })));
        vi.mocked(f.objects.client.makeRequestAsync).mockResolvedValueOnce(Object.assign(Readable.from([JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObjectVersion', Resource: '*' }] })]), { statusCode: 200 }) as never);
        await expect(f.objects.assertPrivate(f.reference)).rejects.toBeInstanceOf(ServiceUnavailableException); expect(fetch).not.toHaveBeenCalled();
    });
    it.each([200, 206, 302, 500])('does not accept an anonymous HEAD status %i as a private object', async status => {
        const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
        await expect(f.objects.assertPrivate(f.reference)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: 'HEAD', redirect: 'error' }));
    });
    it.each([401, 403, 404])('accepts anonymous denial status %i without exposing a signed URL', async status => {
        const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
        await expect(f.objects.assertPrivate(f.reference)).resolves.toBeUndefined();
    });
    it('removes only the exact nonce and each listed version, preserving prefix neighbours', async () => {
        const f = fixture(), stream = Readable.from([{ name: f.reference.object_key, versionId: 'first' }, { name: f.reference.object_key + '-neighbour', versionId: 'second' }, { name: f.reference.object_key }]);
        vi.spyOn(f.objects.client, 'listObjects').mockReturnValue(stream); const remove = vi.spyOn(f.objects.client, 'removeObject').mockResolvedValue();
        await f.objects.remove(f.reference);
        expect(remove.mock.calls).toEqual([[f.reference.bucket, f.reference.object_key, { versionId: 'first' }], [f.reference.bucket, f.reference.object_key, { versionId: 'null' }]]);
        expect(stream.destroyed).toBe(true);
    });
    it('bounds maliciously long version listings and leaves their cleanup retryable', async () => {
        const f = fixture(), stream = Readable.from(Array.from({ length: 129 }, (_, id) => ({ name: f.reference.object_key, versionId: String(id) })));
        vi.spyOn(f.objects.client, 'listObjects').mockReturnValue(stream); const remove = vi.spyOn(f.objects.client, 'removeObject').mockResolvedValue();
        await expect(f.objects.remove(f.reference)).rejects.toBeInstanceOf(ServiceUnavailableException); expect(remove).toHaveBeenCalledTimes(128); expect(stream.destroyed).toBe(true);
    });
});
