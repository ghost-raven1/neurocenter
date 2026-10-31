import {
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { chatObjectDigest } from '../model-chat/chat-object-storage';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { DiscussionsRepository } from './discussions.repository';
import { DiscussionsPolicy } from './discussions.policy';
import {
    DiscussionsStorage,
    discussionAttachmentView,
    discussionFileContent,
    discussionFileName,
} from './discussions.storage';
import { discussionTarget, discussionUuid } from './discussions.validation';
import type { AttachmentRow } from './discussions.types';

/** Durable upload intents and tombstones keep failed uploads collectible without exposing object keys. */
@Injectable()
export class DiscussionAttachments implements OnModuleInit, OnModuleDestroy {
    private timer?: NodeJS.Timeout;
    private cleaning = false;
    private readonly active = new Set<AbortController>();
    constructor(
        private readonly repository: DiscussionsRepository,
        private readonly policy: DiscussionsPolicy,
        private readonly storage: DiscussionsStorage,
    ) {}
    onModuleInit() {
        this.timer = setInterval(() => {
            void this.reap().catch(() => undefined);
        }, 60000);
        this.timer.unref();
    }
    onModuleDestroy() {
        clearInterval(this.timer);
        for (const controller of this.active) controller.abort();
    }
    async upload(req: Request, signal?: AbortSignal) {
        const target = discussionTarget(req.query.targetType, req.query.targetId),
            identity = this.policy.input(req),
            actor = await this.policy.actor(this.repository.pool, identity);
        await this.policy.target(this.repository.pool, actor, target, true);
        const request = discussionUuid(req.headers['x-request-key']),
            file = discussionFileName(req.headers['x-file-name']);
        if (this.active.size >= 2) throw new ConflictException('Дождитесь завершения текущих загрузок.');
        const controller = new AbortController(),
            abort = (): void => controller.abort();
        this.active.add(controller);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        try {
            const bytes = await this.storage.consume(req, req.headers['content-length'], controller.signal);
            discussionFileContent(bytes, file.mediaType);
            const digest = chatObjectDigest(bytes);
            const row = await this.repository.transaction(async (db) => {
                const current = await this.policy.actor(db, identity, true);
                await this.policy.target(db, current, target);
                await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72465437))', [
                    'attachment-quota:' + current.email,
                ]);
                await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72465436))', [
                    'attachment:' + current.email + ':' + request,
                ]);
                const prior = (
                    await db.query<AttachmentRow>(
                        'SELECT * FROM discussion_attachments WHERE owner_email=$1 AND request_key=$2 FOR UPDATE',
                        [current.email, request],
                    )
                ).rows[0];
                if (prior) {
                    if (
                        prior.target_type !== target.type ||
                        prior.target_id !== target.id ||
                        prior.name !== file.name ||
                        prior.bytes !== bytes.length ||
                        prior.sha256 !== digest
                    )
                        throw new ConflictException('Этот ключ уже использован для другого файла.');
                    if (prior.state === 'DELETED' || prior.state === 'PURGED')
                        throw new ConflictException('Загрузка удалена. Выберите файл заново.');
                    return prior;
                }
                await requireFeaturesEnabled(['discussions', 'discussion_attachments']);
                await this.policy.target(db, current, target, true);
                // This bound includes unfinished uploads and prevents an abandoned draft from filling storage.
                const quota = (
                    await db.query<{ count: string; bytes: string }>(
                        "SELECT count(*) AS count,COALESCE(sum(bytes),0) AS bytes FROM discussion_attachments WHERE owner_email=$1 AND comment_id IS NULL AND state IN ('UPLOADING','READY')",
                        [current.email],
                    )
                ).rows[0];
                if (Number(quota.count) >= 20 || Number(quota.bytes) + bytes.length > 100 * 1024 ** 2)
                    throw new ConflictException('Удалите ненужные черновые вложения: лимит 20 файлов и 100 МиБ.');
                const id = randomUUID(),
                    object = this.storage.intent(id, current.email, target.type + ':' + target.id, bytes);
                return (
                    await db.query<AttachmentRow>(
                        `INSERT INTO discussion_attachments(id,target_type,target_id,owner_email,name,media_type,bytes,sha256,storage_id,bucket,object_key,state,request_key)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'UPLOADING',$12) RETURNING *`,
                        [
                            id,
                            target.type,
                            target.id,
                            current.email,
                            file.name,
                            file.mediaType,
                            bytes.length,
                            digest,
                            object.storage_id,
                            object.bucket,
                            object.object_key,
                            request,
                        ],
                    )
                ).rows[0];
            });
            if (row.state === 'READY') return discussionAttachmentView(row);
            const lease = await this.repository.pool.connect();
            let held = false,
                discard = true;
            try {
                held = !!(
                    await lease.query<{ locked: boolean }>(
                        'SELECT pg_try_advisory_lock(hashtextextended($1,72465438)) AS locked',
                        [row.id],
                    )
                ).rows[0]?.locked;
                discard = false;
                if (!held)
                    throw new ConflictException(
                        'Этот файл уже загружается. Дождитесь завершения и повторите с тем же ключом.',
                    );
                const current = (
                    await lease.query<AttachmentRow>('SELECT * FROM discussion_attachments WHERE id=$1', [row.id])
                ).rows[0];
                if (current?.state === 'READY') return discussionAttachmentView(current);
                if (current?.state !== 'UPLOADING')
                    throw new ConflictException('Загрузка отменена. Выберите файл заново.');
                await requireFeaturesEnabled(['discussions', 'discussion_attachments']);
                const version = await this.storage.put(current, bytes, controller.signal);
                const ready = await this.repository.transaction(async (db) => {
                    const fresh = await this.policy.actor(db, identity, true);
                    await this.policy.target(db, fresh, target, true);
                    await requireFeaturesEnabled(['discussions', 'discussion_attachments']);
                    const saved = (
                        await db.query<AttachmentRow>(
                            "UPDATE discussion_attachments SET state='READY',version_id=$2 WHERE id=$1 AND state='UPLOADING' RETURNING *",
                            [row.id, version],
                        )
                    ).rows[0];
                    if (!saved) throw new ConflictException('Загрузка отменена. Выберите файл заново.');
                    return saved;
                });
                return discussionAttachmentView(ready);
            } finally {
                if (held) {
                    try {
                        if (
                            !(
                                await lease.query<{ unlocked: boolean }>(
                                    'SELECT pg_advisory_unlock(hashtextextended($1,72465438)) AS unlocked',
                                    [row.id],
                                )
                            ).rows[0]?.unlocked
                        )
                            discard = true;
                    } catch {
                        discard = true;
                    }
                }
                lease.release(discard);
            }
        } finally {
            signal?.removeEventListener('abort', abort);
            this.active.delete(controller);
        }
    }
    private async visible(req: Request, id: string): Promise<AttachmentRow> {
        discussionUuid(id);
        const actor = await this.policy.actor(this.repository.pool, this.policy.input(req));
        const row = (
            await this.repository.pool.query<AttachmentRow>('SELECT * FROM discussion_attachments WHERE id=$1', [id])
        ).rows[0];
        if (!row || row.state !== 'READY' || (!row.comment_id && row.owner_email !== actor.email))
            throw new NotFoundException('Вложение не найдено.');
        await this.policy.target(this.repository.pool, actor, { type: row.target_type, id: row.target_id });
        if (
            row.comment_id &&
            !(
                await this.repository.pool.query(
                    'SELECT 1 FROM discussion_comments WHERE id=$1 AND deleted_at IS NULL',
                    [row.comment_id],
                )
            ).rowCount
        )
            throw new NotFoundException('Комментарий удалён.');
        return row;
    }
    async download(req: Request, id: string, signal?: AbortSignal) {
        const row = await this.visible(req, id),
            bytes = await this.storage.read(row, signal);
        await this.visible(req, id);
        return { bytes, name: row.name, mediaType: row.media_type };
    }
    async remove(req: Request, id: string) {
        discussionUuid(id);
        const identity = this.policy.input(req);
        await this.repository.transaction(async (db) => {
            const actor = await this.policy.actor(db, identity, true),
                row = (
                    await db.query<AttachmentRow>('SELECT * FROM discussion_attachments WHERE id=$1 FOR UPDATE', [id])
                ).rows[0];
            if (!row || row.owner_email !== actor.email) throw new NotFoundException('Черновое вложение не найдено.');
            await this.policy.target(db, actor, { type: row.target_type, id: row.target_id });
            if (row.comment_id) throw new ForbiddenException('Удалите комментарий, чтобы убрать прикреплённые файлы.');
            if (row.state !== 'PURGED')
                await db.query("UPDATE discussion_attachments SET state='DELETED' WHERE id=$1", [id]);
        });
        return { ok: true };
    }
    /** The tombstone is committed before S3 removal; a lost DELETE ACK is safe to retry. */
    async reap(): Promise<void> {
        if (this.cleaning || !this.storage.objects) return;
        this.cleaning = true;
        try {
            await this.repository.transaction(async (db) => {
                await db.query(
                    "UPDATE discussion_attachments SET state='DELETED' WHERE comment_id IS NULL AND state IN ('UPLOADING','READY') AND created_at<now()-interval '24 hours'",
                );
            });
            const rows = (
                await this.repository.pool.query<AttachmentRow>(
                    "SELECT * FROM discussion_attachments WHERE state='DELETED' AND comment_id IS NULL ORDER BY created_at,id LIMIT 10",
                )
            ).rows;
            for (const row of rows) {
                const lease = await this.repository.pool.connect();
                let held = false,
                    discard = true;
                try {
                    held = !!(
                        await lease.query<{ locked: boolean }>(
                            'SELECT pg_try_advisory_lock(hashtextextended($1,72465438)) AS locked',
                            [row.id],
                        )
                    ).rows[0]?.locked;
                    discard = false;
                    if (!held) continue;
                    const current = (
                        await lease.query<AttachmentRow>(
                            "SELECT * FROM discussion_attachments WHERE id=$1 AND state='DELETED' AND comment_id IS NULL",
                            [row.id],
                        )
                    ).rows[0];
                    if (!current) continue;
                    await this.storage.remove(current);
                    await lease.query(
                        "UPDATE discussion_attachments SET state='PURGED' WHERE id=$1 AND state='DELETED' AND comment_id IS NULL",
                        [row.id],
                    );
                } catch {
                    /* Durable tombstone is retried; text and Help remain available. */
                } finally {
                    if (held) {
                        try {
                            if (
                                !(
                                    await lease.query<{ unlocked: boolean }>(
                                        'SELECT pg_advisory_unlock(hashtextextended($1,72465438)) AS unlocked',
                                        [row.id],
                                    )
                                ).rows[0]?.unlocked
                            )
                                discard = true;
                        } catch {
                            discard = true;
                        }
                    }
                    lease.release(discard);
                }
            }
        } finally {
            this.cleaning = false;
        }
    }
}
