import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { database, reset, main, developer } from './agent-postgres.fixture';
import { AgentRepository } from '../src/agents/agent.repository';
import { LearningRepository } from '../src/learning/learning.repository';
import { ModelChatService } from '../src/model-chat/chat.service';
import { COMPACTION_INSTRUCTION } from '../src/model-chat/chat-compaction';
import { ModelChatProjectContext } from '../src/model-chat/chat-project-context';
import type { ChatDetail } from '../src/model-chat/chat.types';
import type { ModelsService } from '../src/models/models.service';
import type { ModelRuntime } from '../src/models/model-runtime';
import type { IModel } from '../src/models/model.types';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import { AccessDb } from '../src/access/access-db';
import { readModelActor } from '../src/models/model-access';
import { saveModelVersion, type IModelRow } from '../src/models/model-history';
import { initialGeneration } from '../src/models/project-embedding.repository';

export const projectId = 'prj-agents';
export const req = (email = developer.email) => ({ headers: { 'x-owner': email, 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
    'x-bridge-actor': encodeURIComponent(JSON.stringify({ email, activeRole: 'Разработчик' })) } } as unknown as Request);
export const reply = (content: string) => ({ message: { role: 'assistant', content }, done_reason: 'stop', usage_reported: false });
const model: IModel = { id: 'model-learning-chat', name: 'Learning chat fixture', description: '', capability: 'chat', runtime: 'ollama', model: 'fixture:chat',
    manifestSha256: 'a'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '' };
const origin = { origin: 'human' as const, device: null };

