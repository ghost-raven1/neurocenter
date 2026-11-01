import { normalizeTextContext } from '../../../../shared/project-text-knowledge.cjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ModelChatService } from '../chat.service';
import type { ModelsService } from '../../models/models.service';
import type { ModelRuntime } from '../../models/model-runtime';

vi.mock('../../features/require-feature-enabled', () => ({
    requireFeatureEnabled: vi.fn(),
    requireFeaturesEnabled: vi.fn(),
}));
import { requireFeatureEnabled } from '../../features/require-feature-enabled';

const id = '1d8fbf80-4dd6-49ac-ae54-c64ff7770990';
const selection = { mode: 'text', revision: 3, corpusHash: 'a'.repeat(64), query: '  installation  ' };
const open: ModelChatService[] = [];
/** Storage and text retrieval are boundaries; preview, source projection and token calculation remain real. */
function fixture(projectId: string | null = 'prj-qa') {
    const model = { id: 'model-qa', runtime: 'remote-openai', name: 'QA', verificationSha256: 'b'.repeat(64) };
    const row = {
        id,
        owner: 'qa@localhost',
        project_id: projectId,
        model_id: model.id,
        mode: 'single',
        model_pin: 'c'.repeat(64),
    };
    const db = { query: vi.fn(async (_sql: string) => ({ rows: [{ options: { contextWindow: 100000 } }] })) };
    const models = {
        pool: db,
        actor: vi.fn(async () => ({ email: 'qa@localhost', activeRole: 'Разработчик' })),
        getUsable: vi.fn(async () => model),
        resolveProject: vi.fn(async () => ({ id: projectId, name: 'QA', state: 'active', headRevision: 1 })),
    };
    const runtime = { embeddings: vi.fn(), chat: vi.fn() };
    const service = new ModelChatService(models as unknown as ModelsService, runtime as unknown as ModelRuntime);
    open.push(service);
    vi.spyOn(service.repository, 'peek').mockResolvedValue(row as never);
    vi.spyOn(service.repository, 'owned').mockImplementation(async (_owner, _id, authorize, operation) => {
        await authorize();
        return operation(db as never, row as never);
    });
    vi.spyOn(service.repository, 'checkpoint').mockResolvedValue(null);
    vi.spyOn(service.repository, 'sources').mockResolvedValue({
        turns: [],
        overflow: false,
        omittedBytes: 0,
        omittedMessages: 0,
        omittedRequestBytes: 0,
    });
    const assertContext = vi
        .spyOn(service.projectContext.text, 'assertContext')
        .mockImplementation(async (_req, _project, value) => normalizeTextContext(value));
    const search = vi.spyOn(service.projectContext.text, 'search').mockResolvedValue({
        revision: 3,
        corpusHash: selection.corpusHash,
        sources: [
            {
                id: 'source-qa',
                path: 'guide.md',
                title: 'Guide',
                score: 1,
                excerpt: 'Bounded project quotation. '.repeat(20),
            },
        ],
    } as never);
    return { service, models, runtime, search, assertContext, db, row, model, req: { headers: {} } as Request };
}
afterEach(async () => {
    await Promise.all(open.splice(0).map((service) => service.pool.end()));
    vi.restoreAllMocks();
    vi.mocked(requireFeatureEnabled).mockReset();
});
describe('text knowledge preview', () => {
    it('accounts for selected project quotes without model inference or history writes', async () => {
        const f = fixture();
        const plain = await f.service.preview(f.req, id, { prompt: 'Explain' });
        const selected = await f.service.preview(f.req, id, { prompt: 'Explain', textContext: selection });
        expect(selected.estimatedInputTokens).toBeGreaterThan(plain.estimatedInputTokens);
        expect(selected.requestBytes).toBeGreaterThan(plain.requestBytes);
        expect(f.search).toHaveBeenCalledWith(
            f.req,
            'prj-qa',
            { query: selection.query, revision: 3 },
            expect.any(AbortSignal),
            undefined,
        );
        expect(f.runtime.embeddings).not.toHaveBeenCalled();
        expect(f.runtime.chat).not.toHaveBeenCalled();
        expect(f.db.query.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true);
    });
    it('counts quotes against each group participant budget', async () => {
        const f = fixture();
        f.row.mode = 'group';
        vi.spyOn(f.service.groups, 'plan').mockResolvedValue([
            {
                model: f.model,
                snapshot: {
                    agentId: 'agent-qa',
                    name: 'QA',
                    modelPin: 'c'.repeat(64),
                    definition: { prompt: 'System instructions' },
                },
            },
        ] as never);
        const plain = await f.service.preview(f.req, id, { prompt: 'Explain' });
        const selected = await f.service.preview(f.req, id, { prompt: 'Explain', textContext: selection });
        expect(selected.participants?.[0].context.estimatedInputTokens).toBeGreaterThan(
            plain.participants![0].context.estimatedInputTokens,
        );
        expect(selected.estimatedInputTokens).toBe(selected.participants?.[0].context.estimatedInputTokens);
    });
    it('reports that selected quotes exceed a small context window', async () => {
        const f = fixture();
        f.db.query.mockResolvedValue({ rows: [{ options: { contextWindow: 100 } }] });
        expect((await f.service.preview(f.req, id, { prompt: 'Explain' })).exceeded).toBe(false);
        expect((await f.service.preview(f.req, id, { prompt: 'Explain', textContext: selection })).exceeded).toBe(true);
    });
    it('rejects stale corpus before returning an estimate', async () => {
        const f = fixture();
        f.assertContext.mockRejectedValue(new ConflictException('Corpus changed'));
        await expect(f.service.preview(f.req, id, { textContext: selection })).rejects.toThrow('Corpus changed');
        expect(f.search).not.toHaveBeenCalled();
    });
    it('keeps current project access and feature admission', async () => {
        const f = fixture();
        f.assertContext.mockRejectedValue(new ForbiddenException('Access revoked'));
        await expect(f.service.preview(f.req, id, { textContext: selection })).rejects.toThrow('Access revoked');
        vi.mocked(requireFeatureEnabled).mockRejectedValueOnce(new ForbiddenException('Feature disabled'));
        await expect(f.service.preview(f.req, id, { textContext: selection })).rejects.toThrow('Feature disabled');
    });
    it('rejects malformed selection and personal conversations', async () => {
        const f = fixture(null);
        await expect(f.service.preview(f.req, id, { textContext: { ...selection, revision: -1 } })).rejects.toThrow();
        await expect(f.service.preview(f.req, id, { textContext: selection })).rejects.toThrow('проекта');
        expect(f.search).not.toHaveBeenCalled();
    });
});
