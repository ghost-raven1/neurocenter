import type { IModel } from './model.types';

export interface IProjectEmbeddingProfile {
    provider: 'openai';
    model: string;
    dimension: number;
}
/** Выбор проекта не содержит адрес runtime, ключ или локальные пути. */
export interface IProjectEmbeddingSelection {
    projectId: string;
    revision: number;
    expectedDimension: number;
    model: IModel | null;
    modelPin: string | null;
    profile: IProjectEmbeddingProfile | null;
    activeGeneration: string;
    activeSnapshot: string | null;
    dataRevision: number;
    blocker?: string;
}
/** Каталог — единственный владелец указателя; в RAG DB нет конкурирующего active head. */
export interface IProjectRagContext {
    projectId: string;
    revision: number;
    dataRevision: number;
    generation: string;
    profile: IProjectEmbeddingProfile | null;
    snapshot: string | null;
}
export interface IConfiguredProjectEmbedding extends IProjectEmbeddingSelection {
    model: IModel;
    modelPin: string;
    profile: IProjectEmbeddingProfile;
}
export interface IProjectEmbeddingUpdate {
    expectedRevision: number;
    modelId: string | null;
}
export interface IDeviceEmbeddingContext {
    installation: import('../devices/hosted-rag-grants').IHostedInstallationIdentity;
    projectId: string;
    bindingId: string;
    instanceId: string;
    expectedRevision?: number;
    expectedModelPin?: string;
}
export interface IDeviceEmbeddingInput extends IDeviceEmbeddingContext {
    expectedRevision: number;
    expectedModelPin: string;
    model: string;
    input: string | string[];
}
