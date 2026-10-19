/** Модель общего каталога; назначение проекту не запускает хостинг. */
export interface ICatalogModel {
    id: string;
    name: string;
    description: string;
    capability: 'embedding' | 'vision' | 'chat';
    runtime: 'ollama';
    model: string;
    manifestSha256: string | null;
    dimension: number | null;
    source: 'builtin' | 'custom';
    revision: number;
    createdAt: string;
    updatedAt: string;
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
    dimension?: number;
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
