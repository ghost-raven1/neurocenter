import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { chatLearningFixture, projectId, reply, req } from './chat-learning.fixture';
import { connection, developer, main } from './agent-postgres.fixture';
import { ownedDeviceTestAdminUrl } from './device-completion-postgres.fixture';
import { ProjectChatService } from '../src/project-chat/project-chat.service';
import { ProjectChatInferenceService } from '../src/project-chat-inference/project-chat-inference.service';
import { ModelRuntime } from '../src/models/model-runtime';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import type { ModelsService } from '../src/models/models.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { IModel } from '../src/models/model.types';
import type { ChatMessage } from '../src/model-chat/chat.types';

export const adminUrl = process.env.PROJECT_CHAT_LEARNING_TEST_ADMIN_URL;
export { developer, main, projectId, req, reply };
export const mainReq = () => ({ headers: { 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
    'x-bridge-actor': encodeURIComponent(JSON.stringify(main)) } } as unknown as Request);

/** A test must explicitly identify its owned, non-default loopback PostgreSQL before the shared fixture opens a pool. */
export function assertOwnedChatLearningDatabase(): void {
    const owned = ownedDeviceTestAdminUrl(adminUrl ?? '');
    if (!connection || ownedDeviceTestAdminUrl(connection).href !== owned.href) throw new Error('CATALOG_TEST_PG_URL must match the explicitly owned project-chat learning admin URL.');
}

export function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
export async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned project-chat learning barrier timed out.')), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
}

/** Real room runner, learning/ACL SQL, usage journal and runtime admission; only Ollama transport and evaluated flag HTTP are fixtures. */
export async function projectChatLearningFixture() {
    assertOwnedChatLearningDatabase();
    const learning = await chatLearningFixture();
    let service: ProjectChatService | undefined, usage: ModelUsageService | undefined, inference: ProjectChatInferenceService | undefined;
    let targets: string[] = [];
    let admission: () => Promise<void> = async () => undefined;
    const calls: Array<{ agentId: string | null | undefined; messages: ChatMessage[] }> = [];
    const provider = { infer: vi.fn(async (_model: IModel, _endpoint: string, body: Record<string, unknown>) => {
        calls.push({ agentId: currentModelUsage().agentId, messages: structuredClone(body.messages as ChatMessage[]) });
        return reply('Ответ ' + currentModelUsage().agentId);
    }) };
    const setup = async () => {
        await learning.setup(32768); calls.length = 0; admission = async () => undefined; targets = [];
        await learning.pool.query('TRUNCATE model_usage_calls');
        provider.infer.mockClear();
        provider.infer.mockImplementation(async (_model, _endpoint, body) => {
            calls.push({ agentId: currentModelUsage().agentId, messages: structuredClone(body.messages as ChatMessage[]) });
            return reply('Ответ ' + currentModelUsage().agentId);
        });
        const models = learning.models as unknown as ModelsService;
        usage = new ModelUsageService(models);
        const begin = usage.repository.begin.bind(usage.repository);
        vi.spyOn(usage.repository, 'begin').mockImplementation(async value => { await begin(value); await admission(); });
        const remote = { infer: vi.fn(async () => { throw new Error('Unexpected remote provider.'); }) };
        const runtime = new ModelRuntime(provider as unknown as OllamaClient, remote as unknown as RemoteConnectionService, usage);
        inference = new ProjectChatInferenceService(models, runtime);
        vi.spyOn(inference, 'infer');
        service = new ProjectChatService(models, inference);
    };
    const configure = async (agentIds: string[]) => {
        const model = await learning.models.getUsable(), current = await service!.read(mainReq(), projectId);
        const result = await service!.participants(mainReq(), projectId, { expectedRevision: current.room.revision, agentIds, modelId: model.id, expectedModelPin: projectEmbeddingPin(model) });
        targets = [...agentIds]; return result;
    };
    const send = (agentIds = targets) => service!.send(req(), projectId, { requestKey: randomUUID(), prompt: 'Проверь проект', targetAgentIds: agentIds });
    const read = () => service!.read(req(), projectId);
    return { ...learning, provider, calls, setup, configure, send, read,
        get service() { return service!; }, get inference() { return inference!; },
        setAdmission(value: () => Promise<void>) { admission = value; },
        async cleanup() {
            await service?.onApplicationShutdown(); service = undefined;
            await usage?.onApplicationShutdown(); usage = undefined;
            await learning.cleanup();
        },
    };
}
