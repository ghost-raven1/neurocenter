import api from '../../core/api/base';
import type { ICatalogModel } from '../ModelCatalog/types';
import type { IModelChatAttachmentPreview, IModelChatContext, IModelChatConversation, IModelChatDetail, IModelChatHistoryPage, IModelChatParticipant, IChatResearchRequest, IChatResearchChoices, IChatResearchStep, IChatResearchHistory } from './types';

const route = '/api/model-chats';
const chatRoute = (id: string): string => `${route}/${encodeURIComponent(id)}`;
const pin = (model: ICatalogModel): string => {
    if (!model.modelPin || !/^[a-f0-9]{64}$/.test(model.modelPin)) throw new Error('Обновите каталог перед отправкой сообщения модели.');
    return model.modelPin;
};

/** Personal conversations and document contents travel only through the authenticated Gateway. */
export const modelChatApi = {
    list: (modelId: string | undefined, projectId: string | undefined, signal: AbortSignal) => api.get<{items: IModelChatConversation[]}>(route, {params: {...(modelId ? {modelId} : {}), ...(projectId ? {projectId} : {})}, signal}).then(value => value.data.items),
    researchChoices: (modelId: string, projectId: string, signal: AbortSignal, id?: string) => api.get<IChatResearchChoices>(id ? `${chatRoute(id)}/research-tools` : `${route}/research-tools`, {params: id ? undefined : {modelId, projectId}, signal}).then(value => value.data),
    researchHistory: (id: string, turnId: string, before: string | undefined, signal: AbortSignal) => api.get<IChatResearchHistory>(`${chatRoute(id)}/turns/${encodeURIComponent(turnId)}/research-steps`, {params: {limit: 50, ...(before ? {before} : {})}, signal}).then(value => value.data),
    researchStep: (id: string, stepId: string, signal: AbortSignal) => api.get<IChatResearchStep>(`${chatRoute(id)}/research-steps/${encodeURIComponent(stepId)}`, {signal}).then(value => value.data),
    create: (model: ICatalogModel, projectId: string | undefined, signal: AbortSignal, agentIds?: string[]) => api.post<IModelChatDetail>(route,
        {modelId: model.id, ...(projectId ? {projectId} : {}), expectedModelPin: pin(model), ...(agentIds ? {mode: 'group', agentIds} : {})}, {signal}).then(value => value.data),
    agents: (modelId: string, projectId: string, signal: AbortSignal) => api.get<{items: IModelChatParticipant[]}>(`${route}/agents`, {params: {modelId, projectId}, signal}).then(value => value.data.items),
    participants: (detail: IModelChatDetail, agentIds: string[], signal: AbortSignal) => api.put<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/participants`, {expectedRevision: detail.conversation.revision, agentIds}, {signal}).then(value => value.data),
    read: (id: string, signal: AbortSignal) => api.get<IModelChatDetail>(chatRoute(id), {signal}).then(value => value.data),
    history: (id: string, before: string, signal: AbortSignal) => api.get<IModelChatHistoryPage>(`${chatRoute(id)}/history`, {params: {before, limit: 50}, signal}).then(value => value.data),
    rename: (id: string, revision: number, title: string, signal: AbortSignal) => api.patch<IModelChatDetail>(chatRoute(id), {expectedRevision: revision, title}, {signal}).then(value => value.data),
    remove: (id: string, revision: number, signal: AbortSignal) => api.delete<void>(chatRoute(id), {data: {expectedRevision: revision}, signal}),
    send: (detail: IModelChatDetail, model: ICatalogModel, requestId: string, prompt: string, attachmentIds: string[], signal: AbortSignal, targetAgentIds?: string[], research?: IChatResearchRequest) => api.post<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns`,
        {expectedRevision: detail.conversation.revision, requestId, prompt, attachmentIds, expectedModelPin: pin(model), ...(targetAgentIds?.length ? {targetAgentIds} : {}), ...(research ? {research} : {})}, {signal, timeout: 920000}).then(value => value.data),
    complete: (detail: IModelChatDetail, turnId: string, signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns/${encodeURIComponent(turnId)}/complete`, {expectedRevision: detail.conversation.revision}, {signal}).then(value => value.data),
    retry: (detail: IModelChatDetail, model: ICatalogModel, turnId: string, requestId: string, signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns/${encodeURIComponent(turnId)}/retry`,
        {expectedRevision: detail.conversation.revision, expectedModelPin: pin(model), requestId}, {signal, timeout: 920000}).then(value => value.data),
    cancel: (detail: IModelChatDetail, turnId: string, signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns/${encodeURIComponent(turnId)}/cancel`,
        {expectedRevision: detail.conversation.revision}, {signal}).then(value => value.data),
    deleteFailed: (detail: IModelChatDetail, turnId: string, signal: AbortSignal) => api.delete<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns/${encodeURIComponent(turnId)}`,
        {data: {expectedRevision: detail.conversation.revision}, signal}).then(value => value.data),
    upload: (id: string, name: string, contentBase64: string, requestId: string, signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(id)}/attachments`, {name, contentBase64, requestId}, {signal, timeout: 120000}).then(value => value.data),
    removeAttachment: (detail: IModelChatDetail, attachmentId: string, signal: AbortSignal) => api.delete<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/attachments/${encodeURIComponent(attachmentId)}`,
        {data: {expectedRevision: detail.conversation.revision}, signal}).then(value => value.data),
    previewAttachment: (id: string, attachmentId: string, signal: AbortSignal) => api.get<IModelChatAttachmentPreview>(`${chatRoute(id)}/attachments/${encodeURIComponent(attachmentId)}`, {signal}).then(value => value.data),
    context: (id: string, prompt: string, attachmentIds: string[], signal: AbortSignal, targetAgentIds?: string[]) => api.post<IModelChatContext>(`${chatRoute(id)}/context-preview`, {prompt, attachmentIds, ...(targetAgentIds?.length ? {targetAgentIds} : {})}, {signal}).then(value => value.data),
};
