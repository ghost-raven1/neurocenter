import { Injectable } from '@nestjs/common';
import type { IModel } from './model.types';
import { OllamaClient } from './ollama-client';
import { RemoteConnectionService } from './remote-connection.service';
import { isRemoteModel } from './remote-model.types';

export interface IModelInferenceRuntime {
    infer(model: IModel, endpoint: 'embed' | 'chat', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/** Единственный dispatcher для OpenAI/Ollama API, OpenCode RAG и раздела данных. */
@Injectable()
export class ModelRuntime implements IModelInferenceRuntime {
    constructor(private readonly local: OllamaClient, private readonly remote: RemoteConnectionService) {}
    infer(model: IModel, endpoint: 'embed' | 'chat', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
        if (model.runtime === 'ollama') return this.local.infer(model, endpoint, body, signal);
        if (isRemoteModel(model)) return this.remote.infer(model, endpoint, body, signal);
        return Promise.reject(new Error('Неподдерживаемый runtime модели.'));
    }
}
