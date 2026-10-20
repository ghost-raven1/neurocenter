export type TModelCapability = 'embedding' | 'vision' | 'chat';
export type TModelRuntime = 'ollama' | 'remote-openai' | 'remote-ollama';

/** Карточка модели хранит имя в реестре, но не даёт задавать адрес серверного runtime. */
export interface IModel {
    id: string;
    name: string;
    description: string;
    capability: TModelCapability;
    runtime: TModelRuntime;
    model: string;
    manifestSha256: string | null;
    /** Для удалённого API это проверенная конфигурация, а не SHA весов провайдера. */
    verificationSha256?: string | null;
    modelVersion?: string;
    dimension: number | null;
    source: 'builtin' | 'custom';
    revision: number;
    createdAt: string;
    updatedAt: string;
    archivedAt?: string | null;
    /** Канонический pin для CAS назначения; вычисляется сервером, не хранится в descriptor. */
    modelPin?: string;
}

export type IModelDescriptor = Pick<IModel, 'description' | 'capability' | 'runtime' | 'model' | 'manifestSha256' | 'dimension' | 'source' | 'verificationSha256' | 'modelVersion'>;
export interface IModelCreate { name: string; description?: string; capability: TModelCapability; model: string; dimension?: number | null; runtime?: TModelRuntime; modelVersion?: string }
export interface IValidatedModelCreate extends Omit<Required<IModelCreate>, 'modelVersion'> { modelVersion?: string }
export interface IModelUpdate { expectedRevision: number; name?: string; description?: string; model?: string; modelVersion?: string; dimension?: number | null }
/** Метаданные получены только после проверки runtime и повторной сверки digest. */
export interface IModelVerification { manifestSha256: string; dimension: number | null }
export interface IModelList { items: IModel[]; assignedModelIds: string[] }
export interface IProjectModel { projectId: string; modelId: string; addedBy: string; addedAt: string }
