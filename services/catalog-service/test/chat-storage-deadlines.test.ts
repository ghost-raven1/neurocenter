import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import http, { type IncomingMessage } from 'node:http';
import { getEventListeners } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStorage } from '../src/model-chat/chat-attachment-storage';
import { ChatObjectStorage, chatObjectDigest, type ChatObjectReference } from '../src/model-chat/chat-object-storage';

const config = { endpoint: 'http://127.0.0.1:1', region: 'us-east-1', accessKey: 'test-access', secretKey: 'test-secret', projectBucket: 'test-projects', personalBucket: 'test-personal' };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

/** Public HTTP request double: the real MinIO SDK still signs and sends its PUT through the production transport wrapper. */
class ControlledRequest extends Writable {
    idleMilliseconds?: number;
    idle?: () => void;
    failure: Error | null = null;
    destroyCount = 0;
    constructor(readonly respond: (response: IncomingMessage) => void) { super({ autoDestroy: false }); }
    override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback(); }
    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void { this.failure = error; this.destroyCount++; callback(error); }
    setTimeout(milliseconds: number, callback: () => void): this { this.idleMilliseconds = milliseconds; this.idle = callback; return this; }
}

const transportFixture = () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; }), requests: ControlledRequest[] = [], methods: string[] = [];
    vi.spyOn(http, 'request').mockImplementation((...args: unknown[]) => {
        const request = new ControlledRequest(args.find(value => typeof value === 'function') as (response: IncomingMessage) => void);
        requests.push(request); methods.push(String((args[0] as http.RequestOptions).method)); started(); return request as unknown as http.ClientRequest;
    });
    const objects = new ChatObjectStorage(config, { allowInsecureLocal: true }), bytes = Buffer.from('bounded PUT');
    const reference: ChatObjectReference = { storage_id: objects.storageId, bucket: config.personalBucket,
        object_key: 'owners/' + chatObjectDigest('owner') + '/chats/' + randomUUID() + '/' + randomUUID(),
        version_id: null, sha256: chatObjectDigest(bytes), bytes: bytes.length };
    return { objects, bytes, reference, ready, requests, methods };
};

