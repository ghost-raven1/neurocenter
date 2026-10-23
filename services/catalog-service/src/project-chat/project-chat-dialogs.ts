import {BadRequestException, ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {normalizeEmail, type IAccessActor} from '../access/access.model';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import type {ProjectChatActor} from './project-chat.policy';
import {ProjectChatRepository} from './project-chat.repository';
import {projectChatBody, projectChatHash, projectChatRevision, projectChatUuid} from './project-chat.validation';
import {assertProjectChatRoomAccess, projectChatMembers, projectChatRoomEmails} from './project-chat-room-access';
import {DEFAULT_PROJECT_CHAT_ROOM, projectChatRoomId, type ProjectChatDb, type ProjectChatRoomRow, type ProjectChatRooms, type ProjectChatRoomSummary, type ProjectChatVisibility} from './project-chat.types';

const title = (raw: unknown): string => {
    if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 120 || /[\x00-\x1f]/.test(raw)) throw new BadRequestException('Название диалога: от 1 до 120 символов без перевода строки.');
    return raw.trim();
};
const emails = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.length > 100 || raw.some(value => typeof value !== 'string')) throw new BadRequestException('Выберите до 100 участников проекта.');
    let result: string[]; try {result = raw.map(value => normalizeEmail(value));} catch {throw new BadRequestException('Выберите корректные адреса участников проекта.');}
    if (new Set(result).size !== result.length) throw new BadRequestException('Участники не должны повторяться.');
    return result.sort();
};
export const canManageProjectChatRoom = (room: ProjectChatRoomRow, actor: ProjectChatActor): boolean => projectChatRoomId(room) !== DEFAULT_PROJECT_CHAT_ROOM
    && actor.level >= 2 && (room.creator_email === actor.email || room.visibility === 'PUBLIC' && actor.level >= 3);

