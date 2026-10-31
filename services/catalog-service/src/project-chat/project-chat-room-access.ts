import { NotFoundException } from '@nestjs/common';
import type { ProjectChatDb, ProjectChatRoomRow } from './project-chat.types';
import { DEFAULT_PROJECT_CHAT_ROOM, projectChatRoomId } from './project-chat.types';

/** A project administrator does not implicitly join a private dialogue. */
export async function assertProjectChatRoomAccess(
    db: ProjectChatDb,
    room: ProjectChatRoomRow,
    email: string,
): Promise<void> {
    if (room.visibility === 'PUBLIC' || (!room.visibility && projectChatRoomId(room) === DEFAULT_PROJECT_CHAT_ROOM))
        return;
    if (room.visibility !== 'PRIVATE') throw new NotFoundException('Диалог не найден.');
    if (room.creator_email === email) return;
    const member = await db.query(
        'SELECT email FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND email=$3 FOR SHARE',
        [room.project_id, projectChatRoomId(room), email],
    );
    if (!member.rowCount) throw new NotFoundException('Диалог не найден.');
}

export async function projectChatRoomEmails(db: ProjectChatDb, room: ProjectChatRoomRow): Promise<string[]> {
    if (room.visibility !== 'PRIVATE') return [];
    return (
        await db.query<{ email: string }>(
            'SELECT email FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 ORDER BY email',
            [room.project_id, projectChatRoomId(room)],
        )
    ).rows.map((row) => row.email);
}

/** Only current, enabled project members are offered as human recipients. */
export async function projectChatMembers(db: ProjectChatDb, projectId: string, emails?: string[]) {
    return (
        await db.query<{ email: string; displayName: string; role: string }>(
            `SELECT lower(pm.principal_name) AS email,COALESCE(NULLIF(u.display_name,''),pm.display_name,pm.principal_name) AS "displayName",pm.role
        FROM project_members pm JOIN platform_users u ON u.email=lower(pm.principal_name) AND u.enabled
        WHERE pm.project_id=$1 AND ($2::text[] IS NULL OR u.email=ANY($2)) ORDER BY pm.display_name,pm.principal_name`,
            [projectId, emails ?? null],
        )
    ).rows;
}

/** The audience display includes an explicitly invited global administrator, never every administrator. */
export async function projectChatPrivateMembers(db: ProjectChatDb, projectId: string, emails: string[]) {
    return (
        await db.query<{ email: string; displayName: string; role: string }>(
            `SELECT DISTINCT ON(u.email) u.email,COALESCE(NULLIF(u.display_name,''),u.email) AS "displayName",
        CASE WHEN u.is_main_admin THEN 'Главный админ' ELSE pm.role END AS role
        FROM platform_users u LEFT JOIN project_members pm ON pm.project_id=$1 AND lower(pm.principal_name)=u.email
        AND pm.role IN ('Наблюдатель','Разработчик','Админ проекта')
        WHERE u.enabled AND u.email=ANY($2::text[]) AND (pm.project_id IS NOT NULL OR u.is_main_admin)
        ORDER BY u.email,pm.role`,
            [projectId, emails],
        )
    ).rows;
}
