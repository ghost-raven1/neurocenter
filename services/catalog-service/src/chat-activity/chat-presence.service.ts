import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ModelsService } from '../models/models.service';
import { roleLevel, type IAccessActor } from '../access/access.model';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { ProjectChatPolicy } from '../project-chat/project-chat.policy';
import { ProjectChatRepository } from '../project-chat/project-chat.repository';
import type { ProjectChatDb } from '../project-chat/project-chat.types';
import { chatActivitySession } from './chat-activity.validation';
import { prepareChatActivitySession } from './chat-activity.sessions';

/** Account-wide presence follows the authenticated app tab, independently of its current conversation. */
@Injectable()
export class ChatPresenceService {
    readonly repository: ProjectChatRepository;
    constructor(models: ModelsService) {
        this.repository = new ProjectChatRepository(models.pool);
    }
    private async authorize(db: ProjectChatDb, actor: IAccessActor): Promise<void> {
        const account = (
            await db.query<{ enabled: boolean; is_main_admin: boolean }>(
                'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',
                [actor.email],
            )
        ).rows[0];
        const grants = (
            await db.query<{ role: string }>(
                'SELECT role FROM project_members WHERE lower(principal_name)=$1 FOR SHARE',
                [actor.email],
            )
        ).rows;
        if (
            !account?.enabled ||
            !roleLevel(actor.activeRole) ||
            !(actor.activeRole === 'Главный админ'
                ? account.is_main_admin
                : grants.some((row) => row.role === actor.activeRole))
        )
            throw new ForbiddenException('Доступ пользователя отозван.');
    }
    async update(req: Request, raw: unknown): Promise<{ ok: true }> {
        const input = chatActivitySession(raw),
            actor = new ProjectChatPolicy().input(req);
        return this.repository.transaction(async (db) => {
            await this.authorize(db, actor);
            if (input.online) await requireFeaturesEnabled(['chat_activity']);
            await prepareChatActivitySession(db, 'chat_presence_sessions', actor.email, input.sessionId);
            await db.query(
                `INSERT INTO chat_presence_sessions(email,session_id,sequence,online_until,retain_until)
                VALUES($1,$2,$3,CASE WHEN $4 THEN now()+interval '35 seconds' ELSE NULL END,now()+interval '5 minutes')
                ON CONFLICT(email,session_id) DO UPDATE SET sequence=EXCLUDED.sequence,online_until=EXCLUDED.online_until,retain_until=EXCLUDED.retain_until
                WHERE chat_presence_sessions.sequence<EXCLUDED.sequence`,
                [actor.email, input.sessionId, input.sequence, input.online],
            );
            if (!input.online) {
                await prepareChatActivitySession(db, 'project_chat_typing_sessions', actor.email, input.sessionId);
                await db.query(
                    `INSERT INTO project_chat_typing_sessions(email,session_id,sequence,retain_until) VALUES($1,$2,$3,now()+interval '5 minutes')
                    ON CONFLICT(email,session_id) DO UPDATE SET sequence=EXCLUDED.sequence,project_id=NULL,room_id=NULL,typing_until=NULL,retain_until=EXCLUDED.retain_until
                    WHERE project_chat_typing_sessions.sequence<EXCLUDED.sequence`,
                    [actor.email, input.sessionId, input.sequence],
                );
            }
            await this.authorize(db, actor);
            return { ok: true };
        });
    }
}
