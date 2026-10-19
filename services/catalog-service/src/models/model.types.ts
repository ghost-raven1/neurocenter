export type TModelCapability = 'embedding' | 'vision' | 'chat';

/** Карточка модели хранит имя в реестре, но не даёт задавать адрес серверного runtime. */
export interface IModel {
    id: string;
    name: string;
    description: string;
    capability: TModelCapability;
    runtime: 'ollama';
    model: string;
    manifestSha256: string | null;
    dimension: number | null;
    source: 'builtin' | 'custom';
    revision: number;
    createdAt: string;
    updatedAt: string;
}

export type IModelDescriptor = Pick<IModel, 'description' | 'capability' | 'runtime' | 'model' | 'manifestSha256' | 'dimension' | 'source'>;
export interface IModelCreate { name: string; description?: string; capability: TModelCapability; model: string; dimension?: number | null }
export interface IModelUpdate { expectedRevision: number; name?: string; description?: string }
/** Метаданные получены только после проверки runtime и повторной сверки digest. */
export interface IModelVerification { manifestSha256: string; dimension: number | null }
export interface IModelList { items: IModel[]; assignedModelIds: string[] }
export interface IProjectModel { projectId: string; modelId: string; addedBy: string; addedAt: string }
