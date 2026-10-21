import api from '../../core/api/base';
import type { ICatalogModel } from '../ModelCatalog/types';
import type { IModelChatAttachmentPreview, IModelChatContext, IModelChatConversation, IModelChatDetail, IModelChatHistoryPage } from './types';

const route = '/api/model-chats';
const chatRoute = (id: string): string => `${route}/${encodeURIComponent(id)}`;
const pin = (model: ICatalogModel): string => {
    if (!model.modelPin || !/^[a-f0-9]{64}$/.test(model.modelPin)) throw new Error('Обновите каталог перед отправкой сообщения модели.');
    return model.modelPin;
};

/** Personal conversations and document contents travel only through the authenticated Gateway. */
export const modelChatApi = {
    list: (modelId: string, projectId: string | undefined, signal: AbortSignal) => api.get<{items: IModelChatConversation[]}>(route, {params: {modelId, ...(projectId ? {projectId} : {})}, signal}).then(value => value.data.items),
    create: (model: ICatalogModel, projectId: string | undefined, signal: AbortSignal) => api.post<IModelChatDetail>(route,
        {modelId: model.id, ...(projectId ? {projectId} : {}), expectedModelPin: pin(model)}, {signal}).then(value => value.data),
    read: (id: string, signal: AbortSignal) => api.get<IModelChatDetail>(chatRoute(id), {signal}).then(value => value.data),
    history: (id: string, before: string, signal: AbortSignal) => api.get<IModelChatHistoryPage>(`${chatRoute(id)}/history`, {params: {before, limit: 50}, signal}).then(value => value.data),
    rename: (id: string, revision: number, title: string, signal: AbortSignal) => api.patch<IModelChatDetail>(chatRoute(id), {expectedRevision: revision, title}, {signal}).then(value => value.data),
    remove: (id: string, revision: number, signal: AbortSignal) => api.delete<void>(chatRoute(id), {data: {expectedRevision: revision}, signal}),
    send: (detail: IModelChatDetail, model: ICatalogModel, requestId: string, prompt: string, attachmentIds: string[], signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns`,
        {expectedRevision: detail.conversation.revision, requestId, prompt, attachmentIds, expectedModelPin: pin(model)}, {signal, timeout: 620000}).then(value => value.data),
    retry: (detail: IModelChatDetail, model: ICatalogModel, turnId: string, requestId: string, signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns/${encodeURIComponent(turnId)}/retry`,
        {expectedRevision: detail.conversation.revision, expectedModelPin: pin(model), requestId}, {signal, timeout: 620000}).then(value => value.data),
    cancel: (detail: IModelChatDetail, turnId: string, signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns/${encodeURIComponent(turnId)}/cancel`,
        {expectedRevision: detail.conversation.revision}, {signal}).then(value => value.data),
    deleteFailed: (detail: IModelChatDetail, turnId: string, signal: AbortSignal) => api.delete<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/turns/${encodeURIComponent(turnId)}`,
        {data: {expectedRevision: detail.conversation.revision}, signal}).then(value => value.data),
    upload: (id: string, name: string, contentBase64: string, requestId: string, signal: AbortSignal) => api.post<IModelChatDetail>(`${chatRoute(id)}/attachments`, {name, contentBase64, requestId}, {signal, timeout: 120000}).then(value => value.data),
    removeAttachment: (detail: IModelChatDetail, attachmentId: string, signal: AbortSignal) => api.delete<IModelChatDetail>(`${chatRoute(detail.conversation.id)}/attachments/${encodeURIComponent(attachmentId)}`,
        {data: {expectedRevision: detail.conversation.revision}, signal}).then(value => value.data),
    previewAttachment: (id: string, attachmentId: string, signal: AbortSignal) => api.get<IModelChatAttachmentPreview>(`${chatRoute(id)}/attachments/${encodeURIComponent(attachmentId)}`, {signal}).then(value => value.data),
    context: (id: string, prompt: string, attachmentIds: string[], signal: AbortSignal) => api.post<IModelChatContext>(`${chatRoute(id)}/context-preview`, {prompt, attachmentIds}, {signal}).then(value => value.data),
};
