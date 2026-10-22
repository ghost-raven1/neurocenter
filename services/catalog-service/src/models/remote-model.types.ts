import type { IModel } from './model.types';

/** Optional generation defaults; absent values are chosen by the provider. */
export interface IRemoteModelOptions {
    /** OpenAI only: exact response identity when the requested name is an alias. */
    responseModel?: string;
    /** OpenAI chat/vision only; omitted values retain the legacy max_tokens wire format. */
    tokenLimitParameter?: 'max_tokens' | 'max_completion_tokens';
    /** Optional number from 0 to 2; omitted values use the provider default. */
    temperature?: number;
    /** Optional nucleus sampling probability from 0 to 1. */
    topP?: number;
    /** Optional integer from 1 to 32768. */
    maxOutputTokens?: number;
    /** Remote Ollama chat/vision only; integer from 128 to 2097152. */
    contextWindow?: number;
}

export interface IRemoteModelConnection {
    modelId: string;
    revision: number;
    baseUrl: string;
    requestDimensions: boolean;
    options?: IRemoteModelOptions;
    timeoutMs?: number;
    apiKey?: string;
}

export interface IRemoteConnectionView {
    modelId: string;
    modelRevision: number;
    revision: number;
    baseUrl: string;
    requestDimensions: boolean;
    options: IRemoteModelOptions;
    timeoutMs: number;
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
    options?: IRemoteModelOptions;
    /** Integer from 1000 to 300000 milliseconds; default 90000. */
    timeoutMs?: number;
    credential: 'none' | 'stored' | 'environment';
    /** Write-only API key. Omit only to retain an existing stored key; never returned by the API. */
    apiKey?: string;
    credentialEnv?: string;
}

export type RemoteModel = IModel & { runtime: 'remote-openai' | 'remote-ollama'; modelVersion: string };
export const isRemoteModel = (model: Pick<IModel, 'runtime'>): boolean => model.runtime === 'remote-openai' || model.runtime === 'remote-ollama';
