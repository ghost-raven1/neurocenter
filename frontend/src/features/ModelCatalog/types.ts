/** Модель общего каталога; назначение проекту не запускает хостинг. */
export interface ICatalogModel {
    id: string;
    name: string;
    description: string;
    capability: 'embedding' | 'vision' | 'chat';
    runtime: 'ollama' | 'remote-openai' | 'remote-ollama' | 'device-codex';
    model: string;
    manifestSha256: string | null;
    verificationSha256?: string | null;
    modelVersion?: string;
    dimension: number | null;
    source: 'builtin' | 'custom';
    revision: number;
    createdAt: string;
    updatedAt: string;
    archivedAt?: string | null;
    modelPin?: string;
}

export interface IModelCatalog {
    items: ICatalogModel[];
    assignedModelIds: string[];
}

export interface IModelCreate {
    name: string;
    description: string;
    capability: ICatalogModel['capability'];
    model: string;
    dimension?: number | null;
    runtime?: ICatalogModel['runtime'];
    modelVersion?: string;
}

/** Приватные значения по умолчанию; пустые параметры оставляют выбор провайдеру. */
export interface IRemoteModelOptions {
    providerParameters?: import('../../../../services/shared/adapter-parameters.cjs').AdapterParameters;
    apiFormat?: 'chat-completions' | 'responses';
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    store?: boolean;
    temperature?: number; topP?: number; maxOutputTokens?: number; contextWindow?: number;
    responseModel?: string;
    tokenLimitParameter?: 'max_tokens' | 'max_completion_tokens';
}
export interface IRemoteConnectionHint { baseUrl: string; hasKey: boolean; options?: IRemoteModelOptions; timeoutMs?: number; }
/** Локальная сессия Codex остаётся у владельца компьютера; здесь только публичное состояние. */
export interface IDeviceCodexConnection {
    deviceId: string;
    deviceName: string;
    scope: 'global' | 'project';
    projectId?: string;
    connectionRevision: number;
    state?: 'ready' | 'unavailable' | 'error';
    status?: 'unverified';
    message: string;
    checkedAt?: string | null;
    lastInferenceAt?: string | null;
}
export interface IRemoteConnection {
    modelId: string; modelRevision: number; revision: number; baseUrl: string; requestDimensions: boolean;
    credential: 'none' | 'stored' | 'environment'; credentialEnv: string | null; hasKey: boolean;
    checkedAt: string | null; verified: boolean; canStoreKey: boolean;
    options: IRemoteModelOptions; timeoutMs: number;
}
export interface IRemoteConnectionInput {
    expectedRevision: number; expectedModelRevision: number; baseUrl: string; requestDimensions: boolean;
    credential: IRemoteConnection['credential']; apiKey?: string; credentialEnv?: string;
    options?: IRemoteModelOptions; timeoutMs?: number;
}

export type TModelHostingAction = 'start' | 'stop' | 'check';

export interface IModelHosting {
    state: 'unavailable' | 'missing' | 'stopped' | 'ready' | 'busy' | 'error';
    message: string;
    checkedAt: string | null;
    operation?: {
        id: string;
        action: TModelHostingAction;
        state: 'running' | 'completed' | 'failed';
        stage: string;
        message: string;
        progress: number | null;
        startedAt: string;
        finishedAt: string | null;
    };
}
