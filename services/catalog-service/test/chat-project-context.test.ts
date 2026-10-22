import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { ModelChatProjectContext } from '../src/model-chat/chat-project-context';
import { ProjectEmbeddingRepository } from '../src/models/project-embedding.repository';
import {readFeatures,FeatureFlagError} from '../../shared/feature-client.cjs';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { requireFeatureEnabled } from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled', () => ({ requireFeatureEnabled: vi.fn(async () => {}) }));
vi.mock('../../shared/feature-client.cjs',async original=>({...await original<typeof import('../../shared/feature-client.cjs')>(),readFeatures:vi.fn(async()=>({flags:{project_search:true},blockedBy:{}}))}));
const project = { id: 'prj-research', name: 'Исследование', state: 'ACTIVE', headRevision: 1 };
const model = { id: 'model-embedding', model: 'embedding', capability: 'embedding' };
const selection = () => ({ revision: 2, dataRevision: 4, activeGeneration: 'initial-' + 'a'.repeat(32), activeSnapshot: 'b'.repeat(64),
    profile: { provider: 'openai', model: 'embedding', dimension: 3 }, expectedDimension: 3, model });
const req = {} as Request;
let current: ReturnType<typeof selection> & { blocker?: string };
let models: any, runtime: any, context: ModelChatProjectContext;
const source = (id = 'source') => ({ id, path: 'src/research.ts', startLine: 3, endLine: 7, score: 0.8, excerpt: 'Найденное знание' });
beforeEach(() => {
    vi.restoreAllMocks(); current = selection();
    vi.mocked(requireFeatureEnabled).mockReset().mockResolvedValue(undefined);
    vi.mocked(readFeatures).mockResolvedValue({flags:{project_search:true},blockedBy:{}} as never);
    vi.spyOn(ProjectEmbeddingRepository.prototype, 'read').mockImplementation(async () => current as any);
    models = { pool: { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) }, resolveProject: vi.fn(async () => ({ ...project })) };
    runtime = { infer: vi.fn(async () => ({ embeddings: [[1, 2, 3]] })) };
    context = new ModelChatProjectContext(models, runtime);
    vi.spyOn(context.client, 'call').mockImplementation(async () => ({ generation: current.activeGeneration, snapshot: current.activeSnapshot, sources: [source()] }) as any);
});
describe('Ephemeral chat project context', () => {
    it('An explicit search off gives honest project metadata without embedding or RAG calls',async()=>{
        vi.mocked(readFeatures).mockResolvedValue({flags:{project_search:false},blockedBy:{}} as never);
        const prepared=await context.prepare(req,project.id,'question',new AbortController().signal);
        expect(prepared.evidence).toMatchObject({status:'metadata',sources:[],message:expect.stringContaining('отключён')});
        expect(runtime.infer).not.toHaveBeenCalled();expect(context.client.call).not.toHaveBeenCalled();
    });
    it('An unavailable flag service is not represented as a disabled or empty search',async()=>{
        const error=Object.assign(new Error('Проверка функций недоступна'),{status:503,code:'feature-flags-unavailable'});Object.setPrototypeOf(error,FeatureFlagError.prototype);
        vi.mocked(readFeatures).mockRejectedValue(error);
        await expect(context.prepare(req,project.id,'question',new AbortController().signal)).rejects.toMatchObject({status:503});expect(runtime.infer).not.toHaveBeenCalled();
    });
    it('No project never searches or reads another project', async () => {
        const prepared = await context.prepare(req, null, 'question', new AbortController().signal);
        expect(prepared.messages).toEqual([]); expect(prepared.evidence.status).toBe('none');
        expect(prepared.fit([{ role: 'user', content: 'hello' }], {}).messages).toHaveLength(1);
        expect(models.resolveProject).not.toHaveBeenCalled(); expect(runtime.infer).not.toHaveBeenCalled();
    });
    it('Overview has no inference; absent embedding model gives honest metadata', async () => {
        current.blocker = 'Выберите embedding-модель проекта.';
        expect(await context.overview(req, project.id)).toMatchObject({ status: 'metadata', message: current.blocker });
        const prepared = await context.prepare(req, project.id, 'question', new AbortController().signal);
        expect(prepared.evidence.status).toBe('metadata'); expect(runtime.infer).not.toHaveBeenCalled(); expect(context.client.call).not.toHaveBeenCalled();
    });
    it('Embeds through the selected project model and sends exact immutable index identity', async () => {
        const prepared = await context.prepare(req, project.id, 'question', new AbortController().signal);
        expect(runtime.infer).toHaveBeenCalledWith(model, 'embed', { input: ['question'], truncate: false }, expect.any(AbortSignal));
        expect(context.client.call).toHaveBeenCalledWith('search', { projectId: project.id, revision: 2, dataRevision: 4, generation: current.activeGeneration,
            snapshot: current.activeSnapshot, profile: current.profile, embedding: [1, 2, 3] }, expect.any(AbortSignal));
        expect(prepared.messages[0].role).toBe('user'); expect(prepared.evidence.sources).toEqual([source()]);
        expect(prepared.messages[0].content).toContain('справочные данные');
    });
    it('Does not disguise an incomplete index or in-progress sync as an empty search', async () => {
        current.activeSnapshot = null as any;
        await expect(context.prepare(req, project.id, 'question', new AbortController().signal)).rejects.toMatchObject({ status: 409 });
        current = selection(); models.pool.query.mockResolvedValue({ rows: [{}], rowCount: 1 });
        await expect(context.prepare(req, project.id, 'question', new AbortController().signal)).rejects.toMatchObject({ status: 409 });
        expect(runtime.infer).not.toHaveBeenCalled();
    });
    it.each([[], [[1, 2]], [[0, 0, 0]], [[NaN, 2, 3]], [[1e100, 2, 3]], [[1, 2, 3], [1, 2, 3]]])('Rejects malformed embedding %j', async embeddings => {
        runtime.infer.mockResolvedValue({ embeddings });
        await expect(context.prepare(req, project.id, 'question', new AbortController().signal)).rejects.toMatchObject({ status: 503 });
        expect(context.client.call).not.toHaveBeenCalled();
    });
    it('Rechecks current project permissions and index before using a late embedding response', async () => {
        runtime.infer.mockImplementation(async () => { current.dataRevision++; return { embeddings: [[1, 2, 3]] }; });
        await expect(context.prepare(req, project.id, 'question', new AbortController().signal)).rejects.toMatchObject({ status: 409 });
        expect(context.client.call).not.toHaveBeenCalled();
    });
    it.each([new ForbiddenException('Поиск отключён'), new ServiceUnavailableException('Флаги недоступны')])('rechecks search admission after a paid embedding and blocks the next tool on %s', async error => {
        runtime.infer.mockImplementationOnce(async () => {
            vi.mocked(requireFeatureEnabled).mockRejectedValueOnce(error);
            return { embeddings: [[1, 2, 3]] };
        });
        await expect(context.prepare(req, project.id, 'question', new AbortController().signal)).rejects.toBe(error);
        expect(runtime.infer).toHaveBeenCalledOnce(); expect(context.client.call).not.toHaveBeenCalled();
        expect(vi.mocked(requireFeatureEnabled).mock.calls.map(call => call[0])).toEqual(['model_hosting', 'project_search']);
    });
    it('Cancellation and later permission revocation discard prepared material', async () => {
        const abort = new AbortController(), prepared = await context.prepare(req, project.id, 'question', abort.signal);
        models.resolveProject.mockRejectedValue(Object.assign(new Error('revoked'), { status: 403 }));
        await expect(prepared.assertCurrent()).rejects.toMatchObject({ status: 403 });
        abort.abort(); await expect(prepared.assertCurrent()).rejects.toMatchObject({ name: 'AbortError' });
    });
    it('Rejects untrusted results from the wrong generation, duplicate sources and malformed scores', async () => {
        for (const replacement of [{ generation: 'other', snapshot: current.activeSnapshot, sources: [] },
            { generation: current.activeGeneration, snapshot: current.activeSnapshot, sources: [source(), source()] },
            { generation: current.activeGeneration, snapshot: current.activeSnapshot, sources: [{ ...source(), score: NaN }] }]) {
            vi.mocked(context.client.call).mockResolvedValueOnce(replacement);
            await expect(context.prepare(req, project.id, 'question', new AbortController().signal)).rejects.toMatchObject({ status: 503 });
        }
    });
    it('Empty results are distinguished from missing configuration', async () => {
        vi.mocked(context.client.call).mockResolvedValueOnce({ generation: current.activeGeneration, snapshot: current.activeSnapshot, sources: [] });
        const prepared = await context.prepare(req, project.id, 'question', new AbortController().signal);
        expect(prepared.evidence.status).toBe('empty'); expect(prepared.messages[0].content).toContain('не придумывай источники');
    });
    it('Fits evidence per participant window without truncating user messages or mutating the shared round', async () => {
        vi.mocked(context.client.call).mockResolvedValueOnce({ generation: current.activeGeneration, snapshot: current.activeSnapshot,
            sources: Array.from({ length: 6 }, (_, i) => ({ ...source(String(i)), excerpt: '界'.repeat(900) })) });
        const prepared = await context.prepare(req, project.id, 'question', new AbortController().signal), original = JSON.stringify(prepared.evidence);
        const history = [{ role: 'user' as const, content: 'Вопрос' }];
        const small = prepared.fit(history, { contextWindowTokens: 1800, reservedOutputTokens: 128 }), large = prepared.fit(history, { contextWindowTokens: 16000 });
        expect(small.evidence.sources.length).toBeLessThan(large.evidence.sources.length); expect(small.messages.at(-1)).toEqual(history[0]);
        expect(JSON.stringify(prepared.evidence)).toBe(original); expect(large.evidence.sources).toHaveLength(6);
        expect(() => prepared.fit(history, { contextWindowTokens: 128 })).toThrow('не помещается');
    });
});
