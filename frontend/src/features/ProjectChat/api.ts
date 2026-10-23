import api from '../../core/api/base';
import type {ProjectChatDetail, ProjectChatIntent, ProjectChatPage, ProjectChatReceipt, ProjectChatRooms, ProjectChatRoomSummary, ProjectChatCreateRoom, ProjectChatUpdateRoom} from './types';

const route = (projectId: string, roomId?: string): string => `/api/projects/${encodeURIComponent(projectId)}/team-chat${roomId && roomId !== '00000000-0000-0000-0000-000000000000' ? '/rooms/' + encodeURIComponent(roomId) : ''}`;

/** Shared project messages use their own room; no personal conversation is made public. */
export const projectChatApi = {
    read: (projectId: string, signal: AbortSignal, watchIds?: string[], roomId?: string) => api.get<ProjectChatDetail>(route(projectId, roomId), {signal, ...(watchIds?.length ? {params: {watch: watchIds.join(',')}} : {})}).then(value => value.data),
    history: (projectId: string, before: string, signal: AbortSignal, roomId?: string) => api.get<ProjectChatPage>(`${route(projectId, roomId)}/history`, {params: {before, limit: 50}, signal}).then(value => value.data),
    send: (projectId: string, intent: ProjectChatIntent, signal: AbortSignal, roomId?: string) => api.post<ProjectChatReceipt>(`${route(projectId, roomId)}/messages`, intent, {signal, timeout: 30000}).then(value => value.data),
    participants: (projectId: string, expectedRevision: number, agentIds: string[], modelId: string | undefined, expectedModelPin: string | undefined, signal: AbortSignal, roomId?: string) => api.put<ProjectChatDetail>(`${route(projectId, roomId)}/participants`,
        {expectedRevision, agentIds, ...(modelId ? {modelId, expectedModelPin} : {})}, {signal}).then(value => value.data),
    retry: (projectId: string, messageId: string, requestKey: string, signal: AbortSignal, roomId?: string) => api.post<ProjectChatReceipt>(`${route(projectId, roomId)}/messages/${encodeURIComponent(messageId)}/retry`, {requestKey}, {signal, timeout: 30000}).then(value => value.data),
    rooms: (projectId: string, signal: AbortSignal) => api.get<ProjectChatRooms>(`${route(projectId)}/rooms`, {signal}).then(value => value.data),
    createRoom: (projectId: string, input: ProjectChatCreateRoom, signal: AbortSignal) => api.post<ProjectChatRoomSummary>(`${route(projectId)}/rooms`, input, {signal, timeout: 30000}).then(value => value.data),
    updateRoom: (projectId: string, roomId: string, input: ProjectChatUpdateRoom, signal: AbortSignal) => api.put<ProjectChatRoomSummary>(`${route(projectId)}/rooms/${encodeURIComponent(roomId)}`, input, {signal, timeout: 30000}).then(value => value.data),
    cancel: (projectId: string, messageId: string, signal: AbortSignal, roomId?: string) => api.post<ProjectChatReceipt>(`${route(projectId, roomId)}/messages/${encodeURIComponent(messageId)}/cancel`, {}, {signal}).then(value => value.data),
};
