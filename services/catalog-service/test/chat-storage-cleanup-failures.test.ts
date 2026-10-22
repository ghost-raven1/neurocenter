import 'reflect-metadata';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStorage } from '../src/model-chat/chat-attachment-storage';
import { ChatObjectStorage, chatObjectDigest, chatS3Configuration } from '../src/model-chat/chat-object-storage';
import { CHAT_SCHEMA_SQL } from '../src/model-chat/chat.schema';
import { CHAT_STORAGE_SCHEMA_SQL } from '../src/model-chat/chat-storage.schema';
import { snapshotS3FixtureConfiguration } from './snapshot-s3.fixture';

const pgUrl = process.env.CHAT_OBJECT_STORAGE_TEST_PG_URL, configFile = process.env.CHAT_OBJECT_STORAGE_TEST_CONFIG;
const cleanupLock = 'model-chat-object-cleanup', transferLock = 'model-chat-attachment-transfer';

describe.skipIf(!pgUrl || !configFile)('Chat storage uncertain PostgreSQL cleanup with real observer', () => {
    let admin: Pool, observer: Pool, db: Pool, objects: ChatObjectStorage, storage: ChatAttachmentStorage, database: string, connectionString: string, conversationId: string;
    const observations: unknown[] = [], bytes = Buffer.from('Keep original bytes until activation commits.');
    beforeAll(async () => {
        const url = new URL(pgUrl!), raw = JSON.parse(readFileSync(configFile!, 'utf8'));
        snapshotS3FixtureConfiguration(raw);
        const supplied = chatS3Configuration(raw)!;
        if (url.hostname !== '127.0.0.1' || !url.port || url.port === '5432') throw new Error('Use a caller-owned loopback PostgreSQL port other than 5432.');
        url.pathname = '/postgres'; admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_chat_cleanup_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; connectionString = url.href; observer = new Pool({ connectionString, max: 1 });
        await observer.query('CREATE TABLE projects(id text PRIMARY KEY); CREATE TABLE model_catalog(id text PRIMARY KEY)');
        await observer.query(CHAT_SCHEMA_SQL); await observer.query(CHAT_STORAGE_SCHEMA_SQL);
        await observer.query("INSERT INTO projects VALUES('prj-cleanup'); INSERT INTO model_catalog VALUES('model-cleanup')");
        const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
        objects = new ChatObjectStorage({ ...supplied, projectBucket: 'nc-clean-project-' + suffix, personalBucket: 'nc-clean-personal-' + suffix }, { allowInsecureLocal: true });
        await objects.initialize();
    });
    beforeEach(async () => {
        await observer.query('TRUNCATE model_chat_objects,model_chat_conversations CASCADE');
        conversationId = randomUUID();
        await observer.query("INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,title,model_pin) VALUES($1,'owner@example.test','model-cleanup','prj-cleanup','Cleanup boundaries',$2)", [conversationId, 'a'.repeat(64)]);
        db = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 500 }); storage = new ChatAttachmentStorage(db, { objectStorage: objects });
    });
    afterEach(async () => { vi.restoreAllMocks(); await storage?.close(); await db?.end(); });
    afterAll(async () => {
        for (const bucket of objects ? [objects.config.projectBucket, objects.config.personalBucket] : []) {
            const stream = objects.client.listObjects(bucket, '', true, { IncludeVersion: true });
            try { for await (const item of stream) if (item.name) await objects.client.removeObject(bucket, item.name, { versionId: item.versionId ?? 'null' }); }
            finally { stream.destroy(); }
            await objects.client.removeBucket(bucket);
        }
        await observer?.end(); if (database) await admin.query('DROP DATABASE ' + database); await admin?.end();
        if (process.env.CHAT_STORAGE_AUDIT_CLEANUP) writeFileSync(process.env.CHAT_STORAGE_AUDIT_CLEANUP, JSON.stringify({ database, ordinaryDrop: true, bucketsRemoved: true, observations, payloadBytesMaximum: bytes.length * 8, mainTouched: false }, null, 2));
    });
    /** Only the specified cleanup transport fails; all business SQL and session locks are real PostgreSQL. */
    const failCleanup = async (sql: RegExp, acknowledgementLost = false) => {
        const client = await db.connect(), pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        const send = client.query.bind(client); let failures = 0;
        vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
            if (!failures && sql.test(String(args[0]))) {
                failures++; const failure = new Error('Injected cleanup transport failure'), callback = args.at(-1);
                if (acknowledgementLost) return Promise.resolve(Reflect.apply(send, client, args)).then(() => { throw failure; });
                if (typeof callback === 'function') { queueMicrotask(() => callback(failure)); return; }
                return Promise.reject(failure);
            }
            return Reflect.apply(send, client, args);
        }) as never);
        client.release(); return { pid, failures: () => failures };
    };
    const lockAvailable = async (name: string): Promise<boolean> => {
        const result = (await observer.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [name])).rows[0].locked as boolean;
        if (result) await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [name]); return result;
    };
    const assertGone = async (pid: number) => {
        await expect.poll(async () => (await observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [pid])).rows, { timeout: 500, interval: 10 }).toEqual([]);
    };
    const transfer = async () => {
        const id = randomUUID();
        await observer.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,storage_state) VALUES($1,$2,$3,$4,'old.txt','text/plain',$5,'old',3,'TRANSFER')", [id, conversationId, randomUUID(), 'b'.repeat(64), bytes.length]);
        await observer.query('INSERT INTO model_chat_attachment_transfers(attachment_id,content,sha256,bytes) VALUES($1,$2,$3,$4)', [id, bytes, chatObjectDigest(bytes), bytes.length]); return id;
    };
    const expireNextUpload = () => {
        const put = objects.put.bind(objects);
        return vi.spyOn(objects, 'put').mockImplementationOnce(async (...args) => {
            const version = await put(...args);
            await observer.query("UPDATE model_chat_objects SET lease_until=now()-interval '1 second' WHERE object_key=$1", [args[0].object_key]); return version;
        });
    };
    const assertOriginal = async (id: string) => {
        expect((await observer.query('SELECT content FROM model_chat_attachment_transfers WHERE attachment_id=$1', [id])).rows[0].content).toEqual(bytes);
        expect((await observer.query('SELECT storage_state,object_id FROM model_chat_attachments WHERE id=$1', [id])).rows[0]).toEqual({ storage_state: 'TRANSFER', object_id: null });
    };

    it('discards the collector session when unlock transport is unconfirmed, including after retry', async () => {
        const fault = await failCleanup(/pg_advisory_unlock.*model-chat-object-cleanup/);
        expect(await storage.collect()).toBe(0); expect(fault.failures()).toBe(1);
        const firstAvailable = await lockAvailable(cleanupLock);
        expect(await storage.collect()).toBe(0); await storage.close();
        const retryAvailable = await lockAvailable(cleanupLock);
        observations.push({ kind: 'collector-unlock', pid: fault.pid, firstAvailable, retryAvailable });
        expect(firstAvailable).toBe(true); expect(retryAvailable).toBe(true); await assertGone(fault.pid);
    });
    it('reuses the collector session after acknowledged acquisition, unlock and a contended false result', async () => {
        const before = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        expect(await storage.collect()).toBe(0); expect(await lockAvailable(cleanupLock)).toBe(true);
        expect((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(before);
        await observer.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [cleanupLock]);
        try { expect(await storage.collect()).toBe(0); expect((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(before); }
        finally { await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [cleanupLock]); }
    });
    it('discards a collector session if the server acquired its lock but the acknowledgement was lost', async () => {
        const fault = await failCleanup(/pg_try_advisory_lock.*model-chat-object-cleanup/, true);
        await expect(storage.collect()).rejects.toThrow('Injected cleanup transport failure'); expect(fault.failures()).toBe(1);
        const firstAvailable = await lockAvailable(cleanupLock); expect(await storage.collect()).toBe(0); const retryAvailable = await lockAvailable(cleanupLock);
        observations.push({ kind: 'collector-acquisition-ack-lost', pid: fault.pid, firstAvailable, retryAvailable });
        expect(firstAvailable).toBe(true); expect(retryAvailable).toBe(true); await assertGone(fault.pid);
    });
    it('discards an unconfirmed migration unlock without losing the committed file or uploading it again', async () => {
        const id = await transfer(), fault = await failCleanup(/pg_advisory_unlock.*model-chat-attachment-transfer/), put = vi.spyOn(objects, 'put');
        await storage.initialize(); const firstAvailable = await lockAvailable(transferLock);
        await storage.initialize(); const retryAvailable = await lockAvailable(transferLock);
        const row = (await observer.query('SELECT object_id,storage_state FROM model_chat_attachments WHERE id=$1', [id])).rows[0];
        expect(row.storage_state).toBe('S3'); expect(await storage.read(row.object_id)).toEqual(bytes); expect(put).toHaveBeenCalledOnce();
        observations.push({ kind: 'migration-unlock', pid: fault.pid, firstAvailable, retryAvailable });
        expect(firstAvailable).toBe(true); expect(retryAvailable).toBe(true); await assertGone(fault.pid);
    });
    it('discards a migration session after acquisition acknowledgement loss and retries the original transfer once', async () => {
        const id = await transfer(), fault = await failCleanup(/SELECT pg_advisory_lock.*model-chat-attachment-transfer/, true), put = vi.spyOn(objects, 'put');
        await expect(storage.initialize()).rejects.toThrow('Injected cleanup transport failure'); expect(fault.failures()).toBe(1); await assertOriginal(id); expect(put).not.toHaveBeenCalled();
        const firstAvailable = await lockAvailable(transferLock); await storage.initialize(); const retryAvailable = await lockAvailable(transferLock);
        const row = (await observer.query('SELECT object_id FROM model_chat_attachments WHERE id=$1', [id])).rows[0]; expect(await storage.read(row.object_id)).toEqual(bytes); expect(put).toHaveBeenCalledOnce();
        observations.push({ kind: 'migration-acquisition-ack-lost', pid: fault.pid, firstAvailable, retryAvailable });
        expect(firstAvailable).toBe(true); expect(retryAvailable).toBe(true); await assertGone(fault.pid);
    });
    it('discards a session with an unconfirmed rollback and preserves transfer bytes for a clean retry', async () => {
        const id = await transfer(), fault = await failCleanup(/^ROLLBACK$/), put = expireNextUpload();
        await expect(storage.initialize()).rejects.toBeInstanceOf(ConflictException); expect(fault.failures()).toBe(1);
        const sessions = (await observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [fault.pid])).rows;
        observations.push({ kind: 'migration-rollback', pid: fault.pid, sessions });
        await assertOriginal(id); await assertGone(fault.pid); expect(await lockAvailable(transferLock)).toBe(true);
        await storage.initialize(); expect(put).toHaveBeenCalledTimes(2);
        const row = (await observer.query('SELECT object_id FROM model_chat_attachments WHERE id=$1', [id])).rows[0];
        expect(await storage.read(row.object_id)).toEqual(bytes);
        expect((await observer.query("SELECT id FROM model_chat_objects WHERE state='LIVE'")).rows).toEqual([{ id: row.object_id }]);
    });
    it('rolls a normal activation conflict back, reuses the clean session and retries once', async () => {
        const id = await transfer(), before = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, put = expireNextUpload();
        await expect(storage.initialize()).rejects.toBeInstanceOf(ConflictException); await assertOriginal(id);
        expect((await observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [before])).rows).toEqual([{ state: 'idle' }]);
        expect(await lockAvailable(transferLock)).toBe(true); expect((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(before);
        await storage.initialize(); expect(put).toHaveBeenCalledTimes(2);
        const row = (await observer.query('SELECT object_id FROM model_chat_attachments WHERE id=$1', [id])).rows[0]; expect(await storage.read(row.object_id)).toEqual(bytes);
    });
    it('preserves the upload error and durable intent when abandonment transport also fails', async () => {
        const failure = new Error('PUT failed before acknowledgement'), fault = await failCleanup(/^UPDATE model_chat_objects SET state='DELETE'/);
        vi.spyOn(objects, 'put').mockRejectedValueOnce(failure);
        await expect(storage.stage({ ownerEmail: 'owner@example.test', projectId: null, conversationId, bytes, mediaType: 'text/plain' })).rejects.toBe(failure);
        expect(fault.failures()).toBe(1); const row = (await observer.query('SELECT id,state FROM model_chat_objects')).rows[0]; expect(row.state).toBe('STAGING');
        await observer.query("UPDATE model_chat_objects SET lease_until=now()-interval '1 second' WHERE id=$1", [row.id]);
        expect(await storage.collect()).toBe(1); expect((await observer.query('SELECT state FROM model_chat_objects WHERE id=$1', [row.id])).rows[0].state).toBe('DELETED');
    });
    it('preserves a rolled back transfer when the abandonment transport fails and later collects its orphan', async () => {
        const id = await transfer(), fault = await failCleanup(/^UPDATE model_chat_objects SET state='DELETE'/); expireNextUpload();
        await expect(storage.initialize()).rejects.toBeInstanceOf(ConflictException); expect(fault.failures()).toBe(1); await assertOriginal(id);
        expect(await lockAvailable(transferLock)).toBe(true); expect(await storage.collect()).toBe(1);
        expect((await observer.query('SELECT state FROM model_chat_objects')).rows).toEqual([{ state: 'DELETED' }]);
        await storage.initialize(); const row = (await observer.query('SELECT object_id FROM model_chat_attachments WHERE id=$1', [id])).rows[0]; expect(await storage.read(row.object_id)).toEqual(bytes);
    });
});

