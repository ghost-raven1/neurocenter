import {ForbiddenException, NotFoundException} from '@nestjs/common';
import type {IAccessActor} from '../access/access.model';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import type {ProjectChatRepository} from '../project-chat/project-chat.repository';
import {DEFAULT_PROJECT_CHAT_ROOM, projectChatRoomId, type ProjectChatDb, type ProjectChatRoomRow} from '../project-chat/project-chat.types';
import {projectChatUuid} from '../project-chat/project-chat.validation';
import {chatActivitySession, chatActivityWatch} from './chat-activity.validation';
import {prepareChatActivitySession} from './chat-activity.sessions';
import type {ProjectChatActivity} from './chat-activity.types';

const audience = `SELECT u.email FROM platform_users u WHERE u.enabled
    AND (u.is_main_admin OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=$1 AND lower(pm.principal_name)=u.email AND pm.role IN ('Наблюдатель','Разработчик','Админ проекта')))
    AND ($3::boolean OR u.email=$4 OR EXISTS(SELECT 1 FROM project_chat_room_members rm WHERE rm.project_id=$1 AND rm.room_id=$2 AND rm.email=u.email))`;

/** Room activity uses the same fresh project and private-audience fence as message history. */
export class ProjectChatActivityService {
    constructor(private readonly repository: ProjectChatRepository) {}
    private async snapshot(db: ProjectChatDb, room: ProjectChatRoomRow, viewerEmail: string, ids: string[]): Promise<ProjectChatActivity> {
        const args = [room.project_id, projectChatRoomId(room), room.visibility !== 'PRIVATE', room.creator_email ?? null];
        const members = (await db.query<{email: string; online: boolean; typing: boolean}>(`WITH audience AS (${audience})
            SELECT a.email,EXISTS(SELECT 1 FROM chat_presence_sessions p WHERE p.email=a.email AND p.online_until>now()) AS online,
            EXISTS(SELECT 1 FROM project_chat_typing_sessions t JOIN chat_presence_sessions p ON p.email=t.email AND p.session_id=t.session_id
                WHERE t.email=a.email AND t.project_id=$1 AND t.room_id=$2 AND t.typing_until>now() AND p.online_until>now()) AS typing
            FROM audience a ORDER BY a.email`, args)).rows;
        const receipts = (await db.query<{messageId: string; readerEmails: string[]}>(`WITH audience AS (${audience})
            SELECT m.id AS "messageId",COALESCE(array_agg(r.reader_email ORDER BY r.reader_email) FILTER(WHERE a.email IS NOT NULL AND r.reader_email<>m.author_email),'{}'::text[]) AS "readerEmails"
            FROM project_chat_messages m LEFT JOIN project_chat_read_receipts r ON r.project_id=m.project_id AND r.room_id=m.room_id AND r.message_id=m.id
            LEFT JOIN audience a ON a.email=r.reader_email WHERE m.project_id=$1 AND m.room_id=$2 AND m.kind='user' AND m.id=ANY($5::uuid[])
            GROUP BY m.id ORDER BY m.id`, [...args, ids])).rows;
        return {roomId: projectChatRoomId(room), viewerEmail, observedAt: new Date().toISOString(), members, receipts};
    }
    async read(projectId: string, actor: IAccessActor, rawIds?: string, roomId = DEFAULT_PROJECT_CHAT_ROOM): Promise<ProjectChatActivity> {
        projectChatUuid(roomId); const ids = chatActivityWatch(rawIds);
        return this.repository.scoped(projectId, actor, 1, false, (db, room, current) => this.snapshot(db, room, current.email, ids), true, roomId);
    }
    async update(projectId: string, actor: IAccessActor, raw: unknown, roomId = DEFAULT_PROJECT_CHAT_ROOM): Promise<{ok: true}> {
        projectChatUuid(roomId); const input = chatActivitySession(raw, true);
        return this.repository.scoped(projectId, actor, 1, true, async (db, room, current) => {
            if (input.online) {
                await requireFeaturesEnabled(['chat_activity', 'project_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const])]);
                if (input.typing && (!current.writable || current.level < 2)) throw new ForbiddenException('Чат доступен только для чтения.');
                if (input.visibleMessageIds.length) {
                    const messages = (await db.query<{id: string}>("SELECT id FROM project_chat_messages WHERE project_id=$1 AND room_id=$2 AND kind='user' AND id=ANY($3::uuid[])", [projectId, roomId, input.visibleMessageIds])).rows;
                    if (messages.length !== input.visibleMessageIds.length) throw new NotFoundException('Просмотренное сообщение не найдено в этом чате.');
                    await db.query(`INSERT INTO project_chat_read_receipts(project_id,room_id,message_id,reader_email)
                        SELECT $1,$2,id,$4 FROM project_chat_messages WHERE project_id=$1 AND room_id=$2 AND id=ANY($3::uuid[]) AND kind='user' AND author_email<>$4 ON CONFLICT DO NOTHING`, [projectId, roomId, input.visibleMessageIds, current.email]);
                }
                if (input.typing) await this.repository.ensure(db, room);
            }
            await prepareChatActivitySession(db, 'project_chat_typing_sessions', current.email, input.sessionId);
            await db.query(`INSERT INTO project_chat_typing_sessions(email,session_id,sequence,project_id,room_id,typing_until,retain_until)
                VALUES($1,$2,$3,CASE WHEN $6 THEN $4 ELSE NULL END,CASE WHEN $6 THEN $5::uuid ELSE NULL END,CASE WHEN $6 THEN now()+interval '6 seconds' ELSE NULL END,now()+interval '5 minutes')
                ON CONFLICT(email,session_id) DO UPDATE SET sequence=EXCLUDED.sequence,project_id=EXCLUDED.project_id,room_id=EXCLUDED.room_id,typing_until=EXCLUDED.typing_until,retain_until=EXCLUDED.retain_until
                WHERE project_chat_typing_sessions.sequence<EXCLUDED.sequence`, [current.email, input.sessionId, input.sequence, projectId, roomId, input.online && input.typing]);
            return {ok: true};
        }, true, roomId);
    }
}
