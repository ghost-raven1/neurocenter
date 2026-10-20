import type { IModel } from './model.types';

export interface IRemoteModelConnection {
    modelId: string;
    revision: number;
    baseUrl: string;
    requestDimensions: boolean;
    apiKey?: string;
}

export interface IRemoteConnectionView {
    modelId: string;
    revision: number;
    baseUrl: string;
    requestDimensions: boolean;
    credential: 'none' | 'stored' | 'environment';
    credentialEnv: string | null;
    hasKey: boolean;
    checkedAt: string | null;
    verified: boolean;
    canStoreKey: boolean;
}

export interface IRemoteConnectionInput {
    expectedRevision: number;
    expectedModelRevision: number;
    baseUrl: string;
    requestDimensions: boolean;
    credential: 'none' | 'stored' | 'environment';
    apiKey?: string;
    credentialEnv?: string;
}

export type RemoteModel = IModel & { runtime: 'remote-openai' | 'remote-ollama'; modelVersion: string };
export const isRemoteModel = (model: Pick<IModel, 'runtime'>): boolean => model.runtime === 'remote-openai' || model.runtime === 'remote-ollama';
