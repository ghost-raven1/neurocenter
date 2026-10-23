import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { readFeatures } from '../../../shared/feature-client.cjs';
import { requireFeatureEnabled } from '../features/require-feature-enabled';
import { DiscussionsRepository } from './discussions.repository';
import { DiscussionsPolicy, type DiscussionActor } from './discussions.policy';
import { DiscussionsStorage, discussionAttachmentView } from './discussions.storage';
import { discussionAttachmentIds, discussionBody, discussionObject, discussionTarget, discussionUuid, discussionVersion } from './discussions.validation';
import type { AttachmentRow, CommentRow, DiscussionComment, DiscussionTarget } from './discussions.types';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: string | Date): string => new Date(value).toISOString();

/** The same target-bound conversation works for catalog cards and Markdown help articles. */
@Injectable()
export class DiscussionsService {
    constructor(readonly repository: DiscussionsRepository, readonly policy: DiscussionsPolicy, readonly storage: DiscussionsStorage) {}
    /** Counts every visible reply in this target, independently of pagination and deleted parent tombstones. */
    private async commentCount(target: DiscussionTarget, db: Pick<PoolClient, 'query'> = this.repository.pool): Promise<number> {
        return Number((await db.query<{ count: string }>('SELECT count(*) AS count FROM discussion_comments WHERE target_type=$1 AND target_id=$2 AND deleted_at IS NULL', [target.type, target.id])).rows[0].count);
    }
    async view(row: CommentRow, actor: DiscussionActor, db: Pick<PoolClient, 'query'> = this.repository.pool): Promise<DiscussionComment> {
        const own = actor.email === row.author_email || actor.activeRole === 'Главный админ';
        const attachments = row.deleted_at ? [] : (await db.query<AttachmentRow>("SELECT * FROM discussion_attachments WHERE comment_id=$1 AND state='READY' ORDER BY created_at,id", [row.id])).rows;
        return { id: row.id, parentId: row.parent_id, body: row.body, author: { email: row.author_email, displayName: row.author_name }, version: row.version,
            createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deleted: !!row.deleted_at, canEdit: own && !row.deleted_at, canDelete: own && !row.deleted_at,
            attachments: attachments.map(discussionAttachmentView) };
    }
    async list(req: Request, query: Record<string, unknown>) {
        const target = discussionTarget(query.targetType, query.targetId), actor = await this.policy.actor(this.repository.pool, this.policy.input(req));
        await this.policy.target(this.repository.pool, actor, target);
        let cursor: { at: string; id: string } | null = null;
        if (query.cursor !== undefined) {
            try { if (typeof query.cursor !== 'string' || query.cursor.length > 200) throw Error(); cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || new Date(cursor.at).toISOString() !== cursor.at) throw Error(); discussionUuid(cursor.id); }
            catch { throw new BadRequestException('Некорректная страница обсуждения.'); }
        }
        // A JSON Date loses PostgreSQL microseconds. Recover the exact boundary from its target-bound immutable row.
        let boundary: string | null = null;
        if (cursor) {
            const anchor = (await this.repository.pool.query<{ created_at: Date | string; boundary: string }>(
                'SELECT created_at,created_at::text AS boundary FROM discussion_comments WHERE id=$1 AND target_type=$2 AND target_id=$3', [cursor.id, target.type, target.id])).rows[0];
            if (!anchor || iso(anchor.created_at) !== cursor.at) throw new BadRequestException('Страница обсуждения недоступна. Обновите обсуждение.');
            boundary = anchor.boundary;
        }
        const rows = (await this.repository.pool.query<CommentRow>(`SELECT * FROM discussion_comments WHERE target_type=$1 AND target_id=$2
            AND ($3::timestamptz IS NULL OR (created_at,id)>($3::timestamptz,$4::uuid)) ORDER BY created_at,id LIMIT 51`, [target.type, target.id, boundary, cursor?.id ?? null])).rows;
        const visible = rows.slice(0, 50), last = visible.at(-1); let enabled = false, files = false;
        try { const state = await readFeatures(); enabled = state.flags.discussions; files = state.flags.discussion_attachments; } catch { /* History remains readable during flag-service outages. */ }
        const items: DiscussionComment[] = []; for (const row of visible) items.push(await this.view(row, actor));
        const totalCount = await this.commentCount(target);
        const current = await this.policy.actor(this.repository.pool, this.policy.input(req));
        let writable = true;
        try { await this.policy.target(this.repository.pool, current, target, true); } catch { writable = false; }
        const fresh = await this.policy.actor(this.repository.pool, this.policy.input(req)); await this.policy.target(this.repository.pool, fresh, target);
        if (!writable) for (const item of items) item.canEdit = false;
        return { items, totalCount, nextCursor: rows.length > 50 && last ? Buffer.from(JSON.stringify({ at: iso(last.created_at), id: last.id })).toString('base64url') : null,
            canComment: enabled && writable, canAttach: enabled && writable && files && !!this.storage.objects,
            ...(this.storage.unavailableReason ? { attachmentsUnavailableReason: this.storage.unavailableReason } : {}) };
    }
    async read(req: Request, id: string): Promise<DiscussionComment> {
        discussionUuid(id); const actor = await this.policy.actor(this.repository.pool, this.policy.input(req)), row = await this.row(id);
        const target: DiscussionTarget = { type: row.target_type, id: row.target_id }; await this.policy.target(this.repository.pool, actor, target);
        const view = await this.view(row, actor), current = await this.policy.actor(this.repository.pool, this.policy.input(req));
        try { await this.policy.target(this.repository.pool, current, target, true); } catch { view.canEdit = false; }
        const fresh = await this.policy.actor(this.repository.pool, this.policy.input(req)); await this.policy.target(this.repository.pool, fresh, target);
        return view;
    }
    private async row(id: string, db: Pick<PoolClient, 'query'> = this.repository.pool, lock = false): Promise<CommentRow> {
        const row = (await db.query<CommentRow>('SELECT * FROM discussion_comments WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])).rows[0];
        if (!row) throw new NotFoundException('Комментарий не найден.'); return row;
    }
    async create(req: Request, raw: unknown): Promise<DiscussionComment> {
        const input = discussionObject(raw, ['targetType', 'targetId', 'parentId', 'body', 'requestKey', 'attachmentIds']), target = discussionTarget(input.targetType, input.targetId);
        const body = discussionBody(input.body), request = discussionUuid(input.requestKey), parent = input.parentId == null ? null : discussionUuid(input.parentId), attachmentIds = discussionAttachmentIds(input.attachmentIds);
        const fingerprint = hash({ target, body, parent, attachmentIds }), identity = this.policy.input(req);
        return this.repository.transaction(async db => {
            const actor = await this.policy.actor(db, identity, true); await this.policy.target(db, actor, target);
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72465434))', ['discussion:' + actor.email + ':' + request]);
            const prior = (await db.query<CommentRow>('SELECT * FROM discussion_comments WHERE author_email=$1 AND request_key=$2', [actor.email, request])).rows[0];
            if (prior) { if (prior.request_hash !== fingerprint) throw new ConflictException('Этот ключ уже использован для другого комментария.'); return this.view(prior, actor, db); }
            await requireFeatureEnabled('discussions');
            if (attachmentIds.length) await requireFeatureEnabled('discussion_attachments');
            await this.policy.target(db, actor, target, true);
            if (parent) { const row = await this.row(parent, db, true); if (row.target_type !== target.type || row.target_id !== target.id) throw new BadRequestException('Ответ должен принадлежать этому обсуждению.'); }
            const files = attachmentIds.length ? (await db.query<AttachmentRow>('SELECT * FROM discussion_attachments WHERE id=ANY($1::uuid[]) FOR UPDATE', [attachmentIds])).rows : [];
            if (files.length !== attachmentIds.length || files.some(file => file.owner_email !== actor.email || file.target_type !== target.type || file.target_id !== target.id || file.state !== 'READY' || file.comment_id)) throw new ConflictException('Вложения удалены, заняты другим комментарием или ещё не загружены.');
            const id = randomUUID(), row = (await db.query<CommentRow>(`INSERT INTO discussion_comments(id,target_type,target_id,parent_id,body,author_email,author_name,request_key,request_hash)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, target.type, target.id, parent, body, actor.email, actor.displayName, request, fingerprint])).rows[0];
            if (attachmentIds.length) await db.query('UPDATE discussion_attachments SET comment_id=$2 WHERE id=ANY($1::uuid[])', [attachmentIds, id]);
            return this.view(row, actor, db);
        });
    }
    async update(req: Request, id: string, raw: unknown): Promise<DiscussionComment> {
        discussionUuid(id); const input = discussionObject(raw, ['body', 'expectedVersion']), body = discussionBody(input.body), version = discussionVersion(input.expectedVersion);
        return this.change(req, id, version, body);
    }
    async remove(req: Request, id: string, expected: unknown): Promise<{ ok: true }> { discussionUuid(id); await this.change(req, id, discussionVersion(Number(expected)), null); return { ok: true }; }
    private async change(req: Request, id: string, version: number, body: string | null): Promise<DiscussionComment> {
        const identity = this.policy.input(req);
        return this.repository.transaction(async db => {
            const actor = await this.policy.actor(db, identity, true), row = await this.row(id, db, true), target: DiscussionTarget = { type: row.target_type, id: row.target_id };
            await this.policy.target(db, actor, target, body !== null);
            if (row.author_email !== actor.email && actor.activeRole !== 'Главный админ') throw new ForbiddenException('Изменять комментарий может автор или главный администратор.');
            if (row.version !== version) throw new ConflictException('Комментарий изменён. Сравните актуальный текст с вашим черновиком.');
            if (row.deleted_at) { if (body === null) return this.view(row, actor, db); throw new ConflictException('Комментарий уже удалён.'); }
            if (body !== null) await requireFeatureEnabled('discussions');
            const saved = (await db.query<CommentRow>(`UPDATE discussion_comments SET body=$2,version=version+1,updated_at=now(),deleted_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1 RETURNING *`, [id, body ?? '', body === null])).rows[0];
            // Metadata remains durable for replies; private files are queued for the storage reaper.
            if (body === null) await db.query("UPDATE discussion_attachments SET comment_id=NULL,state='DELETED' WHERE comment_id=$1", [id]);
            return this.view(saved, actor, db);
        });
    }
    async reaction(req: Request, targetId: string, desired?: boolean): Promise<{ liked: boolean; count: number; commentCount: number }> {
        const target = discussionTarget('catalog', targetId), identity = this.policy.input(req);
        return this.repository.transaction(async db => {
            const actor = await this.policy.actor(db, identity, desired !== undefined); await this.policy.target(db, actor, target);
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72465435))', ['reaction:' + actor.email + ':' + target.id]);
            const liked = !!(await db.query('SELECT 1 FROM catalog_reactions WHERE target_id=$1 AND actor_email=$2', [target.id, actor.email])).rowCount;
            if (desired === true && !liked) { await requireFeatureEnabled('catalog_reactions'); await this.policy.target(db, actor, target, true); await db.query('INSERT INTO catalog_reactions(target_id,actor_email) VALUES($1,$2) ON CONFLICT DO NOTHING', [target.id, actor.email]); }
            if (desired === false) await db.query('DELETE FROM catalog_reactions WHERE target_id=$1 AND actor_email=$2', [target.id, actor.email]);
            const count = Number((await db.query<{ count: string }>('SELECT count(*) AS count FROM catalog_reactions WHERE target_id=$1', [target.id])).rows[0].count);
            const commentCount = await this.commentCount(target, db);
            await this.policy.target(db, await this.policy.actor(db, identity), target);
            return { liked: desired ?? liked, count, commentCount };
        });
    }
}
