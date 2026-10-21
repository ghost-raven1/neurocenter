import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CHAT_TOTAL_BYTES, chatChanged } from './chat-validation';
import type { AttachmentRow, ConversationRow, TurnRow, ChatTurn } from './chat.types';

export type ChatDb = Pick<PoolClient, 'query'>;
export interface ChatRows { conversation: ConversationRow; turns: TurnRow[]; attachments: AttachmentRow[] }
export type ChatAuthorize = () => Promise<unknown>;

/** Row locks serialize every mutation; private rows are never selected by an untrusted owner ID. */
export class ChatRepository {
    constructor(readonly pool: Pool) {}
    async list(owner: string, modelId: string, projectId: string | null): Promise<ConversationRow[]> {
        return (await this.pool.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE owner_email=$1 AND model_id=$2 AND project_id IS NOT DISTINCT FROM $3 ORDER BY updated_at DESC,id', [owner, modelId, projectId])).rows;
    }
    async peek(owner: string, id: string): Promise<ConversationRow> {
        const row = (await this.pool.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE id=$1 AND owner_email=$2', [id, owner])).rows[0];
        if (!row) throw new NotFoundException('Диалог не найден.');
        return row;
    }
    async create(owner: string, modelId: string, projectId: string | null, pin: string, title: string, authorize: ChatAuthorize): Promise<ConversationRow> {
        return this.transaction(async db => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-chat-owner:' + owner]);
            await authorize();
            const count = Number((await db.query('SELECT count(*) AS total FROM model_chat_conversations WHERE owner_email=$1', [owner])).rows[0].total);
            if (count >= 100) throw new ConflictException('Можно сохранить до 100 диалогов. Удалите ненужный диалог.');
            const result = await db.query<ConversationRow>('INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,model_pin,title) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), owner, modelId, projectId, pin, title]);
            await authorize(); return result.rows[0];
        });
    }
    async owned<T>(owner: string, id: string, authorize: ChatAuthorize, action: (db: ChatDb, row: ConversationRow) => Promise<T>): Promise<T> {
        return this.transaction(async db => {
            const row = (await db.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE id=$1 AND owner_email=$2 FOR UPDATE', [id, owner])).rows[0];
            if (!row) throw new NotFoundException('Диалог не найден.');
            await authorize();
            const expired = await db.query("UPDATE model_chat_turns SET status='cancelled',error='Запрос прерван. Можно повторить его.',lease_until=NULL WHERE conversation_id=$1 AND status='pending' AND lease_until<=now() RETURNING id", [id]);
            if (expired.rowCount) await this.bump(db, row);
            const result = await action(db, row); await authorize(); return result;
        });
    }
    async rows(db: ChatDb, row: ConversationRow): Promise<ChatRows> {
        const turns = (await db.query<TurnRow>('SELECT * FROM model_chat_turns WHERE conversation_id=$1 AND removed_at IS NULL ORDER BY position', [row.id])).rows;
        const attachments = (await db.query<AttachmentRow>('SELECT id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,pages,warning,created_at,deleted_at FROM model_chat_attachments WHERE conversation_id=$1 AND deleted_at IS NULL ORDER BY created_at,id', [row.id])).rows;
        return { conversation: row, turns, attachments };
    }
    async bump(db: ChatDb, row: ConversationRow): Promise<void> {
        const changed = (await db.query<ConversationRow>('UPDATE model_chat_conversations SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [row.id])).rows[0];
        if (!changed) throw new NotFoundException('Диалог удалён.'); Object.assign(row, changed);
    }
    revision(row: ConversationRow, expected: number): void { if (row.revision !== expected) throw chatChanged(); }
    async priorTurn(db: ChatDb, conversation: string, requestId: string): Promise<TurnRow | undefined> {
        return (await db.query<TurnRow>('SELECT * FROM model_chat_turns WHERE conversation_id=$1 AND $2::uuid=ANY(request_ids)', [conversation, requestId])).rows[0];
    }
    async addTurn(db: ChatDb, row: ConversationRow, input: { requestId: string; hash: string; prompt: string; attachmentIds: string[]; text: string }): Promise<TurnRow> {
        const count = Number((await db.query('SELECT count(*) AS total FROM model_chat_turns WHERE conversation_id=$1', [row.id])).rows[0].total);
        if (count >= 1000) throw new ConflictException('Достигнут предел запросов этого диалога. Начните новый.');
        const turn = (await db.query<TurnRow>(`INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,lease_until)
            VALUES($1,$2,$3,ARRAY[$3::uuid],$4,$5,$6,$7,'pending',now()+interval '20 minutes') RETURNING *`, [randomUUID(), row.id, input.requestId, input.hash, input.prompt, input.attachmentIds, input.text])).rows[0];
        await this.bump(db, row); return turn;
    }
    async attachment(db: ChatDb, conversation: string, id: string): Promise<AttachmentRow> {
        const row = (await db.query<AttachmentRow>('SELECT id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,pages,warning,created_at,deleted_at FROM model_chat_attachments WHERE conversation_id=$1 AND id=$2 AND deleted_at IS NULL', [conversation, id])).rows[0];
        if (!row) throw new NotFoundException('Вложение не найдено в этом диалоге.'); return row;
    }
    async priorAttachment(db: ChatDb, conversation: string, requestId: string): Promise<AttachmentRow | undefined> {
        return (await db.query<AttachmentRow>('SELECT id,request_hash,deleted_at FROM model_chat_attachments WHERE conversation_id=$1 AND request_id=$2', [conversation, requestId])).rows[0];
    }
    async addAttachment(db: ChatDb, row: ConversationRow, input: { requestId: string; hash: string; name: string; bytes: Buffer; mediaType: string; text: string; pages?: number; warning?: string }): Promise<void> {
        const used = (await db.query('SELECT COALESCE(sum(bytes) FILTER(WHERE deleted_at IS NULL),0) AS bytes,count(*) AS total FROM model_chat_attachments WHERE conversation_id=$1', [row.id])).rows[0];
        if (Number(used.bytes) + input.bytes.length > CHAT_TOTAL_BYTES) throw new ConflictException('Вложения диалога превышают 50 МиБ. Удалите ненужные файлы или начните новый диалог.');
        if (Number(used.total) >= 100) throw new ConflictException('Достигнут предел 100 файлов диалога. Начните новый диалог.');
        await db.query(`INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,content,text,text_bytes,pages,warning)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), row.id, input.requestId, input.hash, input.name, input.mediaType, input.bytes.length, input.bytes, input.text, Buffer.byteLength(input.text), input.pages ?? null, input.warning ?? null]);
        await this.bump(db, row);
    }
    /** Trusted cleanup records only a safe terminal state; it cannot append a revoked model response. */
    async fail(conversation: string, turnId: string, requestId: string, status: 'failed' | 'cancelled', message: string): Promise<void> {
        await this.transaction(async db => {
            const row = (await db.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE id=$1 FOR UPDATE', [conversation])).rows[0];
            if (!row) return;
            const result = await db.query('UPDATE model_chat_turns SET status=$4,error=$5,lease_until=NULL WHERE conversation_id=$1 AND id=$2 AND request_id=$3 AND status=\'pending\' AND removed_at IS NULL', [conversation, turnId, requestId, status, message]);
            if (result.rowCount) await this.bump(db, row);
        });
    }
    async finish(db: ChatDb, row: ConversationRow, turn: TurnRow, answer: NonNullable<ChatTurn['answer']>): Promise<boolean> {
        const result = await db.query("UPDATE model_chat_turns SET status='done',answer=$4::jsonb,error=NULL,lease_until=NULL WHERE conversation_id=$1 AND id=$2 AND request_id=$3 AND status='pending' AND removed_at IS NULL AND lease_until>now()", [row.id, turn.id, turn.request_id, JSON.stringify(answer)]);
        if (result.rowCount) await this.bump(db, row); return !!result.rowCount;
    }
    private async transaction<T>(action: (db: ChatDb) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try { await db.query('BEGIN'); const result = await action(db); await db.query('COMMIT'); return result; }
        catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }
}