describe('Actual chat S3 transport deadline and abort callbacks', () => {
    it('destroys an idle PUT after the configured socket timeout without another upload', async () => {
        const f = transportFixture(), pending = f.objects.put(f.reference, f.bytes), rejected = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
        await f.ready; expect(f.requests[0].idleMilliseconds).toBe(15000); f.requests[0].idle!(); await rejected;
        expect(f.requests[0].failure?.message).toBe('chat-s3-idle'); expect(f.requests[0].destroyed).toBe(true);
        expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(60000); expect(f.methods).toEqual(['PUT']);
    });
    it('enforces the absolute PUT deadline even when the socket never emits idle', async () => {
        const f = transportFixture(), pending = f.objects.put(f.reference, f.bytes), rejected = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
        await f.ready; await vi.advanceTimersByTimeAsync(30001); await rejected;
        expect(f.requests[0].failure?.message).toBe('chat-s3-timeout'); expect(f.requests[0].destroyCount).toBe(1);
        expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(60000); expect(f.methods).toEqual(['PUT']);
    });
    it('aborts the actual outgoing PUT and removes its signal listener and absolute timer', async () => {
        const f = transportFixture(), abort = new AbortController(), stopped = new Error('explicit upload cancellation');
        const pending = f.objects.put(f.reference, f.bytes, abort.signal), rejected = expect(pending).rejects.toBe(stopped);
        await f.ready; expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1); abort.abort(stopped); await rejected;
        expect(f.requests[0].failure?.message).toBe('chat-s3-cancelled'); expect(getEventListeners(abort.signal, 'abort')).toEqual([]);
        expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(60000); expect(f.methods).toEqual(['PUT']);
    });
    it('cleans request resources after success so a later caller abort cannot destroy or repeat the PUT', async () => {
        const f = transportFixture(), abort = new AbortController(), pending = f.objects.put(f.reference, f.bytes, abort.signal);
        await f.ready;
        const response = Object.assign(Readable.from([]), { statusCode: 200, headers: { etag: '"fixture-etag"', 'x-amz-version-id': 'version-1' } }) as unknown as IncomingMessage;
        response.once('end', () => f.requests[0].destroy()); f.requests[0].respond(response);
        expect(await pending).toBe('version-1'); await vi.advanceTimersByTimeAsync(0);
        expect(getEventListeners(abort.signal, 'abort')).toEqual([]); expect(vi.getTimerCount()).toBe(0);
        abort.abort(); await vi.advanceTimersByTimeAsync(60000);
        expect(f.requests[0].destroyCount).toBe(1); expect(f.requests[0].failure).toBeNull(); expect(f.methods).toEqual(['PUT']);
    });
    it('destroys a stalled version listing at its deadline without deleting an unlisted object', async () => {
        const f = transportFixture(), stream = new PassThrough({ objectMode: true });
        vi.spyOn(f.objects.client, 'listObjects').mockReturnValue(stream); const remove = vi.spyOn(f.objects.client, 'removeObject');
        const pending = f.objects.remove(f.reference), rejected = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
        await vi.advanceTimersByTimeAsync(30001); await rejected;
        expect(stream.destroyed).toBe(true); expect(remove).not.toHaveBeenCalled(); expect(f.methods).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Chat cleanup lifecycle without private state access', () => {
    const emptyLease = () => ({ query: vi.fn(async (sql: string) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ locked: false }] : [], rowCount: 0 })), release: vi.fn() });
    it('recovers from a periodic cleanup failure and stops future ticks on close', async () => {
        const lease = emptyLease(), connect = vi.fn().mockResolvedValue(lease).mockResolvedValueOnce(lease).mockResolvedValueOnce(lease).mockRejectedValueOnce(new Error('temporary checkout outage'));
        const objects = new ChatObjectStorage(config, { allowInsecureLocal: true }); vi.spyOn(objects, 'initialize').mockResolvedValue();
        const put = vi.spyOn(objects, 'put'), storage = new ChatAttachmentStorage({ connect } as unknown as Pool, { objectStorage: objects });
        try {
            await storage.initialize(); expect(connect).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(30000); expect(connect).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(30000); expect(connect).toHaveBeenCalledTimes(4); expect(lease.release).toHaveBeenCalledTimes(3);
            await storage.close(); await vi.advanceTimersByTimeAsync(60000);
            expect(connect).toHaveBeenCalledTimes(4); expect(put).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
        } finally { await storage.close(); }
    });
    it('waits for a queued cleanup during shutdown and resumes it after the earlier checkout failed', async () => {
        const lease = emptyLease(), failure = new Error('checkout interrupted'); let fail!: (error: Error) => void;
        const held = new Promise<never>((_resolve, reject) => { fail = reject; }), connect = vi.fn().mockReturnValueOnce(held).mockResolvedValue(lease);
        const storage = new ChatAttachmentStorage({ connect } as unknown as Pool, { objectStorage: new ChatObjectStorage(config, { allowInsecureLocal: true }) });
        const first = storage.collect(), rejected = expect(first).rejects.toBe(failure), queued = storage.collect();
        let closed = false; const closing = storage.close().then(() => { closed = true; });
        await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false); fail(failure);
        await rejected; expect(await queued).toBe(0); await closing;
        expect(closed).toBe(true); expect(connect).toHaveBeenCalledTimes(2); expect(lease.release).toHaveBeenCalledOnce();
    });
    it('keeps metadata startup available without storage but denies new file operations explicitly', async () => {
        for (const key of ['CHAT_S3_ENDPOINT', 'CHAT_S3_ACCESS_KEY', 'CHAT_S3_SECRET_KEY', 'CHAT_S3_PROJECT_BUCKET', 'CHAT_S3_PERSONAL_BUCKET']) vi.stubEnv(key, undefined);
        const query = vi.fn(async () => ({ rows: [], rowCount: 0 })), storage = new ChatAttachmentStorage({ query } as unknown as Pool);
        await expect(storage.initialize()).resolves.toBeUndefined(); expect(await storage.collect()).toBe(0);
        await expect(storage.stage({ ownerEmail: 'owner', projectId: null, conversationId: randomUUID(), bytes: Buffer.from('file'), mediaType: 'text/plain' })).rejects.toBeInstanceOf(ServiceUnavailableException);
        await expect(storage.read(randomUUID())).rejects.toBeInstanceOf(ServiceUnavailableException);
        await expect(storage.activate({ query } as unknown as Pick<PoolClient, 'query'>, { id: randomUUID() })).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(query).toHaveBeenCalledOnce(); await storage.close(); expect(vi.getTimerCount()).toBe(0);
    });
});
