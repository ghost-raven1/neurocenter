import api from '../../core/api/base';
import type { ICatalogModel, IModelCatalog, IModelCreate, IModelHosting, IRemoteConnection, IRemoteConnectionInput, TModelHostingAction } from './types';

const modelPath = (id: string): string => '/api/models/' + encodeURIComponent(id);

/** Общий HTTP-клиент сохраняет сессию и проверку владельца при ответах 401. */
export const modelCatalogApi = {
    list: (projectId?: string): Promise<IModelCatalog> => api.get<IModelCatalog>('/api/models', { params: { projectId } }).then(result => result.data),
    create: (value: IModelCreate, requestKey: string): Promise<ICatalogModel> => api.post<ICatalogModel>('/api/models', { ...value, requestKey }).then(result => result.data),
    get: (id: string): Promise<ICatalogModel> => api.get<ICatalogModel>(modelPath(id)).then(result => result.data),
    update: (model: ICatalogModel, value: Partial<Pick<IModelCreate, 'name' | 'description' | 'model' | 'modelVersion' | 'dimension'>>): Promise<ICatalogModel> =>
        api.patch<ICatalogModel>(modelPath(model.id), { ...value, expectedRevision: model.revision }).then(result => result.data),
    remove: (model: ICatalogModel): Promise<{ ok: boolean }> =>
        api.delete<{ ok: boolean }>(modelPath(model.id), { data: { expectedRevision: model.revision } }).then(result => result.data),
    assign: (projectId: string, modelId: string): Promise<{ ok: boolean }> =>
        api.post<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/models`, { modelId }).then(result => result.data),
    unassign: (projectId: string, modelId: string): Promise<{ ok: boolean }> =>
        api.delete<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/models/${encodeURIComponent(modelId)}`).then(result => result.data),
    hosting: (id: string): Promise<IModelHosting> => api.get<IModelHosting>(modelPath(id) + '/hosting').then(result => result.data),
    operate: (model: ICatalogModel, action: TModelHostingAction): Promise<IModelHosting> =>
        api.post<IModelHosting>(modelPath(model.id) + '/hosting', { action, expectedRevision: model.revision }).then(result => result.data),
    endpoint: (id: string): string => modelPath(id) + '/ollama/api',
    connection: (id: string): Promise<IRemoteConnection> => api.get<IRemoteConnection>(modelPath(id) + '/connection').then(result => result.data),
    configure: (id: string, input: IRemoteConnectionInput): Promise<IRemoteConnection> => api.put<IRemoteConnection>(modelPath(id) + '/connection', input).then(result => result.data),
    revoke: (model: ICatalogModel, revision: number): Promise<{ ok: boolean }> => api.delete<{ ok: boolean }>(modelPath(model.id) + '/connection',
        { data: { expectedRevision: revision, expectedModelRevision: model.revision } }).then(result => result.data),
};
