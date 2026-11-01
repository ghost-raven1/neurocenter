import type { IProjectChatRoom, IProjectChatRoomRow } from './project-chat.interfaces';
import { DEFAULT_PROJECT_CHAT_ROOM } from './project-chat.constants';

export const projectChatRoomId = (row: { id?: string }): string => row.id ?? DEFAULT_PROJECT_CHAT_ROOM;

export const projectChatRoomView = (row: IProjectChatRoomRow): IProjectChatRoom => ({
    projectId: row.project_id,
    id: projectChatRoomId(row),
    title: row.title ?? 'Общий чат',
    visibility: row.visibility ?? 'PUBLIC',
    creatorEmail: row.creator_email ?? null,
    revision: Number(row.revision),
    agentIds: row.agent_ids,
    modelId: row.model_id,
    modelPin: row.model_pin,
});

export const emptyProjectChatRoom = (projectId: string): IProjectChatRoomRow => ({
    project_id: projectId,
    id: DEFAULT_PROJECT_CHAT_ROOM,
    title: 'Общий чат',
    visibility: 'PUBLIC',
    creator_email: null,
    revision: 0,
    agent_ids: [],
    model_id: null,
    model_pin: null,
});
