import api from '../../core/api/base';
import type {ProjectChatDetail, ProjectChatIntent, ProjectChatPage, ProjectChatReceipt} from './types';

const route = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/team-chat`;

/** Shared project messages use their own room; no personal conversation is made public. */
export const projectChatApi = {
    read: (projectId: string, signal: AbortSignal, watchIds?: string[]) => api.get<ProjectChatDetail>(route(projectId), {signal, ...(watchIds?.length ? {params: {watch: watchIds.join(',')}} : {})}).then(value => value.data),
    history: (projectId: string, before: string, signal: AbortSignal) => api.get<ProjectChatPage>(`${route(projectId)}/history`, {params: {before, limit: 50}, signal}).then(value => value.data),
    send: (projectId: string, intent: ProjectChatIntent, signal: AbortSignal) => api.post<ProjectChatReceipt>(`${route(projectId)}/messages`, intent, {signal, timeout: 30000}).then(value => value.data),
    participants: (projectId: string, expectedRevision: number, agentIds: string[], modelId: string | undefined, expectedModelPin: string | undefined, signal: AbortSignal) => api.put<ProjectChatDetail>(`${route(projectId)}/participants`,
        {expectedRevision, agentIds, ...(modelId ? {modelId, expectedModelPin} : {})}, {signal}).then(value => value.data),
    retry: (projectId: string, messageId: string, requestKey: string, signal: AbortSignal) => api.post<ProjectChatReceipt>(`${route(projectId)}/messages/${encodeURIComponent(messageId)}/retry`, {requestKey}, {signal, timeout: 30000}).then(value => value.data),
    cancel: (projectId: string, messageId: string, signal: AbortSignal) => api.post<ProjectChatReceipt>(`${route(projectId)}/messages/${encodeURIComponent(messageId)}/cancel`, {}, {signal}).then(value => value.data),
};
