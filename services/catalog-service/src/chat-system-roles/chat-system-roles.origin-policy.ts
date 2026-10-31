import { ConflictException, NotFoundException } from '@nestjs/common';
import type { RoleDb } from '../system-roles/system-role.repository';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { assertProjectChatRoomAccess } from '../project-chat/project-chat-room-access';
import {
    DEFAULT_PROJECT_CHAT_ROOM,
    emptyProjectChatRoom,
    type ProjectChatRoomRow,
} from '../project-chat/project-chat.types';
import type { ChatSystemRoleOrigin, ChatSystemRoleOriginRow } from './chat-system-roles.types';

/** Caller first checks current private/project authority; this fence rechecks the original chat and its flags. */
export async function assertChatSystemRoleSource(
    db: RoleDb,
    owner: string,
    origin: ChatSystemRoleOrigin,
): Promise<void> {
    let feature: 'model_chat' | 'group_chat' | 'project_chat';
    if (origin.kind === 'model-chat') {
        const chat = (
            await db.query<{ project_id: string | null; mode: string }>(
                'SELECT project_id,mode FROM model_chat_conversations WHERE id=$1 AND owner_email=$2 FOR SHARE',
                [origin.originId, owner],
            )
        ).rows[0];
        if (!chat) throw new NotFoundException('Исходный личный чат недоступен.');
        if (chat.project_id !== origin.projectId)
            throw new ConflictException('Исходный чат относится к другому проекту.');
        feature = chat.mode === 'group' ? 'group_chat' : 'model_chat';
    } else {
        const stored = (
            await db.query<ProjectChatRoomRow>(
                'SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2 FOR SHARE',
                [origin.projectId, origin.originId],
            )
        ).rows[0];
        // Project authority is already locked by the caller; an untouched default room is a virtual PUBLIC chat.
        const room =
            stored ??
            (origin.originId === DEFAULT_PROJECT_CHAT_ROOM && origin.projectId
                ? emptyProjectChatRoom(origin.projectId)
                : undefined);
        if (!room) throw new NotFoundException('Исходный проектный диалог недоступен.');
        await assertProjectChatRoomAccess(db, room, owner);
        feature = 'project_chat';
    }
    await requireFeaturesEnabled([
        'chat_system_roles',
        'system_role_chat',
        feature,
        ...(origin.kind === 'project-chat' && origin.originId !== DEFAULT_PROJECT_CHAT_ROOM
            ? ['project_chat_dialogs' as const]
            : []),
    ]);
}

/** Legacy dialogs have no origin. Existing receipts/history bypass this new-work gate. */
export async function assertChatSystemRoleOrigin(
    db: RoleDb,
    dialogId: string,
    owner: string,
    projectId: string | null,
): Promise<void> {
    const row = (
        await db.query<ChatSystemRoleOriginRow>(
            'SELECT * FROM chat_system_role_origins WHERE dialog_id=$1 AND owner_email=$2 FOR SHARE',
            [dialogId, owner],
        )
    ).rows[0];
    if (!row) return;
    if (row.project_id !== projectId) throw new ConflictException('Область связанного чата изменилась.');
    await assertChatSystemRoleSource(db, owner, {
        kind: row.origin_kind,
        originId: row.origin_id,
        projectId: row.project_id,
    });
}
