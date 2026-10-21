import { Injectable } from '@nestjs/common';
import type { IModel } from './model.types';
import { OllamaClient } from './ollama-client';
import { RemoteConnectionService } from './remote-connection.service';
import { isRemoteModel } from './remote-model.types';
import { ModelUsageService } from '../model-usage/model-usage.service';
import {currentModelUsage} from '../model-usage/model-usage.context';
import {requiredInferenceFeatures} from '../../../shared/feature-policy.cjs';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';

export interface IModelInferenceRuntime {
    infer(model: IModel, endpoint: 'embed' | 'chat', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/** Единственный dispatcher для OpenAI/Ollama API, OpenCode RAG и раздела данных. */
@Injectable()
export class ModelRuntime implements IModelInferenceRuntime {
    constructor(private readonly local: OllamaClient, private readonly remote: RemoteConnectionService, private readonly usage?: ModelUsageService) {}
    async infer(model: IModel, endpoint: 'embed' | 'chat', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const context=currentModelUsage();await requireFeaturesEnabled([...requiredInferenceFeatures(context.purpose,context.agentId),...(context.requiredFeatures??[])],process.env,globalThis.fetch,signal);signal?.throwIfAborted();
        if (this.usage) return this.usage.observe(model, endpoint, signal => this.dispatch(model, endpoint, body, signal), signal);
        return this.dispatch(model, endpoint, body, signal);
    }
    private dispatch(model: IModel, endpoint: 'embed' | 'chat', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
        if (model.runtime === 'ollama') return this.local.infer(model, endpoint, body, signal);
        if (isRemoteModel(model)) return this.remote.infer(model, endpoint, body, signal);
        return Promise.reject(new Error('Неподдерживаемый runtime модели.'));
    }
}