describe('Chat bucket creation race preserves privacy checks', () => {
    afterEach(() => vi.restoreAllMocks());
    const fixture = () => {
        const objects = new ChatObjectStorage({ endpoint: 'https://storage.example.test', region: 'us-east-1', accessKey: 'test-access', secretKey: 'test-secret', projectBucket: 'test-project', personalBucket: 'test-personal' });
        vi.spyOn(objects.client, 'bucketExists').mockResolvedValue(false);
        const control = vi.spyOn(objects.client, 'makeRequestAsync').mockImplementation(async options => Object.assign(Readable.from([options.query === 'policy' ? '<Error><Code>NoSuchBucketPolicy</Code></Error>' : '<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>']), { statusCode: options.query === 'policy' ? 404 : 200 }) as never);
        return { objects, control };
    };
    it('accepts only an already-owned bucket race and still checks both policies and ACLs', async () => {
        const { objects, control } = fixture(), make = vi.spyOn(objects.client, 'makeBucket').mockRejectedValue({ code: 'BucketAlreadyOwnedByYou' });
        await expect(objects.initialize()).resolves.toBeUndefined(); expect(make).toHaveBeenCalledTimes(2); expect(control).toHaveBeenCalledTimes(4);
    });
    it.each([new Error('private transport detail'), { code: 'BucketAlreadyExists' }])('does not accept a foreign bucket or unknown creation failure', async failure => {
        const { objects, control } = fixture(); vi.spyOn(objects.client, 'makeBucket').mockRejectedValue(failure);
        await expect(objects.initialize()).rejects.toBeInstanceOf(ServiceUnavailableException); expect(control).not.toHaveBeenCalled();
    });
});
