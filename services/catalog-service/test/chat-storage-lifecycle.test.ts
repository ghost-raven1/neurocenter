import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStorage } from '../src/model-chat/chat-attachment-storage';
import { ChatObjectStorage, chatObjectDigest, chatS3Configuration } from '../src/model-chat/chat-object-storage';
import { CHAT_SCHEMA_SQL } from '../src/model-chat/chat.schema';
import { CHAT_STORAGE_SCHEMA_SQL } from '../src/model-chat/chat-storage.schema';

const pgUrl = process.env.CHAT_OBJECT_STORAGE_TEST_PG_URL, configFile = process.env.CHAT_OBJECT_STORAGE_TEST_CONFIG;

describe.skipIf(!pgUrl || !configFile)('Chat transfer recovery with one PostgreSQL connection and own S3', () => {
    let admin: Pool, db: Pool, objects: ChatObjectStorage, storage: ChatAttachmentStorage, database: string;
    const bytes = Buffer.from('Original transfer payload survives until its verified S3 reference commits.'), attachmentId = randomUUID();
    const privacyObservations: unknown[] = [];
    const pendingTransfer = async (content: Buffer) => {
        const id = randomUUID(), conversationId = (await db.query('SELECT id FROM model_chat_conversations')).rows[0].id;
        await db.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,storage_state) VALUES($1,$2,$3,$4,'transfer.txt','text/plain',$5,'pending',7,'TRANSFER')", [id, conversationId, randomUUID(), 'c'.repeat(64), content.length]);
        await db.query('INSERT INTO model_chat_attachment_transfers(attachment_id,content,sha256,bytes) VALUES($1,$2,$3,$4)', [id, content, chatObjectDigest(content), content.length]);
        return id;
    };
    beforeAll(async () => {
        const url = new URL(pgUrl!);
        if (url.hostname !== '127.0.0.1' || url.port !== '59616') throw new Error('This audit requires the existing own QA PostgreSQL59616.');
        const supplied = chatS3Configuration(JSON.parse(readFileSync(configFile!, 'utf8')))!;
        const endpoint = new URL(supplied.endpoint);
        if (endpoint.origin !== 'http://127.0.0.1:59617') throw new Error('This audit requires the existing own S3 QA59617.');
        url.pathname = '/postgres'; admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_chat_ceph_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database); url.pathname = '/' + database;
        db = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 500 });
        await db.query('CREATE TABLE projects(id text PRIMARY KEY); CREATE TABLE model_catalog(id text PRIMARY KEY)');
        await db.query(CHAT_SCHEMA_SQL); await db.query("INSERT INTO projects(id) VALUES('prj-storage'); INSERT INTO model_catalog(id) VALUES('model-storage')");
        const conversationId = randomUUID();
        await db.query("INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,title,model_pin) VALUES($1,'owner@example.test','model-storage','prj-storage','Transfer recovery',$2)", [conversationId, 'a'.repeat(64)]);
        await db.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,content,text,text_bytes) VALUES($1,$2,$3,$4,'old.txt','text/plain',$5,$6,'old',3)", [attachmentId, conversationId, randomUUID(), 'b'.repeat(64), bytes.length, bytes]);
        await db.query(CHAT_STORAGE_SCHEMA_SQL);
        const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
        objects = new ChatObjectStorage({ ...supplied, projectBucket: 'nc-ceph-project-' + suffix, personalBucket: 'nc-ceph-personal-' + suffix }, { allowInsecureLocal: true });
        storage = new ChatAttachmentStorage(db, { objectStorage: objects });
    });
    afterAll(async () => {
        await storage?.close();
        const transfers = db ? (await db.query('SELECT bytes,sha256 FROM model_chat_attachment_transfers')).rows : [];
        if (objects) for (const bucket of [objects.config.projectBucket, objects.config.personalBucket]) {
            if (!await objects.client.bucketExists(bucket)) continue;
            const stream = objects.client.listObjects(bucket, '', true, { IncludeVersion: true });
            try { for await (const item of stream) if (item.name) await objects.client.removeObject(bucket, item.name, { versionId: item.versionId ?? 'null' }); }
            finally { stream.destroy(); }
            await objects.client.removeBucket(bucket);
        }
        await db?.end(); if (database) await admin.query('DROP DATABASE ' + database); await admin?.end();
        if (process.env.CHAT_STORAGE_AUDIT_CLEANUP) writeFileSync(process.env.CHAT_STORAGE_AUDIT_CLEANUP, JSON.stringify({ database, ordinaryDrop: true, bucketsRemoved: true, transfers, privacyObservations, mainTouched: false }, null, 2));
    });
    it('migrates and verifies a transfer without acquiring its own already-borrowed pool again', async () => {
        const url = new URL(pgUrl!); url.pathname = '/' + database; const observer = new Pool({ connectionString: url.href, max: 1 }), original = objects.put.bind(objects);
        const put = vi.spyOn(objects, 'put').mockImplementationOnce(async (...args) => {
            // A different physical connection must already see the committed intent before any object upload starts.
            const intent = (await observer.query('SELECT state,sha256,bytes FROM model_chat_objects WHERE object_key=$1', [args[0].object_key])).rows[0];
            expect(intent).toEqual({ state: 'STAGING', sha256: chatObjectDigest(bytes), bytes: bytes.length });
            expect((await observer.query('SELECT content FROM model_chat_attachment_transfers WHERE attachment_id=$1', [attachmentId])).rows[0].content).toEqual(bytes);
            return original(...args);
        });
        try { await expect(storage.initialize()).resolves.toBeUndefined(); }
        finally { put.mockRestore(); await observer.end(); }
        const row = (await db.query('SELECT object_id,storage_state FROM model_chat_attachments WHERE id=$1', [attachmentId])).rows[0];
        expect(row.storage_state).toBe('S3'); expect(await storage.read(row.object_id)).toEqual(bytes);
        expect((await db.query('SELECT attachment_id FROM model_chat_attachment_transfers')).rows).toEqual([]);
        expect((await db.query('SELECT state,sha256 FROM model_chat_objects WHERE id=$1', [row.object_id])).rows[0]).toEqual({ state: 'LIVE', sha256: chatObjectDigest(bytes) });
    });
    it('rejects version-read permissions granted anonymously after startup', async () => {
        await storage.initialize(); await objects.client.setBucketVersioning(objects.config.projectBucket, { Status: 'Enabled' });
        const conversationId = (await db.query('SELECT id FROM model_chat_conversations')).rows[0].id;
        const original = objects.assertPrivate.bind(objects); let failure: unknown, key: string | undefined;
        const guard = vi.spyOn(objects, 'assertPrivate').mockImplementationOnce(async (reference, signal) => {
            key = reference.object_key; expect(reference.version_id).toBeTruthy();
            const policy = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObjectVersion'], Resource: ['arn:aws:s3:::' + reference.bucket + '/*'] }] });
            await objects.client.setBucketPolicy(reference.bucket, policy);
            const current = await fetch(objects.config.endpoint + '/' + reference.bucket + '/' + reference.object_key, { method: 'HEAD' });
            const exactUrl = new URL('/' + reference.bucket + '/' + reference.object_key, objects.config.endpoint); exactUrl.searchParams.set('versionId', reference.version_id!);
            const version = await fetch(exactUrl); await version.body?.cancel(); await current.body?.cancel();
            privacyObservations.push({ currentHeadStatus: current.status, exactVersionGetStatus: version.status });
            // MinIO applies its version-read grant to the current HEAD too; this is a confirmed public object, not a hidden-version bypass.
            expect(current.status).toBe(200); expect(version.status).toBe(200);
            return original(reference, signal);
        });
        try { await storage.stage({ ownerEmail: 'owner@example.test', projectId: 'prj-storage', conversationId, bytes: Buffer.from('Public-version fixture'), mediaType: 'text/plain' }); }
        catch (error) { failure = error; }
        finally { await objects.client.setBucketPolicy(objects.config.projectBucket, ''); guard.mockRestore(); }
        expect(failure).toBeInstanceOf(ServiceUnavailableException);
        expect((await db.query('SELECT state FROM model_chat_objects WHERE object_key=$1', [key])).rows[0].state).toBe('DELETE');
    });
    it('does not create an intent or perform PUT for an already cancelled upload', async () => {
        const before = (await db.query('SELECT id FROM model_chat_objects ORDER BY id')).rows, abort = new AbortController();
        abort.abort(new Error('caller stopped upload'));
        const put = vi.spyOn(objects, 'put');
        try {
            const conversationId = (await db.query('SELECT id FROM model_chat_conversations')).rows[0].id;
            await expect(storage.stage({ ownerEmail: 'owner@example.test', projectId: 'prj-storage', conversationId, bytes: Buffer.from('cancelled'), mediaType: 'text/plain' }, abort.signal)).rejects.toBe(abort.signal.reason);
            expect(put).not.toHaveBeenCalled(); expect((await db.query('SELECT id FROM model_chat_objects ORDER BY id')).rows).toEqual(before);
        } finally { put.mockRestore(); }
    });
    it('collects an acknowledged PUT cancelled before activation while preserving committed references', async () => {
        await storage.initialize();
        const conversationId = (await db.query('SELECT id FROM model_chat_conversations')).rows[0].id, abort = new AbortController(), original = objects.put.bind(objects), stopped = new Error('cancel-after-put');
        const put = vi.spyOn(objects, 'put').mockImplementationOnce(async (...args) => { const version = await original(...args); abort.abort(stopped); return version; });
        try {
            await expect(storage.stage({ ownerEmail: 'owner@example.test', projectId: 'prj-storage', conversationId, bytes: Buffer.from('Acknowledged then cancelled'), mediaType: 'text/plain' }, abort.signal)).rejects.toBe(stopped);
            const row = (await db.query("SELECT * FROM model_chat_objects WHERE state='DELETE' ORDER BY created_at DESC LIMIT 1")).rows[0];
            expect(row).toBeTruthy(); await storage.collect(1000);
            expect((await db.query('SELECT state FROM model_chat_objects WHERE id=$1', [row.id])).rows[0].state).toBe('DELETED');
            const stream = objects.client.listObjects(row.bucket, row.object_key, true, { IncludeVersion: true }), versions: string[] = [];
            try { for await (const item of stream) if (item.name === row.object_key) versions.push(item.versionId ?? 'null'); } finally { stream.destroy(); }
            expect(versions).toEqual([]);
            const live = (await db.query('SELECT object_id FROM model_chat_attachments WHERE id=$1', [attachmentId])).rows[0];
            expect(await storage.read(live.object_id)).toEqual(bytes);
        } finally { put.mockRestore(); }
    });
    it('keeps transfer bytes after S3 fails and retries safely with the same single-connection pool', async () => {
        await storage.initialize(); const content = Buffer.from('Preserve these bytes across an S3 outage'), id = await pendingTransfer(content), failure = new Error('private-S3-credential-detail');
        const put = vi.spyOn(objects, 'put').mockRejectedValueOnce(failure);
        try {
            await expect(storage.initialize()).rejects.toBe(failure);
            expect((await db.query('SELECT content FROM model_chat_attachment_transfers WHERE attachment_id=$1', [id])).rows[0].content).toEqual(content);
            expect((await db.query('SELECT storage_state,object_id FROM model_chat_attachments WHERE id=$1', [id])).rows[0]).toEqual({ storage_state: 'TRANSFER', object_id: null });
            expect((await db.query("SELECT last_error FROM model_chat_objects WHERE state='DELETE'")).rows.every(row => !String(row.last_error).includes('credential'))).toBe(true);
        } finally { put.mockRestore(); }
        await storage.initialize(); const row = (await db.query('SELECT object_id FROM model_chat_attachments WHERE id=$1', [id])).rows[0];
        expect(await storage.read(row.object_id)).toEqual(content);
        expect((await db.query('SELECT attachment_id FROM model_chat_attachment_transfers WHERE attachment_id=$1', [id])).rows).toEqual([]);
    });
    it('abandons an uploaded transfer if its attachment was concurrently deleted before activation', async () => {
        await storage.initialize(); const content = Buffer.from('Concurrent removal fixture'), id = await pendingTransfer(content);
        const url = new URL(pgUrl!); url.pathname = '/' + database; const peer = new Pool({ connectionString: url.href, max: 1 });
        const original = objects.put.bind(objects); let key: string | undefined;
        const put = vi.spyOn(objects, 'put').mockImplementationOnce(async (...args) => {
            const version = await original(...args); key = args[0].object_key;
            await peer.query('DELETE FROM model_chat_attachments WHERE id=$1', [id]); return version;
        });
        try {
            await expect(storage.initialize()).resolves.toBeUndefined();
            expect((await db.query('SELECT id FROM model_chat_attachments WHERE id=$1', [id])).rows).toEqual([]);
            expect((await db.query('SELECT attachment_id FROM model_chat_attachment_transfers WHERE attachment_id=$1', [id])).rows).toEqual([]);
            expect((await db.query('SELECT state FROM model_chat_objects WHERE object_key=$1', [key])).rows[0].state).toBe('DELETED');
        } finally { put.mockRestore(); await peer.end(); }
    });
    it('rejects an expired staging lease without committing a dangling attachment reference', async () => {
        await storage.initialize(); const conversationId = (await db.query('SELECT id FROM model_chat_conversations')).rows[0].id;
        const object = await storage.stage({ ownerEmail: 'owner@example.test', projectId: null, conversationId, bytes: Buffer.from('Expired stage'), mediaType: 'text/plain' });
        await db.query("UPDATE model_chat_objects SET lease_until=now()-interval '1 second' WHERE id=$1", [object.id]);
        const client = await db.connect(), id = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query("INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,object_id) VALUES($1,$2,$3,$4,'expired.txt','text/plain',13,'expired',7,$5)", [id, conversationId, randomUUID(), 'd'.repeat(64), object.id]);
            await expect(storage.activate(client, object)).rejects.toBeInstanceOf(ConflictException);
        } finally { await client.query('ROLLBACK'); client.release(); }
        expect((await db.query('SELECT id FROM model_chat_attachments WHERE id=$1', [id])).rows).toEqual([]);
        await storage.collect(1000);
        expect((await db.query('SELECT state FROM model_chat_objects WHERE id=$1', [object.id])).rows[0].state).toBe('DELETED');
        await expect(storage.read(object.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
    it('does not start a second garbage collector while another worker owns the cleanup lock', async () => {
        await storage.initialize(); const url = new URL(pgUrl!); url.pathname = '/' + database;
        const peer = new Pool({ connectionString: url.href, max: 1 }), held = await peer.connect(), remove = vi.spyOn(objects, 'remove');
        try {
            await held.query("SELECT pg_advisory_lock(hashtextextended('model-chat-object-cleanup',0))");
            expect(await storage.collect(1000)).toBe(0); expect(remove).not.toHaveBeenCalled();
        } finally { await held.query("SELECT pg_advisory_unlock(hashtextextended('model-chat-object-cleanup',0))"); held.release(); await peer.end(); remove.mockRestore(); }
    });
});