/** Real private chat/learning transactions and ACL rows; only provider, RAG transport and evaluated flag HTTP are fixtures. */
export async function chatLearningFixture() {
    const owned = await database(), pool = owned.pool, repository = new LearningRepository(pool);
    const access = new AccessDb(); await (access as unknown as { pool: typeof pool }).pool.end(); Object.defineProperty(access, 'pool', { value: pool });
    let service: ModelChatService | undefined, enabled = true, flagFailure = false;
    const runtime = { infer: vi.fn(async (_model: IModel, _endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const messages = body.messages as Array<{ content: string }>;
        return reply(messages[0]?.content === COMPACTION_INSTRUCTION ? 'Краткое резюме.' : 'Ответ ' + currentModelUsage().agentId);
    }) };
    const models = { pool, ready: async () => undefined,
        actor: (request: Request) => readModelActor(request, access),
        getUsable: vi.fn(async () => model), list: async () => ({ items: [model], assignedModelIds: [model.id] }),
        resolveProject: async (_request: Request, id: string) => ({ id, name: 'Learning project', state: 'active', headRevision: 0 }) };
    const setup = async (contextWindow = 4096) => {
        await pool.query('TRUNCATE project_retirements CASCADE'); await reset(pool); await pool.query('TRUNCATE model_catalog CASCADE'); enabled = true; flagFailure = false;
        vi.stubEnv('CATALOG_PG_URL', String(pool.options.connectionString)); vi.stubEnv('MODEL_CHAT_CONTEXT_WINDOW_TOKENS', String(contextWindow));
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'chat-learning-test-only');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(flagFailure ? { message: 'Unavailable' }
            : evaluateFeatureFlags({ ...defaultFeatureFlags(), project_learning: enabled, group_discussions: false })), { status: flagFailure ? 503 : 200 })));
        await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)', [model.id, model.name, JSON.stringify(model)]);
        await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [projectId, model.id, developer.email]);
        runtime.infer.mockReset(); runtime.infer.mockImplementation(async (_model, _endpoint, body) => {
            const messages = body.messages as Array<{ content: string }>;
            return reply(messages[0]?.content === COMPACTION_INSTRUCTION ? 'Краткое резюме.' : 'Ответ ' + currentModelUsage().agentId);
        });
        service = new ModelChatService(models as unknown as ModelsService, runtime as unknown as ModelRuntime);
        const evidence = { status: 'metadata' as const, project: { id: projectId, name: 'Learning project', state: 'active', headRevision: 0 }, sources: [] };
        service.projectContext = { overview: async () => evidence, prepare: async () => ({ evidence, messages: [], assertCurrent: async () => undefined,
            fit: (history: unknown[]) => ({ messages: history, evidence }) }) } as unknown as ModelChatProjectContext;
    };
    const agent = async (name: string) => {
        const id = 'agent-' + randomUUID(), card = await new AgentRepository(pool).write(pool, id, { slug: 'nc-' + randomUUID().slice(0, 8), name,
            definition: { description: name, prompt: 'Persona ' + name, mode: 'all', permission: {} } }, 1);
        await pool.query('INSERT INTO project_agent_sets(project_id) VALUES($1) ON CONFLICT DO NOTHING', [projectId]);
        await pool.query('INSERT INTO project_agents(project_id,agent_id,version,manifest,enabled,added_by,updated_by) VALUES($1,$2,1,$3,true,$4,$4)', [projectId, id, card.manifest, developer.email]); return card;
    };
    const mutation = async (id = projectId) => ({ requestKey: randomUUID(), expectedRevision: await repository.revision(id) });
    const experience = async (id = projectId) => repository.addExperience(main, id, { ...await mutation(id), title: 'Наблюдение', summary: 'Подтверждаемый факт', outcome: 'unknown',
        evidence: [{ kind: 'test', status: 'passed', summary: 'Фикстура проверила факт.' }] }, origin);
    const knowledge = async (key: string, content: string, targetAgentId?: string, options: { projectId?: string; approve?: boolean } = {}) => {
        const id = options.projectId ?? projectId, source = await experience(id);
        const proposed = await repository.addHypotheses(main, id, { ...await mutation(id), hypotheses: [{ subject: 'project', title: 'Гипотеза', statement: 'Есть подтверждаемый факт.',
            rationale: 'Основание сохранено.', verificationPlan: 'Проверить вручную.', experienceIds: [source.result.experience.id] }] }, origin);
        const hypothesis = proposed.result.hypotheses[0], checked = await repository.addCheck(main, id, hypothesis.id, { ...await mutation(id), method: 'human_review', result: 'passed',
            summary: 'Человек подтвердил применимость.', experienceIds: [source.result.experience.id] });
        const result = await repository.addCandidate(main, id, { ...await mutation(id), hypothesisId: hypothesis.id, checkId: checked.result.check.id, key, kind: 'lesson',
            title: 'Знание ' + key, content, ...(targetAgentId ? { targetAgentId } : {}) });
        if (options.approve !== false) await repository.candidateAction(main, id, result.result.candidate.id, await mutation(id), 'approve');
        return result.result.candidate;
    };
    const revoke = async (id: string) => repository.candidateAction(main, projectId, id, await mutation(), 'revoke');
    const configureRag = async () => {
        const embedding: IModel = { ...model, id: 'model-learning-embedding', name: 'Learning embedding fixture', model: 'fixture:embedding', capability: 'embedding', dimension: 3 };
        const row = (await pool.query<IModelRow>('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb) RETURNING *', [embedding.id, embedding.name, JSON.stringify(embedding)])).rows[0];
        await saveModelVersion(pool, row);
        await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [projectId, embedding.id, developer.email]);
        const generation = initialGeneration(projectId), snapshot = 'b'.repeat(64);
        await pool.query(`INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation,active_snapshot,data_revision)
            VALUES($1,1,$2,$3,3,$4,$5,$6,1)`, [projectId, embedding.id, projectEmbeddingPin(embedding), developer.email, generation, snapshot]);
        service!.projectContext = new ModelChatProjectContext(models as unknown as ModelsService, runtime);
        const search = vi.spyOn(service!.projectContext.client, 'call').mockImplementation(async () => ({ generation, snapshot, sources: [] }) as never);
        const previous = runtime.infer.getMockImplementation()!;
        runtime.infer.mockImplementation(async (...args) => args[1] === 'embed' ? { embeddings: [[1, 2, 3]] } : previous(...args));
        return search;
    };
    const create = (ids: string[]) => service!.create(req(), { modelId: model.id, projectId, expectedModelPin: projectEmbeddingPin(model), mode: 'group', agentIds: ids });
    const send = (detail: ChatDetail, targets?: string[], requestId = randomUUID(), research = false, signal = new AbortController().signal) => service!.send(req(), detail.conversation.id, {
        expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin, requestId, prompt: 'Ответь на вопрос', attachmentIds: [],
        ...(targets ? { targetAgentIds: targets } : {}), ...(research ? { research: { project: true } } : {}) }, signal);
    const retry = (detail: ChatDetail) => service!.retry(req(), detail.conversation.id, detail.turns.at(-1)!.id, {
        expectedRevision: detail.conversation.revision, expectedModelPin: detail.conversation.modelPin, requestId: randomUUID() }, new AbortController().signal);
    return { pool, repository, runtime, models, agent, knowledge, experience, revoke, create, send, retry, setup, configureRag,
        get service() { return service!; }, setEnabled(value: boolean) { enabled = value; }, failFlags() { flagFailure = true; },
        async cleanup() { const current = service; service = undefined; await current?.onApplicationShutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }, close: owned.close };
}
