import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ChatObjectStorage, chatObjectDigest, chatS3Configuration, type ChatObjectReference } from './chat-object-storage';

type Db = Pick<PoolClient, 'query'>;
export interface ChatStagedObject { id: string }
interface ObjectRow extends ChatObjectReference { id: string; state: 'STAGING' | 'LIVE' | 'DELETE' | 'DELETED'; attempts: number }
interface StageInput { ownerEmail: string; projectId: string | null; conversationId: string; bytes: Buffer; mediaType: string }
const unavailable = (): ServiceUnavailableException => new ServiceUnavailableException('Подключите закрытое хранилище Ceph/S3 для файлов чата.');

/** A durable write intent precedes S3 PUT; deletion outbox survives attachment/project cascades. */
export class ChatAttachmentStorage {
    private readonly objects: ChatObjectStorage | null;
    private timer?: NodeJS.Timeout;
    private collecting?: Promise<number>;
    constructor(private readonly pool: Pool, options: { objectStorage?: ChatObjectStorage } = {}) {
        const config = options.objectStorage ? null : chatS3Configuration();
        this.objects = options.objectStorage ?? (config ? new ChatObjectStorage(config) : null);
    }
    async initialize(): Promise<void> {
        if (!this.objects) {
            const pending = await this.pool.query('SELECT 1 FROM model_chat_attachment_transfers LIMIT 1');
            if (pending.rowCount) throw new ServiceUnavailableException('Подключите Ceph/S3, чтобы завершить перенос существующих файлов чата. Исходные данные сохранены.');
            return;
        }
        await this.objects.initialize(); await this.migrateTransfers(); await this.collect();
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => { if (!this.collecting) void this.collect().catch(() => undefined); }, 30000);
        this.timer.unref();
    }
    async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.collecting?.catch(() => undefined); }
    /** Transfer recovery reuses its held session; the durable intent still precedes the attachment activation transaction. */
    async stage(input: StageInput, signal?: AbortSignal, db: Db = this.pool): Promise<ChatStagedObject> {
        if (!this.objects) throw unavailable();
        if (!input.ownerEmail || !/^[a-f0-9-]{36}$/i.test(input.conversationId) || !Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > 10 * 1024 ** 2) throw new ConflictException('Некорректная область или размер файла.');
        signal?.throwIfAborted();
        const id = randomUUID(), row: ObjectRow = { id, storage_id: this.objects.storageId,
            bucket: input.projectId ? this.objects.config.projectBucket : this.objects.config.personalBucket,
            object_key: (input.projectId ? 'projects/' + chatObjectDigest(input.projectId) + '/' : '') + 'owners/' + chatObjectDigest(input.ownerEmail)
                + '/chats/' + input.conversationId.toLowerCase() + '/' + id,
            version_id: null, sha256: chatObjectDigest(input.bytes), bytes: input.bytes.length, state: 'STAGING', attempts: 0 };
        await db.query(`INSERT INTO model_chat_objects(id,storage_id,bucket,object_key,sha256,bytes,state,lease_until)
            VALUES($1,$2,$3,$4,$5,$6,'STAGING',now()+interval '20 minutes')`, [id, row.storage_id, row.bucket, row.object_key, row.sha256, row.bytes]);
        try {
            row.version_id = await this.objects.put(row, input.bytes, signal);
            await db.query("UPDATE model_chat_objects SET version_id=$2 WHERE id=$1 AND state='STAGING'", [id, row.version_id]);
            await this.objects.read(row, signal); await this.objects.assertPrivate(row, signal); signal?.throwIfAborted(); return { id };
        } catch (error) { await this.abandon({ id }, db).catch(() => undefined); throw error; }
    }
    /** Called after attachment INSERT in its transaction, so a rolled-back DB commit leaves a collectible intent. */
    async activate(db: Db, object: ChatStagedObject): Promise<void> {
        if (!this.objects) throw unavailable();
        const result = await db.query(`UPDATE model_chat_objects SET state='LIVE',lease_until=NULL WHERE id=$1 AND storage_id=$2 AND state='STAGING' AND lease_until>now()
            AND EXISTS(SELECT 1 FROM model_chat_attachments a WHERE a.object_id=model_chat_objects.id AND a.deleted_at IS NULL AND a.storage_state='S3' AND a.bytes=model_chat_objects.bytes)
            RETURNING id`, [object.id, this.objects.storageId]);
        if (!result.rowCount) throw new ConflictException('Передача файла истекла или была отменена. Загрузите файл повторно.');
    }
    async abandon(object: ChatStagedObject, db: Db = this.pool): Promise<void> {
        await db.query("UPDATE model_chat_objects SET state='DELETE',lease_until=NULL,next_attempt_at=now() WHERE id=$1 AND state='STAGING' AND NOT EXISTS(SELECT 1 FROM model_chat_attachments WHERE object_id=$1)", [object.id]);
    }
    async read(objectId: string, signal?: AbortSignal): Promise<Buffer> {
        if (!this.objects) throw unavailable();
        const row = (await this.pool.query<ObjectRow>("SELECT * FROM model_chat_objects WHERE id=$1 AND state='LIVE'", [objectId])).rows[0];
        if (!row) throw new ServiceUnavailableException('Файл недоступен в хранилище.'); return this.objects.read(row, signal);
    }
    /** Tombstones are retained and rechecked, including objects with an uncertain/lost PUT acknowledgement. */
    async collect(limit = 20): Promise<number> {
        if (!this.objects) return 0;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Некорректный размер пакета очистки.');
        const previous = this.collecting;
        const work = (previous ? previous.catch(() => 0) : Promise.resolve()).then(() => this.collectBatch(limit));
        this.collecting = work;
        try { return await work; } finally { if (this.collecting === work) this.collecting = undefined; }
    }
    private async collectBatch(limit: number): Promise<number> {
        if (!this.objects) return 0;
        const db = await this.pool.connect(); let locked = false, completed = 0;
        try {
            locked = (await db.query("SELECT pg_try_advisory_lock(hashtextextended('model-chat-object-cleanup',0)) AS locked")).rows[0].locked;
            if (!locked) return 0;
            const rows = (await db.query<ObjectRow>(`SELECT * FROM model_chat_objects WHERE
                ((state IN ('DELETE','DELETED') AND next_attempt_at<=now()) OR (state='STAGING' AND lease_until<=now()))
                AND NOT EXISTS(SELECT 1 FROM model_chat_attachments WHERE object_id=model_chat_objects.id)
                ORDER BY next_attempt_at,id LIMIT $1`, [limit])).rows;
            for (const row of rows) {
                await db.query("UPDATE model_chat_objects SET state='DELETE',lease_until=NULL WHERE id=$1", [row.id]);
                try {
                    await this.objects.remove(row);
                    await db.query("UPDATE model_chat_objects SET state='DELETED',next_attempt_at=now()+interval '1 day',attempts=0,last_error=NULL WHERE id=$1", [row.id]); completed++;
                } catch {
                    const seconds = Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7));
                    await db.query("UPDATE model_chat_objects SET attempts=LEAST(attempts+1,2147483647),next_attempt_at=now()+make_interval(secs=>$2),last_error='Удаление файла из Ceph/S3 не подтверждено.' WHERE id=$1", [row.id, seconds]);
                }
            }
            return completed;
        } finally { if (locked) await db.query("SELECT pg_advisory_unlock(hashtextextended('model-chat-object-cleanup',0))").catch(() => undefined); db.release(); }
    }
    /** Upgrade payloads are deleted only after S3 read-back, checksum validation and a committed reference. */
    private async migrateTransfers(): Promise<void> {
        const db = await this.pool.connect(); let locked = false;
        try {
            await db.query("SELECT pg_advisory_lock(hashtextextended('model-chat-attachment-transfer',0))"); locked = true;
            await db.query('DELETE FROM model_chat_attachment_transfers t USING model_chat_attachments a WHERE a.id=t.attachment_id AND a.deleted_at IS NOT NULL');
            for (;;) {
                const source = (await db.query<{ attachment_id: string; content: Buffer; sha256: string; bytes: number; owner_email: string; project_id: string | null; conversation_id: string; media_type: string }>(`SELECT t.*,a.conversation_id,a.media_type,c.owner_email,c.project_id
                    FROM model_chat_attachment_transfers t JOIN model_chat_attachments a ON a.id=t.attachment_id
                    JOIN model_chat_conversations c ON c.id=a.conversation_id ORDER BY t.attachment_id LIMIT 1`)).rows[0];
                if (!source) return;
                if (source.content.length !== source.bytes || chatObjectDigest(source.content) !== source.sha256) throw new ServiceUnavailableException('Контрольная сумма переносимого файла не совпала. Исходные данные сохранены.');
                const object = await this.stage({ ownerEmail: source.owner_email, projectId: source.project_id, conversationId: source.conversation_id, bytes: source.content, mediaType: source.media_type }, undefined, db);
                try {
                    await db.query('BEGIN');
                    const current = await db.query("SELECT id FROM model_chat_attachments WHERE id=$1 AND storage_state='TRANSFER' AND deleted_at IS NULL FOR UPDATE", [source.attachment_id]);
                    if (!current.rowCount) { await db.query('ROLLBACK'); await this.abandon(object, db); continue; }
                    await db.query("UPDATE model_chat_attachments SET object_id=$2,storage_state='S3' WHERE id=$1", [source.attachment_id, object.id]);
                    await this.activate(db, object); await db.query('DELETE FROM model_chat_attachment_transfers WHERE attachment_id=$1', [source.attachment_id]); await db.query('COMMIT');
                } catch (error) { await db.query('ROLLBACK').catch(() => undefined); await this.abandon(object, db).catch(() => undefined); throw error; }
            }
        } finally { if (locked) await db.query("SELECT pg_advisory_unlock(hashtextextended('model-chat-attachment-transfer',0))").catch(() => undefined); db.release(); }
    }
}
