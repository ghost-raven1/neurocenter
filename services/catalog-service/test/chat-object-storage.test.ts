import 'reflect-metadata';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStorage } from '../src/model-chat/chat-attachment-storage';
import { ChatObjectStorage, chatObjectDigest, chatS3Configuration, type ChatS3Configuration } from '../src/model-chat/chat-object-storage';
import { CHAT_SCHEMA_SQL } from '../src/model-chat/chat.schema';
import { CHAT_STORAGE_SCHEMA_SQL } from '../src/model-chat/chat-storage.schema';
import { assertChatStorageSchema } from '../src/model-chat/chat-storage.schema-verification';

const configFile = process.env.CHAT_OBJECT_STORAGE_TEST_CONFIG, pgUrl = process.env.CHAT_OBJECT_STORAGE_TEST_PG_URL;
const synthetic: ChatS3Configuration = { endpoint: 'https://storage.example.test', accessKey: 'test-access', secretKey: 'test-secret',
    region: 'us-east-1', projectBucket: 'test-projects', personalBucket: 'test-personal' };

describe('Chat S3 configuration boundary', () => {
    afterEach(() => vi.restoreAllMocks());
    it('permits missing optional storage but rejects partial setup and insecure production endpoints', () => {
        expect(chatS3Configuration({})).toBeNull();
        expect(() => chatS3Configuration({ CHAT_S3_ENDPOINT: 'https://example.test' })).toThrow('CHAT_S3');
        expect(() => new ChatObjectStorage({ ...synthetic, endpoint: 'http://127.0.0.1:59607' }, { environment: { NODE_ENV: 'production' } })).toThrow('HTTPS');
        expect(() => new ChatObjectStorage({ ...synthetic, endpoint: 'http://external.example.test' }, { environment: { NODE_ENV: 'production' }, allowInsecureLocal: true })).toThrow('HTTPS');
        expect(() => new ChatObjectStorage({ ...synthetic, endpoint: 'http://127.0.0.1:59607' }, { environment: { NODE_ENV: 'production' }, allowInsecureLocal: true })).not.toThrow();
    });
    it('keeps buckets distinct and prohibits URL credentials, paths and queries', () => {
        for (const endpoint of ['https://user:password@example.test', 'https://example.test/path', 'https://example.test?key=private', 'file:///tmp']) {
            expect(() => new ChatObjectStorage({ ...synthetic, endpoint })).toThrow();
        }
        expect(() => new ChatObjectStorage({ ...synthetic, personalBucket: synthetic.projectBucket })).toThrow();
        for (const projectBucket of ['UPPERCASE', '../bad', '1.2.3.4', 'a.-bad']) expect(() => new ChatObjectStorage({ ...synthetic, projectBucket })).toThrow();
    });
    it('allows the service pool to close after a failed cleanup worker; its durable outbox survives restart', async () => {
        const pool = { connect: vi.fn().mockRejectedValue(new Error('Synthetic database outage')) } as unknown as Pool;
        const storage = new ChatAttachmentStorage(pool, { objectStorage: new ChatObjectStorage(synthetic) });
        const pending = storage.collect().catch(() => undefined);
        await expect(storage.close()).resolves.toBeUndefined(); await pending;
    });
    it.each([
        { owner: 'owner-id', grantee: '<ID>owner-id</ID>', allowed: true },
        { owner: 'owner-id', grantee: '<ID>other-user</ID>', allowed: false },
        { owner: 'owner-id', grantee: '<URI>http://acs.amazonaws.com/groups/global/AllUsers</URI>', allowed: false },
        { owner: '', grantee: '<Type>CanonicalUser</Type>', allowed: true },
    ])('Checks Ceph owner grants and the exact MinIO private ACL representation %#', async ({ owner, grantee, allowed }) => {
        const objects = new ChatObjectStorage(synthetic);
        vi.spyOn(objects.client, 'bucketExists').mockResolvedValue(true); vi.spyOn(objects.client, 'getBucketPolicy').mockResolvedValue('');
        const xml = '<AccessControlPolicy><Owner><ID>' + owner + '</ID></Owner><AccessControlList><Grant><Grantee>' + grantee + '</Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>';
        vi.spyOn(objects.client, 'makeRequestAsync').mockImplementation(async () => Readable.from([xml]) as unknown as IncomingMessage);
        if (allowed) await expect(objects.initialize()).resolves.toBeUndefined(); else await expect(objects.initialize()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
});

describe.skipIf(!configFile || !pgUrl).sequential('Chat files — real isolated S3-compatible MinIO and PostgreSQL', () => {
    let admin: Pool, db: Pool, database: string, objects: ChatObjectStorage, storage: ChatAttachmentStorage, config: ChatS3Configuration;
    const upgrades: Array<{ name: string; db: Pool; storage?: ChatAttachmentStorage }> = [];
    const newDatabase = async (legacy = false): Promise<{ name: string; db: Pool }> => {
        const name = 'nc_chat_s3_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + name);
        const url = new URL(pgUrl!); url.pathname = '/' + name;
        const pool = new Pool({ connectionString: url.href, max: 5 });
        await pool.query('CREATE TABLE projects(id text PRIMARY KEY); CREATE TABLE model_catalog(id text PRIMARY KEY)');
        await pool.query(CHAT_SCHEMA_SQL);
        if (!legacy) await pool.query(CHAT_STORAGE_SCHEMA_SQL);
        await pool.query("INSERT INTO projects(id) VALUES('prj-storage'); INSERT INTO model_catalog(id) VALUES('model-storage')");
        return { name, db: pool };
    };
    const conversation = async (pool = db, project = 'prj-storage', owner = 'owner@example.test'): Promise<string> => {
        const id = randomUUID();
        await pool.query("INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,title,model_pin) VALUES($1,$2,'model-storage',$3,'Storage test',$4)", [id, owner, project || null, 'a'.repeat(64)]);
        return id;
    };
    const reference = async (id: string, pool = db) => (await pool.query('SELECT * FROM model_chat_objects WHERE id=$1', [id])).rows[0];
    const versions = async (bucket: string, key: string): Promise<number> => {
        const stream = objects.client.listObjects(bucket, key, true, { IncludeVersion: true }); let count = 0;
        try { for await (const raw of stream) if (raw.name === key) count++; } finally { stream.destroy(); } return count;
    };
    const persist = async (bytes: Buffer, projectId: string | null = 'prj-storage', ownerEmail = 'owner@example.test') => {
        const conversationId = await conversation(db, projectId ?? '', ownerEmail);
        const object = await storage.stage({ ownerEmail, projectId, conversationId, bytes, mediaType: 'text/plain' });
        const client = await db.connect(), id = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,object_id) VALUES($1,$2,$3,$4,'test.txt','text/plain',$5,'text',4,$6)", [id, conversationId, randomUUID(), 'b'.repeat(64), bytes.length, object.id]);
            await storage.activate(client, object); await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); await storage.abandon(object); throw error; } finally { client.release(); }
        return { id, conversationId, object, row: await reference(object.id) };
    };
    beforeAll(async () => {
        const url = new URL(pgUrl!); if (url.hostname !== '127.0.0.1' || url.port === '5432' || !url.port) throw new Error('Use an owned disposable PostgreSQL port.');
        url.pathname = '/postgres'; admin = new Pool({ connectionString: url.href, max: 1 });
        const input = JSON.parse(fs.readFileSync(configFile!, 'utf8')) as NodeJS.ProcessEnv, supplied = chatS3Configuration(input)!;
        const endpoint = new URL(supplied.endpoint); if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || !endpoint.port || endpoint.port === '19010') throw new Error('Use an explicit owned local S3 QA endpoint; the main19010 endpoint is forbidden.');
        const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
        config = { ...supplied, projectBucket: 'nc-chat-project-' + suffix, personalBucket: 'nc-chat-personal-' + suffix };
        objects = new ChatObjectStorage(config, { allowInsecureLocal: true });
        const created = await newDatabase(); database = created.name; db = created.db; storage = new ChatAttachmentStorage(db, { objectStorage: objects }); await storage.initialize();
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (db) { await db.query('DELETE FROM model_chat_conversations'); await db.query("UPDATE model_chat_objects SET lease_until=now()-interval '1 second' WHERE state='STAGING'"); await db.query("UPDATE model_chat_objects SET next_attempt_at=now() WHERE state IN ('DELETE','DELETED')"); await storage.collect(1000); }
    });
    afterAll(async () => {
        await storage?.close();
        for (const upgrade of upgrades) { await upgrade.storage?.close(); await upgrade.db.query('DELETE FROM model_chat_conversations'); await upgrade.db.end(); await admin.query('DROP DATABASE ' + upgrade.name); }
        if (objects) for (const bucket of [config.projectBucket, config.personalBucket]) {
            if (!await objects.client.bucketExists(bucket)) continue;
            const stream = objects.client.listObjects(bucket, '', true, { IncludeVersion: true });
            try { for await (const item of stream) if (item.name) await objects.client.removeObject(bucket, item.name, { versionId: item.versionId ?? 'null' }); } finally { stream.destroy(); }
            await objects.client.removeBucket(bucket);
        }
        await db?.end(); if (admin) { if (database) await admin.query('DROP DATABASE ' + database); await admin.end(); }
    });
    it('uses private project/personal buckets and owner-scoped keys without exposing a URL', async () => {
        const bytes = Buffer.from('Секретный документ'), project = await persist(bytes), personal = await persist(Buffer.from('Personal'), null);
        expect(Object.keys(project.object)).toEqual(['id']);
        expect(project.row.bucket).toBe(config.projectBucket); expect(personal.row.bucket).toBe(config.personalBucket);
        expect(project.row.object_key).toContain('projects/' + chatObjectDigest('prj-storage') + '/owners/' + chatObjectDigest('owner@example.test'));
        expect(project.row.object_key.includes('owner@example.test')).toBe(false); expect(project.row.sha256).toBe(chatObjectDigest(bytes));
        expect(await storage.read(project.object.id)).toEqual(bytes);
        const anonymous = await fetch(config.endpoint + '/' + project.row.bucket + '/' + project.row.object_key, { signal: AbortSignal.timeout(5000) });
        expect(anonymous.status).toBe(403); await anonymous.body?.cancel(); await assertChatStorageSchema(db);
        expect((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='model_chat_attachments' AND column_name='content'")).rowCount).toBe(0);
    });
    it('refuses existing anonymous bucket policies without rewriting them', async () => {
        const policy = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::' + config.personalBucket + '/*'] }] });
        await objects.client.setBucketPolicy(config.personalBucket, policy);
        try { await expect(objects.initialize()).rejects.toBeInstanceOf(ServiceUnavailableException); expect((await objects.client.getBucketPolicy(config.personalBucket)).includes('s3:GetObject')).toBe(true); }
        finally { await objects.client.setBucketPolicy(config.personalBucket, ''); }
    });
    it('rejects a file if a bucket becomes public after startup and still records its cleanup intent', async () => {
        const policy = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::' + config.personalBucket + '/*'] }] });
        await objects.client.setBucketPolicy(config.personalBucket, policy);
        try {
            const id = await conversation();
            await expect(storage.stage({ ownerEmail: 'owner@example.test', projectId: null, conversationId: id, bytes: Buffer.from('Never activate a public document'), mediaType: 'text/plain' })).rejects.toBeInstanceOf(ServiceUnavailableException);
            const row = (await db.query("SELECT * FROM model_chat_objects WHERE state='DELETE' ORDER BY created_at DESC LIMIT 1")).rows[0];
            expect(row).toBeTruthy(); await storage.collect(1000); expect(await versions(row.bucket, row.object_key)).toBe(0);
        } finally { await objects.client.setBucketPolicy(config.personalBucket, ''); }
    });
    it('verifies bytes and refuses configuration drift or a changed unversioned object', async () => {
        const saved = await persist(Buffer.from('Original document'));
        await objects.client.putObject(saved.row.bucket, saved.row.object_key, Buffer.from('Corrupt document'));
        await expect(storage.read(saved.object.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
        const other = new ChatObjectStorage({ ...config, personalBucket: config.personalBucket + '-other' }, { allowInsecureLocal: true });
        expect(() => other.reference(saved.row)).toThrow(ConflictException);
    });
    it('pins versioned objects and purges every version on conversation deletion', async () => {
        await objects.client.setBucketVersioning(config.projectBucket, { Status: 'Enabled' });
        const bytes = Buffer.from('Pinned original'), saved = await persist(bytes); expect(saved.row.version_id).toBeTruthy();
        await objects.client.putObject(saved.row.bucket, saved.row.object_key, Buffer.from('Later replacement'));
        expect(await storage.read(saved.object.id)).toEqual(bytes); expect(await versions(saved.row.bucket, saved.row.object_key)).toBe(2);
        await db.query('DELETE FROM model_chat_conversations WHERE id=$1', [saved.conversationId]);
        expect((await reference(saved.object.id)).state).toBe('DELETE'); expect(await storage.collect(1000)).toBeGreaterThan(0);
        expect(await versions(saved.row.bucket, saved.row.object_key)).toBe(0);
    });
    it('tracks a successful PUT whose acknowledgement is lost and cleans its exact nonce', async () => {
        const original = objects.put.bind(objects);
        vi.spyOn(objects, 'put').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Synthetic lost S3 acknowledgement'); });
        const id = await conversation(); await expect(storage.stage({ ownerEmail: 'owner@example.test', projectId: 'prj-storage', conversationId: id, bytes: Buffer.from('Lost acknowledgement'), mediaType: 'text/plain' })).rejects.toThrow();
        const row = (await db.query("SELECT * FROM model_chat_objects WHERE state='DELETE' ORDER BY created_at DESC LIMIT 1")).rows[0];
        expect(await versions(row.bucket, row.object_key)).toBe(1); await storage.collect(1000); expect(await versions(row.bucket, row.object_key)).toBe(0);
    });
    it('collects rolled-back DB writes and expired intents after a crashed uploader', async () => {
        const conversationId = await conversation(), object = await storage.stage({ ownerEmail: 'owner@example.test', projectId: null, conversationId, bytes: Buffer.from('Uncommitted'), mediaType: 'text/plain' });
        await expect(storage.activate(db as unknown as PoolClient, object)).rejects.toThrow(ConflictException);
        const client = await db.connect(); try {
            await client.query('BEGIN');
            await client.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,object_id) VALUES($1,$2,$3,$4,'rollback.txt','text/plain',11,'text',4,$5)", [randomUUID(), conversationId, randomUUID(), 'b'.repeat(64), object.id]);
            await storage.activate(client, object); await client.query('ROLLBACK');
        } finally { client.release(); }
        expect((await reference(object.id)).state).toBe('STAGING');
        await db.query("UPDATE model_chat_objects SET lease_until=now()-interval '1 second' WHERE id=$1", [object.id]);
        const row = await reference(object.id); await storage.collect(1000); expect((await reference(object.id)).state).toBe('DELETED'); expect(await versions(row.bucket, row.object_key)).toBe(0);
    });
    it('retains failed deletions in the durable outbox and retries without raw storage errors', async () => {
        const saved = await persist(Buffer.from('Delete after retry'));
        await db.query('DELETE FROM model_chat_attachments WHERE id=$1', [saved.id]);
        vi.spyOn(objects, 'remove').mockRejectedValueOnce(new Error('test-storage-secret must never be persisted'));
        await storage.collect(1000); const failed = await reference(saved.object.id);
        expect(failed.state).toBe('DELETE'); expect(failed.attempts).toBe(1); expect(failed.last_error.includes('test-storage-secret')).toBe(false);
        await db.query('UPDATE model_chat_objects SET next_attempt_at=now() WHERE id=$1', [saved.object.id]); await storage.collect(1000);
        expect((await reference(saved.object.id)).state).toBe('DELETED'); expect(await versions(saved.row.bucket, saved.row.object_key)).toBe(0);
    });
    it('project deletion queues files even though conversation and attachment rows cascade away', async () => {
        const saved = await persist(Buffer.from('Project cascade'));
        await db.query("DELETE FROM projects WHERE id='prj-storage'");
        expect((await reference(saved.object.id)).state).toBe('DELETE'); await storage.collect(1000); expect(await versions(saved.row.bucket, saved.row.object_key)).toBe(0);
        await db.query("INSERT INTO projects(id) VALUES('prj-storage')");
    });
    it('resumes a failed bytea upgrade, verifies S3, then removes the transfer payload without a read fallback', async () => {
        const upgrade = await newDatabase(true); upgrades.push(upgrade); const id = await conversation(upgrade.db), bytes = Buffer.from('Legacy bytes preserved until S3 commit'), aid = randomUUID();
        await upgrade.db.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,content,text,text_bytes) VALUES($1,$2,$3,$4,'old.txt','text/plain',$5,$6,'old',3)", [aid, id, randomUUID(), 'd'.repeat(64), bytes.length, bytes]);
        await upgrade.db.query(CHAT_STORAGE_SCHEMA_SQL); const migrated = new ChatAttachmentStorage(upgrade.db, { objectStorage: objects }); upgrade.storage = migrated;
        vi.spyOn(objects, 'put').mockRejectedValueOnce(new ServiceUnavailableException('Synthetic S3 outage'));
        await expect(migrated.initialize()).rejects.toThrow();
        expect((await upgrade.db.query('SELECT content FROM model_chat_attachment_transfers WHERE attachment_id=$1', [aid])).rows[0].content).toEqual(bytes);
        expect((await upgrade.db.query('SELECT storage_state,object_id FROM model_chat_attachments WHERE id=$1', [aid])).rows[0]).toEqual({ storage_state: 'TRANSFER', object_id: null });
        await migrated.initialize(); const row = (await upgrade.db.query('SELECT object_id,storage_state FROM model_chat_attachments WHERE id=$1', [aid])).rows[0];
        expect(row.storage_state).toBe('S3'); expect(await migrated.read(row.object_id)).toEqual(bytes); expect((await upgrade.db.query('SELECT 1 FROM model_chat_attachment_transfers')).rowCount).toBe(0);
        await assertChatStorageSchema(upgrade.db); await upgrade.db.query('DELETE FROM model_chat_conversations'); await migrated.collect(1000);
    });
    it('keeps old bytes durable when S3 is not configured or their migration checksum is damaged', async () => {
        const upgrade = await newDatabase(true); upgrades.push(upgrade); const id = await conversation(upgrade.db), bytes = Buffer.from('Old bytes'), aid = randomUUID();
        await upgrade.db.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,content,text,text_bytes) VALUES($1,$2,$3,$4,'old.txt','text/plain',$5,$6,'old',3)", [aid, id, randomUUID(), 'd'.repeat(64), bytes.length, bytes]);
        await upgrade.db.query(CHAT_STORAGE_SCHEMA_SQL);
        const saved = Object.fromEntries(['CHAT_S3_ENDPOINT', 'CHAT_S3_ACCESS_KEY', 'CHAT_S3_SECRET_KEY', 'CHAT_S3_PROJECT_BUCKET', 'CHAT_S3_PERSONAL_BUCKET'].map(key => [key, process.env[key]]));
        let missing: ChatAttachmentStorage;
        try {
            for (const key of Object.keys(saved)) delete process.env[key]; missing = new ChatAttachmentStorage(upgrade.db);
        } finally { for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value; }
        await expect(missing!.initialize()).rejects.toThrow('Исходные данные сохранены');
        await upgrade.db.query("UPDATE model_chat_attachment_transfers SET sha256=$2 WHERE attachment_id=$1", [aid, '0'.repeat(64)]);
        const migrated = new ChatAttachmentStorage(upgrade.db, { objectStorage: objects });
        await expect(migrated.initialize()).rejects.toThrow('Контрольная сумма');
        expect((await upgrade.db.query('SELECT content FROM model_chat_attachment_transfers WHERE attachment_id=$1', [aid])).rows[0].content).toEqual(bytes);
        expect((await upgrade.db.query('SELECT object_id FROM model_chat_attachments WHERE id=$1', [aid])).rows[0].object_id).toBeNull();
    });
    it('detects schema drift without modifying it', async () => {
        const client = await db.connect(); try { await client.query('BEGIN'); await client.query('DROP TRIGGER model_chat_attachment_delete_object ON model_chat_attachments'); await expect(assertChatStorageSchema(client as unknown as Pool)).rejects.toThrow('model_chat_attachment_delete_object'); }
        finally { await client.query('ROLLBACK'); client.release(); } await assertChatStorageSchema(db);
    });
});
