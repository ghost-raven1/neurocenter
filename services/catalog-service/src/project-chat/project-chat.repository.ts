import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { IAccessActor } from '../access/access.model';
import type { ChatAgentSnapshot } from '../model-chat/chat-group.types';
import { ProjectChatPolicy, type ProjectChatActor } from './project-chat.policy';
import { emptyProjectChatRoom, type ProjectChatDb, type ProjectChatMessageRow, type ProjectChatRoomRow } from './project-chat.types';

/** Short transactions serialize room state; inference never holds a connection or row lock. */
export class ProjectChatRepository {
    constructor(readonly pool: Pool, readonly policy = new ProjectChatPolicy()) {}
    async transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect(); let discard = false;
        try { await db.query('BEGIN'); const result = await action(db); await db.query('COMMIT'); return result; }
        catch (error) { try { await db.query('ROLLBACK'); } catch { discard = true; } throw error; }
        finally { db.release(discard); }
    }
    async room(db: ProjectChatDb, projectId: string, write = false): Promise<ProjectChatRoomRow> {
        return (await db.query<ProjectChatRoomRow>('SELECT * FROM project_chat_rooms WHERE project_id=$1 ' + (write ? 'FOR UPDATE' : 'FOR SHARE'), [projectId])).rows[0] ?? emptyProjectChatRoom(projectId);
    }
    async scoped<T>(projectId: string, actor: IAccessActor, minimum: number, write: boolean,
        action: (db: ProjectChatDb, room: ProjectChatRoomRow, current: ProjectChatActor) => Promise<T>, recovery = false): Promise<T> {
        return this.transaction(async db => {
            const current = await this.policy.authorize(db, projectId, actor, minimum, true, recovery);
            // A missing room still needs one serialization fence for concurrent first posts/configuration.
            if (write) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['project-chat:' + projectId]);
            const room = await this.room(db, projectId, write), result = await action(db, room, current);
            await this.policy.authorize(db, projectId, actor, minimum, true, recovery); return result;
        });
    }
    async ensure(db: ProjectChatDb, room: ProjectChatRoomRow): Promise<void> {
        if (room.revision) return;
        Object.assign(room, (await db.query<ProjectChatRoomRow>('INSERT INTO project_chat_rooms(project_id) VALUES($1) RETURNING *', [room.project_id])).rows[0]);
    }
    async bump(db: ProjectChatDb, room: ProjectChatRoomRow): Promise<void> {
        Object.assign(room, (await db.query<ProjectChatRoomRow>('UPDATE project_chat_rooms SET revision=revision+1,updated_at=now() WHERE project_id=$1 RETURNING *', [room.project_id])).rows[0]);
    }
    async message(db: ProjectChatDb, projectId: string, id: string): Promise<ProjectChatMessageRow> {
        const row = (await db.query<ProjectChatMessageRow>('SELECT * FROM project_chat_messages WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
        if (!row) throw new NotFoundException('Сообщение не найдено в этом чате проекта.'); return row;
    }
    async page(db: ProjectChatDb, projectId: string, before?: string, limit = 50) {
        const cursor = before ? await this.message(db, projectId, before) : null;
        const candidates = (await db.query<ProjectChatMessageRow>('SELECT * FROM project_chat_messages WHERE project_id=$1 AND ($2::bigint IS NULL OR position<$2) ORDER BY position DESC LIMIT $3', [projectId, cursor?.position ?? null, limit + 1])).rows;
        const selected: ProjectChatMessageRow[] = []; let bytes = 0;
        for (const row of candidates.slice(0, limit)) { const size = Buffer.byteLength(row.content) + 2048; if (selected.length && bytes + size > 4 * 1024 ** 2) break; selected.push(row); bytes += size; }
        const messages = selected.reverse(); return { messages, history: { hasMore: candidates.length > selected.length, nextCursor: candidates.length > selected.length ? messages[0]?.id ?? null : null } };
    }
    async prior(db: ProjectChatDb, projectId: string, actor: string, key: string): Promise<ProjectChatMessageRow | undefined> {
        return (await db.query<ProjectChatMessageRow>('SELECT * FROM project_chat_messages WHERE project_id=$1 AND author_email=$2 AND request_key=$3', [projectId, actor, key])).rows[0];
    }
    /** First admission and explicit retries share the same bounded queue, under the room lock. */
    async assertQueueCapacity(db: ProjectChatDb, projectId: string, author: string): Promise<void> {
        const queued = (await db.query<{ total: string; own: string }>("SELECT count(*) AS total,count(*) FILTER(WHERE author_email=$2) AS own FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND status IN ('queued','running')", [projectId, author])).rows[0];
        if (Number(queued.total) >= 100 || Number(queued.own) >= 20) throw new ConflictException('Очередь ответов агентов заполнена. Дождитесь ответа или отправьте сообщение только людям.');
    }
    async add(db: ProjectChatDb, room: ProjectChatRoomRow, actor: ProjectChatActor,
        input: { requestKey: string; hash: string; prompt: string; replyToId: string | null }, snapshots: ChatAgentSnapshot[]) {
        const id = randomUUID(), generation = randomUUID();
        const source = (await db.query<ProjectChatMessageRow>(`INSERT INTO project_chat_messages(id,project_id,kind,content,author_email,author_name,author_role,reply_to_id,status,request_key,request_hash,target_agent_ids,generation)
            VALUES($1,$2,'user',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [id, room.project_id, input.prompt, actor.email, actor.displayName, actor.activeRole, input.replyToId,
            snapshots.length ? 'queued' : 'done', input.requestKey, input.hash, snapshots.map(row => row.agentId), generation])).rows[0];
        for (const snapshot of snapshots) await db.query(`INSERT INTO project_chat_messages(id,project_id,kind,reply_to_id,source_message_id,status,snapshot,generation)
            VALUES($1,$2,'agent',$3,$3,'queued',$4::jsonb,$5)`, [randomUUID(), room.project_id, id, JSON.stringify(snapshot), generation]);
        if (snapshots.length) await db.query(`INSERT INTO project_chat_messages(id,project_id,kind,reply_to_id,source_message_id,status,generation)
            VALUES($1,$2,'summary',$3,$3,'queued',$4)`, [randomUUID(), room.project_id, id, generation]);
        await this.bump(db, room); return source;
    }
    async children(db: ProjectChatDb, projectId: string, id: string): Promise<ProjectChatMessageRow[]> {
        return (await db.query<ProjectChatMessageRow>('SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 ORDER BY position', [projectId, id])).rows;
    }
    async claim(projectId: string) {
        return this.transaction(async db => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['project-chat:' + projectId]);
            const room = await this.room(db, projectId, true); if (!room.revision) return null;
            if ((await db.query("SELECT 1 FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND status='running'", [projectId])).rowCount) return null;
            const source = (await db.query<ProjectChatMessageRow>("SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND status='queued' ORDER BY position LIMIT 1 FOR UPDATE", [projectId])).rows[0];
            if (!source) return null;
            const generation = randomUUID();
            const updated = (await db.query<ProjectChatMessageRow>("UPDATE project_chat_messages SET status='running',lease_until=now()+interval '15 minutes',generation=$3,error=NULL WHERE project_id=$1 AND (id=$2 OR source_message_id=$2) AND status='queued' RETURNING *", [projectId, source.id, generation])).rows;
            await this.bump(db, room); return { projectId, source: updated.find(row => row.id === source.id)!, actor: { email: source.author_email!, activeRole: source.author_role! }, generation };
        });
    }
    /** Expired attempts are failed, never replayed against a provider automatically. */
    async recover(): Promise<string[]> {
        const projects = (await this.pool.query<{ project_id: string }>("SELECT DISTINCT project_id FROM project_chat_messages WHERE status='running' AND lease_until<=now()")).rows;
        for (const { project_id: id } of projects) await this.transaction(async db => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['project-chat:' + id]);
            const room = await this.room(db, id, true);
            const expired = await db.query("UPDATE project_chat_messages SET status='failed',lease_until=NULL,error='Обработка прервана. Повторите ответ явно.' WHERE project_id=$1 AND status='running' AND lease_until<=now()", [id]);
            if (expired.rowCount && room.revision) await this.bump(db, room);
        });
        return (await this.pool.query<{ project_id: string }>("SELECT DISTINCT project_id FROM project_chat_messages WHERE kind='user' AND status='queued'")).rows.map(row => row.project_id);
    }
    async assertRunning(db: ProjectChatDb, projectId: string, sourceId: string, generation: string): Promise<void> {
        if (!(await db.query("SELECT 1 FROM project_chat_messages WHERE project_id=$1 AND id=$2 AND kind='user' AND generation=$3 AND status='running' AND lease_until>now()", [projectId, sourceId, generation])).rowCount) throw new ConflictException('Обработка сообщения уже остановлена или завершена.');
    }
}
