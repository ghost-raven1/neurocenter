import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { chatLearningFixture, projectId, req, reply } from './chat-learning.fixture';
import { adminUrl, assertOwnedChatLearningDatabase, bounded, deferred, developer, mainReq } from './project-chat-learning-receipt.fixture';
import { ProjectChatService } from '../src/project-chat/project-chat.service';
import { ProjectChatInferenceService } from '../src/project-chat-inference/project-chat-inference.service';
import { ModelRuntime } from '../src/models/model-runtime';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import type { ModelsService } from '../src/models/models.service';
import type { IModel } from '../src/models/model.types';
import type { OllamaClient } from '../src/models/ollama-client';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import type { DeviceCodexService } from '../src/models/device-codex.service';
import type { ChatMessage } from '../src/model-chat/chat.types';
import { DEFAULT_PROJECT_CHAT_ROOM } from '../src/project-chat/project-chat.types';

export { adminUrl, bounded, deferred, projectId, developer, req, reply };
export type IsolationLane = 'server' | 'device-codex';
export interface IsolationCall { lane: IsolationLane; agentId: string; sourceId: string; signal: AbortSignal; messages: ChatMessage[] }

export async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5000;
    for (;;) {
        const value = await read(); if (ready(value)) return value;
        if (Date.now() >= deadline) throw new Error('Owned room isolation condition timed out.');
        await new Promise(resolve => setImmediate(resolve));
    }
}

/** Real room/inference/runtime/usage SQL; only evaluated flags and final provider transports are fixtures. */
export async function projectChatIsolationFixture() {
    assertOwnedChatLearningDatabase();
    const learning = await chatLearningFixture();
    let service: ProjectChatService | undefined, usage: ModelUsageService | undefined;
    const calls: IsolationCall[] = [], active = { server: 0, 'device-codex': 0 }, maximum = { ...active };
    const handlers = new Map<string, (call: IsolationCall) => Promise<Record<string, unknown>>>();
    const releases = new Set<() => void>();
    const provider = { infer: vi.fn(async (model: IModel, _endpoint: string, body: Record<string, unknown>, signal?: AbortSignal) => {
        const context = currentModelUsage(), lane: IsolationLane = model.runtime === 'device-codex' ? 'device-codex' : 'server';
        const call: IsolationCall = { lane, agentId: context.agentId!, sourceId: context.turnId!, signal: signal!, messages: structuredClone(body.messages as ChatMessage[]) };
        calls.push(call); active[lane]++; maximum[lane] = Math.max(maximum[lane], active[lane]);
        try { return await (handlers.get(call.agentId)?.(call) ?? Promise.resolve(reply('Answer ' + call.agentId))); }
        finally { active[lane]--; }
    }) };
    const setup = async () => {
        await learning.setup(32768); await learning.pool.query('TRUNCATE model_usage_calls');
        calls.length = 0; handlers.clear(); provider.infer.mockClear();
        active.server = 0; active['device-codex'] = 0; maximum.server = 0; maximum['device-codex'] = 0;
        const base = await learning.models.getUsable();
        const device: IModel = { ...base, id: 'model-team-device', name: 'Device fixture', runtime: 'device-codex', model: 'codex-fixture', manifestSha256: null, verificationSha256: 'b'.repeat(64), modelVersion: 'fixture-v1' };
        await learning.pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3)', [device.id, device.name, device]);
        await learning.pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [projectId, device.id, developer.email]);
        const models = learning.models as unknown as ModelsService;
        usage = new ModelUsageService(models);
        const remote = { infer: vi.fn(async () => { throw new Error('Unexpected remote provider.'); }) };
        const runtime = new ModelRuntime(provider as unknown as OllamaClient, remote as unknown as RemoteConnectionService, usage, provider as unknown as DeviceCodexService);
        service = new ProjectChatService(models, new ProjectChatInferenceService(models, runtime));
    };
    const agent = async (name: string, lane: IsolationLane = 'server') => {
        const card = await learning.agent(name);
        if (lane === 'device-codex') await learning.pool.query('UPDATE project_agents SET overrides=$3 WHERE project_id=$1 AND agent_id=$2', [projectId, card.id, { model: 'neurocenter/model-team-device' }]);
        return card;
    };
    const room = (visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') => service!.createRoom(mainReq(), projectId, { requestKey: randomUUID(), title: 'Isolation ' + randomUUID(), visibility, memberEmails: visibility === 'PRIVATE' ? [developer.email] : [] });
    const configure = async (roomId: string, agentIds: string[]) => {
        const model = await learning.models.getUsable(), detail = await service!.read(mainReq(), projectId, undefined, roomId);
        return service!.participants(mainReq(), projectId, { expectedRevision: detail.room.revision, agentIds, modelId: model.id, expectedModelPin: projectEmbeddingPin(model) }, roomId);
    };
    const send = (roomId: string, agentIds: string[], prompt = 'Question ' + randomUUID()) => service!.send(req(), projectId, { requestKey: randomUUID(), prompt, targetAgentIds: agentIds }, roomId);
    const rows = async (sourceId: string) => (await learning.pool.query('SELECT * FROM project_chat_messages WHERE id=$1 OR source_message_id=$1 ORDER BY position', [sourceId])).rows;
    const hold = (agentId: string, releaseOnAbort = false) => {
        const entered = deferred(), release = deferred(), aborted = deferred(); releases.add(release.resolve);
        handlers.set(agentId, async call => {
            const onAbort = () => { aborted.resolve(); if (releaseOnAbort) release.resolve(); };
            call.signal.addEventListener('abort', onAbort, { once: true }); entered.resolve();
            try { await release.promise; return reply('HELD OUTPUT ' + call.agentId); }
            finally { call.signal.removeEventListener('abort', onAbort); }
        });
        return { entered: entered.promise, release: release.resolve, aborted: aborted.promise };
    };
    return { ...learning, setup, agent, room, configure, send, rows, hold, calls, handlers, active, maximum, defaultRoom: DEFAULT_PROJECT_CHAT_ROOM,
        get service() { return service!; },
        async cleanup() {
            for (const release of releases) release(); releases.clear();
            await service?.onApplicationShutdown(); service = undefined;
            await usage?.onApplicationShutdown(); usage = undefined;
            await learning.cleanup();
        },
    };
}