/** Named conversations reuse the existing queue, history and project authorization boundary. */
export class ProjectChatDialogs {
    constructor(private readonly repository: ProjectChatRepository) {}
    private async summary(db: ProjectChatDb, room: ProjectChatRoomRow, actor: ProjectChatActor): Promise<ProjectChatRoomSummary> {
        return {id: projectChatRoomId(room), title: room.title ?? 'Общий чат', visibility: room.visibility ?? 'PUBLIC', revision: Number(room.revision),
            updatedAt: room.updated_at ? new Date(room.updated_at).toISOString() : new Date(0).toISOString(), canManage: canManageProjectChatRoom(room, actor), memberEmails: await projectChatRoomEmails(db, room)};
    }
    async list(projectId: string, actor: IAccessActor): Promise<ProjectChatRooms> {
        return this.repository.scoped(projectId, actor, 1, false, async (db, defaultRoom, current) => {
            const values = (await db.query<ProjectChatRoomRow>(`SELECT r.* FROM project_chat_rooms r WHERE r.project_id=$1 AND
                (r.visibility='PUBLIC' OR r.creator_email=$2 OR EXISTS(SELECT 1 FROM project_chat_room_members m WHERE m.project_id=r.project_id AND m.room_id=r.id AND m.email=$2))
                ORDER BY (r.id=$3) DESC,r.updated_at DESC,r.id LIMIT 101 FOR SHARE OF r`, [projectId, current.email, DEFAULT_PROJECT_CHAT_ROOM])).rows;
            if (!values.some(row => projectChatRoomId(row) === DEFAULT_PROJECT_CHAT_ROOM)) values.unshift(defaultRoom);
            const rooms: ProjectChatRoomSummary[] = [];
            for (const room of values) {
                try {await assertProjectChatRoomAccess(db, room, current.email); rooms.push(await this.summary(db, room, current));}
                catch (error) {if (!(error instanceof NotFoundException)) throw error;}
            }
            return {rooms, canCreate: current.writable && current.level >= 2, members: await projectChatMembers(db, projectId)};
        });
    }
    private async invited(db: ProjectChatDb, projectId: string, values: string[], creator: string): Promise<void> {
        const others = values.filter(email => email !== creator);
        if (!others.length) return;
        const current = (await db.query<{email: string}>(`SELECT DISTINCT u.email FROM project_members pm JOIN platform_users u ON u.email=lower(pm.principal_name) AND u.enabled
            WHERE pm.project_id=$1 AND u.email=ANY($2::text[])`, [projectId, others])).rows.map(row => row.email);
        if (others.some(email => !current.includes(email))) throw new BadRequestException('Можно пригласить только действующих участников этого проекта. Обновите список.');
        // Retain current account and project-grant rows until the membership write commits.
        await db.query('SELECT email FROM platform_users WHERE email=ANY($1::text[]) FOR SHARE', [others]);
        await db.query('SELECT principal_name FROM project_members WHERE project_id=$1 AND lower(principal_name)=ANY($2::text[]) FOR SHARE', [projectId, others]);
        const fresh = await projectChatMembers(db, projectId, others);
        if (others.some(email => !fresh.some(row => row.email === email))) throw new BadRequestException('Состав проекта изменился. Обновите участников.');
    }
    async create(projectId: string, actor: IAccessActor, raw: unknown): Promise<ProjectChatRoomSummary> {
        const body = projectChatBody(raw, ['requestKey','title','visibility','memberEmails']), key = projectChatUuid(body.requestKey), name = title(body.title), members = emails(body.memberEmails);
        if (!['PUBLIC','PRIVATE'].includes(String(body.visibility)) || typeof body.visibility !== 'string') throw new BadRequestException('Выберите публичный или приватный диалог.');
        const visibility = body.visibility as ProjectChatVisibility;
        if (visibility === 'PUBLIC' && members.length) throw new BadRequestException('Публичный диалог доступен всему проекту; отдельный список не требуется.');
        const hash = projectChatHash({title: name, visibility, memberEmails: members});
        return this.repository.scoped(projectId, actor, 2, true, async (db, _room, current) => {
            const prior = (await db.query<ProjectChatRoomRow>('SELECT * FROM project_chat_rooms WHERE project_id=$1 AND creator_email=$2 AND create_request_key=$3', [projectId, current.email, key])).rows[0];
            if (prior) {if (prior.create_request_hash !== hash) throw new ConflictException('Ключ создания относится к другому диалогу.'); return this.summary(db, prior, current);}
            if (!current.writable) throw new ForbiddenException('Проект доступен только для чтения.');
            await requireFeaturesEnabled(['project_chat_dialogs']);
            const count = Number((await db.query<{count: string}>('SELECT count(*) FROM project_chat_rooms WHERE project_id=$1 AND id<>$2', [projectId, DEFAULT_PROJECT_CHAT_ROOM])).rows[0].count);
            if (count >= 100) throw new ConflictException('Достигнут лимит новых диалогов. Продолжите существующий диалог.');
            const invitees = visibility === 'PRIVATE' ? [...new Set([...members, current.email])].sort() : [];
            await this.invited(db, projectId, invitees, current.email);
            const room = (await db.query<ProjectChatRoomRow>(`INSERT INTO project_chat_rooms(project_id,id,title,visibility,creator_email,create_request_key,create_request_hash)
                VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [projectId, randomUUID(), name, visibility, current.email, key, hash])).rows[0];
            for (const email of invitees) await db.query('INSERT INTO project_chat_room_members(project_id,room_id,email) VALUES($1,$2,$3)', [projectId, room.id, email]);
            return this.summary(db, room, current);
        }, true);
    }
    async update(projectId: string, actor: IAccessActor, roomId: string, raw: unknown): Promise<ProjectChatRoomSummary> {
        projectChatUuid(roomId); const body = projectChatBody(raw, ['expectedRevision','title','memberEmails']);
        const revision = projectChatRevision(body.expectedRevision), name = title(body.title), input = emails(body.memberEmails);
        return this.repository.scoped(projectId, actor, 2, true, async (db, room, current) => {
            if (!canManageProjectChatRoom(room, current)) throw new ForbiddenException('Изменить диалог может его создатель; публичный диалог — также администратор проекта.');
            if (Number(room.revision) !== revision) throw new ConflictException('Диалог уже изменился. Обновите настройки; введённые значения сохранены.');
            if (room.visibility === 'PUBLIC' && input.length) throw new BadRequestException('Публичный диалог доступен всем участникам проекта.');
            const next = room.visibility === 'PRIVATE' ? [...new Set([...input, room.creator_email!])].sort() : [], previous = await projectChatRoomEmails(db, room);
            const introduces = next.some(email => !previous.includes(email)), changesTitle = room.title !== name;
            if (introduces || changesTitle) {if (!current.writable) throw new ForbiddenException('Проект доступен только для чтения. Можно только сократить доступ.'); await requireFeaturesEnabled(['project_chat_dialogs']);}
            await this.invited(db, projectId, next.filter(email => !previous.includes(email)), room.creator_email!);
            await db.query('DELETE FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND NOT(email=ANY($3::text[]))', [projectId, roomId, next]);
            for (const email of next) await db.query('INSERT INTO project_chat_room_members(project_id,room_id,email) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [projectId, roomId, email]);
            await db.query('UPDATE project_chat_rooms SET title=$3 WHERE project_id=$1 AND id=$2', [projectId, roomId, name]);
            await this.repository.bump(db, room); return this.summary(db, {...room, title: name}, current);
        }, true, roomId);
    }
}
