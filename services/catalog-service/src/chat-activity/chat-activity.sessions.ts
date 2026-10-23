import {ConflictException} from '@nestjs/common';
import type {ProjectChatDb} from '../project-chat/project-chat.types';

type SessionTable = 'chat_presence_sessions' | 'project_chat_typing_sessions';
/** Keep a short tombstone after closing a tab so its earlier requests cannot restore activity. */
export async function prepareChatActivitySession(db: ProjectChatDb, table: SessionTable, email: string, sessionId: string): Promise<void> {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['chat-activity:' + email]);
    await db.query(`DELETE FROM ${table} WHERE retain_until<=now()`);
    const count = (await db.query<{count: string; existing: boolean}>(`SELECT count(*) AS count,bool_or(session_id=$2) AS existing FROM ${table} WHERE email=$1`, [email, sessionId])).rows[0];
    if (Number(count.count) >= 32 && !count.existing) throw new ConflictException('Слишком много открытых сессий. Закройте лишние вкладки и повторите через несколько минут.');
}
