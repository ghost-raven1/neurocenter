import api from '../../core/api/base';
import {DEFAULT_PROJECT_CHAT_ROOM} from './types';
import type {ProjectChatActivity, ProjectChatActivityInput} from './activity.types';

const route = (projectId: string, roomId: string): string => `/api/projects/${encodeURIComponent(projectId)}/team-chat${roomId === DEFAULT_PROJECT_CHAT_ROOM ? '' : `/rooms/${encodeURIComponent(roomId)}`}/activity`;

/** Receipts are read independently of the switch controlling new activity updates. */
export const projectChatActivityApi = {
    read: (projectId: string, roomId: string, messageIds: string[], signal: AbortSignal) => api.get<ProjectChatActivity>(route(projectId, roomId), {signal, ...(messageIds.length ? {params: {messageIds: messageIds.join(',')}} : {})}).then(value => value.data),
    update: (projectId: string, roomId: string, input: ProjectChatActivityInput, signal?: AbortSignal) => api.put(route(projectId, roomId), input, {signal, timeout: 15000}).then(() => undefined),
};
