import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CHAT_TOTAL_BYTES, chatChanged } from './chat-validation';
import type { AttachmentRow, ConversationRow, TurnRow, ChatTurn } from './chat.types';
import type { ChatHistory } from './chat.types';
import type { ChatBatch, ChatCheckpoint, ChatSourceTurn } from './chat-compaction';
import type { ChatResponseRow } from './chat-group.types';

export type ChatDb = Pick<PoolClient, 'query'>;
export interface ChatRows { conversation: ConversationRow; turns: TurnRow[]; attachments: AttachmentRow[]; history: ChatHistory }
export interface ChatSourceRows { turns: ChatSourceTurn[]; omittedBytes: number; omittedRequestBytes: number; omittedMessages: number; overflow: boolean }
export type ChatAuthorize = (db?: ChatDb) => Promise<unknown>;

/** Row locks serialize every mutation; private rows are never selected by an untrusted owner ID. */
export class ChatRepository {
    constructor(readonly pool: Pool) {}
    async list(owner: string, modelId: string | undefined, projectId: string | null): Promise<ConversationRow[]> {
        return (await this.pool.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE owner_email=$1 AND ($2::text IS NULL OR model_id=$2) AND project_id IS NOT DISTINCT FROM $3 ORDER BY updated_at DESC,id', [owner, modelId ?? null, projectId])).rows;
    }
    async peek(owner: string, id: string): Promise<ConversationRow> {
        const row = (await this.pool.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE id=$1 AND owner_email=$2', [id, owner])).rows[0];
        if (!row) throw new NotFoundException('Диалог не найден.');
        return row;
    }
    async create(owner: string, modelId: string, projectId: string | null, pin: string, title: string, authorize: ChatAuthorize, group: { mode: 'model' | 'group'; agentIds: string[] } = { mode: 'model', agentIds: [] }): Promise<ConversationRow> {
        return this.transaction(async db => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-chat-owner:' + owner]);
            await authorize(db);
            const count = Number((await db.query('SELECT count(*) AS total FROM model_chat_conversations WHERE owner_email=$1', [owner])).rows[0].total);
            if (count >= 100) throw new ConflictException('Можно сохранить до 100 диалогов. Удалите ненужный диалог.');
            const result = await db.query<ConversationRow>('INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,model_pin,title,mode,agent_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [randomUUID(), owner, modelId, projectId, pin, title, group.mode, group.agentIds]);
            await authorize(db); return result.rows[0];
        });
    }
    async owned<T>(owner: string, id: string, authorize: ChatAuthorize, action: (db: ChatDb, row: ConversationRow) => Promise<T>): Promise<T> {
        return this.transaction(async db => {
            const row = (await db.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE id=$1 AND owner_email=$2 FOR UPDATE', [id, owner])).rows[0];
            if (!row) throw new NotFoundException('Диалог не найден.');
            await authorize(db);
            const expired = await db.query("UPDATE model_chat_turns SET status='cancelled',error='Запрос прерван. Можно повторить его.',lease_until=NULL WHERE conversation_id=$1 AND status='pending' AND lease_until<=now() RETURNING id", [id]);
            if (expired.rowCount) { await db.query("UPDATE model_chat_agent_responses SET status='cancelled',error='Запрос прерван.',updated_at=now() WHERE turn_id=ANY($1::uuid[]) AND status='pending'", [expired.rows.map(turn => turn.id)]); await this.bump(db, row); }
            const result = await action(db, row); await authorize(db); return result;
        });
    }
    async rows(db: ChatDb, row: ConversationRow, before?: string, limit = 50, drafts = true): Promise<ChatRows> {
        const cursor = before ? (await db.query<{ position: string }>('SELECT position FROM model_chat_turns WHERE id=$1 AND conversation_id=$2 AND removed_at IS NULL', [before, row.id])).rows[0] : null;
        if (before && !cursor) throw new NotFoundException('Страница истории не найдена в этом диалоге.');
        const candidates = (await db.query<{ id: string; bytes: string }>(`SELECT id,octet_length(to_jsonb(t)::text)-octet_length(input_text)+512+
            COALESCE((SELECT sum(octet_length(COALESCE(r.answer::text,''))+2048) FROM model_chat_agent_responses r WHERE r.turn_id=t.id),0) AS bytes FROM model_chat_turns t
            WHERE conversation_id=$1 AND removed_at IS NULL AND ($2::bigint IS NULL OR position<$2) ORDER BY position DESC LIMIT $3`, [row.id, cursor?.position ?? null, limit + 1])).rows;
        const selected: string[] = []; let bytes = 0;
        for (const turn of candidates.slice(0, limit)) { const size = Number(turn.bytes); if (selected.length && bytes + size > 4 * 1024 ** 2) break; selected.push(turn.id); bytes += size; }
        const turns = (await db.query<TurnRow>('SELECT * FROM model_chat_turns WHERE conversation_id=$1 AND id=ANY($2::uuid[]) ORDER BY position', [row.id, selected])).rows;
        const responses = (await db.query<ChatResponseRow>("SELECT id,conversation_id,turn_id,agent_id,snapshot-'definition' AS snapshot,request_id,status,processing_stage,answer,error FROM model_chat_agent_responses WHERE conversation_id=$1 AND turn_id=ANY($2::uuid[]) ORDER BY created_at,id", [row.id, selected])).rows;
        for (const turn of turns) turn.responses = responses.filter(response => response.turn_id === turn.id).sort((a, b) => turn.target_agent_ids.indexOf(a.agent_id) - turn.target_agent_ids.indexOf(b.agent_id));
        const history = { hasMore: candidates.length > selected.length, nextCursor: candidates.length > selected.length ? turns[0]?.id ?? null : null };
        const attachments = (await db.query<AttachmentRow>(`SELECT id,conversation_id,request_id,request_hash,name,media_type,bytes,text_bytes,pages,warning,created_at,deleted_at FROM model_chat_attachments a
            WHERE conversation_id=$1 AND deleted_at IS NULL AND (EXISTS(SELECT 1 FROM model_chat_turns t WHERE t.id=ANY($2::uuid[]) AND a.id=ANY(t.attachment_ids))
            OR $3 AND NOT EXISTS(SELECT 1 FROM model_chat_turns t WHERE t.conversation_id=$1 AND t.removed_at IS NULL AND a.id=ANY(t.attachment_ids))) ORDER BY created_at,id`, [row.id, turns.map(turn => turn.id), drafts])).rows;
        return { conversation: row, turns, attachments, history };
    }
    async checkpoint(db: ChatDb, id: string, pin?: string): Promise<ChatCheckpoint | null> { return (await db.query<ChatCheckpoint>('SELECT * FROM model_chat_compactions WHERE conversation_id=$1 AND ($2::text IS NULL OR model_pin=$2) ORDER BY created_at DESC,id DESC LIMIT 1', [id, pin ?? null])).rows[0] ?? null; }
    /** Fetch a bounded oldest prefix plus the tail. Overflow prevents inference until checkpoints consume it. */
    async sources(db: ChatDb, id: string, checkpoint: ChatCheckpoint | null): Promise<ChatSourceRows> {
        const result = await db.query<ChatSourceTurn & { omitted_bytes: string; omitted_request_bytes: string; omitted_messages: string }>(`WITH sizes AS (
            SELECT id,position,octet_length(input_text)+octet_length(COALESCE(answer->>'content','')) AS bytes,
                octet_length(to_jsonb(input_text)::text)+27+CASE WHEN status='done' THEN octet_length(to_jsonb(COALESCE(answer->>'content',''))::text)+32 ELSE 0 END AS request_bytes,
                CASE WHEN status='done' THEN 2 ELSE 1 END AS messages
            FROM model_chat_turns WHERE conversation_id=$1 AND removed_at IS NULL AND ($2::bigint IS NULL OR position>$2 OR position=$2 AND NOT $3)
        ), measured AS (SELECT *,CASE WHEN position=$2::bigint THEN 0 ELSE request_bytes END AS budget_bytes FROM sizes),
        budget AS (SELECT *,COALESCE(sum(budget_bytes) OVER(ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior,
            row_number() OVER(ORDER BY position) AS ordinal,max(position) OVER() AS tail FROM measured),
        selected AS (SELECT id FROM budget WHERE prior+budget_bytes<=8388576 OR ordinal=1 OR position=tail),
        omitted AS (SELECT COALESCE(sum(bytes),0) AS omitted_bytes,COALESCE(sum(request_bytes),0) AS omitted_request_bytes,COALESCE(sum(messages),0) AS omitted_messages FROM budget WHERE id NOT IN(SELECT id FROM selected))
        SELECT t.id,t.position,t.input_text,t.status,t.answer,omitted.* FROM model_chat_turns t CROSS JOIN omitted WHERE t.id IN(SELECT id FROM selected) ORDER BY t.position`, [id, checkpoint?.through_position ?? null, checkpoint?.through_complete ?? false]);
        const omittedBytes = Number(result.rows[0]?.omitted_bytes ?? 0), omittedRequestBytes = Number(result.rows[0]?.omitted_request_bytes ?? 0), omittedMessages = Number(result.rows[0]?.omitted_messages ?? 0);
        return { turns: result.rows, omittedBytes, omittedRequestBytes, omittedMessages, overflow: omittedMessages > 0 };
    }
    async tail(db: ChatDb, id: string): Promise<TurnRow | undefined> { return (await db.query<TurnRow>('SELECT * FROM model_chat_turns WHERE conversation_id=$1 AND removed_at IS NULL ORDER BY position DESC LIMIT 1', [id])).rows[0]; }
    async stage(db: ChatDb, row: ConversationRow, turn: TurnRow, stage: TurnRow['processing_stage']): Promise<void> {
        const updated = await db.query('UPDATE model_chat_turns SET processing_stage=$4 WHERE conversation_id=$1 AND id=$2 AND request_id=$3 AND status=\'pending\' AND removed_at IS NULL', [row.id, turn.id, turn.request_id, stage]);
        if (!updated.rowCount) throw chatChanged();
        turn.processing_stage = stage;
    }
    async saveCheckpoint(db: ChatDb, row: ConversationRow, turn: TurnRow, previous: ChatCheckpoint | null, batch: ChatBatch, summary: string, usage: NonNullable<ChatTurn['answer']>['usage'], modelPin = row.model_pin): Promise<ChatCheckpoint> {
        const last = batch.consumed.at(-1);
        const result = await db.query<ChatCheckpoint>(`INSERT INTO model_chat_compactions(id,conversation_id,previous_id,through_turn_id,through_position,through_role,through_offset,through_complete,source_sha256,model_pin,summary,usage,created_for_turn,request_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) RETURNING *`, [randomUUID(), row.id, previous?.id ?? null, last?.turnId ?? previous!.through_turn_id, last?.position ?? previous!.through_position,
            last?.role ?? previous!.through_role, last?.end ?? previous!.through_offset, last ? last.role === 'assistant' && last.end === last.total : previous!.through_complete,
            batch.digest, modelPin, summary, JSON.stringify(usage), turn.id, turn.request_id]);
        await this.bump(db, row); return result.rows[0];
    }
    async covered(db: ChatDb, id: string, checkpoint: ChatCheckpoint | null): Promise<number> {
        if (!checkpoint) return 0;
        return Number((await db.query("SELECT count(*) AS n FROM model_chat_turns WHERE conversation_id=$1 AND status='done' AND removed_at IS NULL AND (position<$2 OR position=$2 AND $3)", [id, checkpoint.through_position, checkpoint.through_complete])).rows[0].n);
    }
    async bump(db: ChatDb, row: ConversationRow): Promise<void> {
        const changed = (await db.query<ConversationRow>('UPDATE model_chat_conversations SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [row.id])).rows[0];
        if (!changed) throw new NotFoundException('Диалог удалён.'); Object.assign(row, changed);
    }
    revision(row: ConversationRow, expected: number): void { if (row.revision !== expected) throw chatChanged(); }
    async priorTurn(db: ChatDb, conversation: string, requestId: string): Promise<TurnRow | undefined> {
        return (await db.query<TurnRow>('SELECT * FROM model_chat_turns WHERE conversation_id=$1 AND $2::uuid=ANY(request_ids)', [conversation, requestId])).rows[0];
    }
    async addTurn(db: ChatDb, row: ConversationRow, input: { requestId: string; hash: string; prompt: string; attachmentIds: string[]; text: string; targetAgentIds?: string[]; research?: import('./chat-research.types').ChatResearchRequest | null }): Promise<TurnRow> {
        const turn = (await db.query<TurnRow>(`INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,lease_until,target_agent_ids,research_request)
            VALUES($1,$2,$3,ARRAY[$3::uuid],$4,$5,$6,$7,'pending',now()+interval '20 minutes',$8,$9::jsonb) RETURNING *`, [randomUUID(), row.id, input.requestId, input.hash, input.prompt, input.attachmentIds, input.text, input.targetAgentIds ?? [], input.research ? JSON.stringify(input.research) : null])).rows[0];
        await this.bump(db, row); return turn;
    }
    async attachment(db: ChatDb, conversation: string, id: string): Promise<AttachmentRow> {
        const row = (await db.query<AttachmentRow>('SELECT id,conversation_id,request_id,request_hash,name,media_type,bytes,text,text_bytes,pages,warning,created_at,deleted_at FROM model_chat_attachments WHERE conversation_id=$1 AND id=$2 AND deleted_at IS NULL', [conversation, id])).rows[0];
        if (!row) throw new NotFoundException('Вложение не найдено в этом диалоге.'); return row;
    }
    async priorAttachment(db: ChatDb, conversation: string, requestId: string): Promise<AttachmentRow | undefined> {
        return (await db.query<AttachmentRow>('SELECT id,request_hash,deleted_at FROM model_chat_attachments WHERE conversation_id=$1 AND request_id=$2', [conversation, requestId])).rows[0];
    }
    async addAttachment(db: ChatDb, row: ConversationRow, input: { requestId: string; hash: string; name: string; bytes: Buffer; objectId: string; mediaType: string; text: string; pages?: number; warning?: string }): Promise<void> {
        const used = (await db.query('SELECT COALESCE(sum(bytes) FILTER(WHERE deleted_at IS NULL),0) AS bytes,count(*) AS total FROM model_chat_attachments WHERE conversation_id=$1', [row.id])).rows[0];
        if (Number(used.bytes) + input.bytes.length > CHAT_TOTAL_BYTES) throw new ConflictException('Вложения диалога превышают 50 МиБ. Удалите ненужные файлы или начните новый диалог.');
        if (Number(used.total) >= 100) throw new ConflictException('Достигнут предел 100 файлов диалога. Начните новый диалог.');
        await db.query(`INSERT INTO model_chat_attachments(id,conversation_id,request_id,request_hash,name,media_type,bytes,object_id,text,text_bytes,pages,warning)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), row.id, input.requestId, input.hash, input.name, input.mediaType, input.bytes.length, input.objectId, input.text, Buffer.byteLength(input.text), input.pages ?? null, input.warning ?? null]);
        await this.bump(db, row);
    }
    /** Trusted cleanup records only a safe terminal state; it cannot append a revoked model response. */
    async fail(conversation: string, turnId: string, requestId: string, status: 'failed' | 'cancelled', message: string): Promise<void> {
        await this.transaction(async db => {
            const row = (await db.query<ConversationRow>('SELECT * FROM model_chat_conversations WHERE id=$1 FOR UPDATE', [conversation])).rows[0];
            if (!row) return;
            const result = await db.query('UPDATE model_chat_turns SET status=$4,error=$5,lease_until=NULL WHERE conversation_id=$1 AND id=$2 AND request_id=$3 AND status=\'pending\' AND removed_at IS NULL', [conversation, turnId, requestId, status, message]);
            await db.query("UPDATE model_chat_agent_responses SET status=$4,error=$5,updated_at=now() WHERE conversation_id=$1 AND turn_id=$2 AND request_id=$3 AND status='pending'", [conversation, turnId, requestId, status, message]);
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
