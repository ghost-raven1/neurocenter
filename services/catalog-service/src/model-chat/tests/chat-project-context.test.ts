import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import { ModelChatProjectContext } from '../chat-project-context';
import type { ModelsService } from '../../models/models.service';
import type { IModelInferenceRuntime } from '../../models/model-runtime';
import type { ITextContext } from '../../../../shared/project-text-knowledge.cjs';
import {
    DEFAULT_RUNTIME_LIMIT_POLICY,
} from '../../../../shared/runtime-limits.cjs';

vi.mock('../../features/require-feature-enabled', () => ({
    requireFeatureEnabled: vi.fn(async () => undefined),
    requireFeaturesEnabled: vi.fn(async () => undefined),
}));
import { requireFeatureEnabled } from '../../features/require-feature-enabled';

const projectId = 'prj-qa';
const corpusHash = 'a'.repeat(64);
const req = () => ({ headers: {} }) as Request;
const selection = (revision: number, query: string): ITextContext => ({
    mode: 'text',
    revision,
    corpusHash,
    query,
});
const fullPolicy = () => ({
    textKnowledge: { ...DEFAULT_RUNTIME_LIMIT_POLICY.textKnowledge },
    ggufImport: { ...DEFAULT_RUNTIME_LIMIT_POLICY.ggufImport },
});

/** Текст-база и лимиты — на границе: RAG-стейт и runtime_limit_settings фикстурами. */
function fixture(settings: { revision: number; policy: unknown } | null) {
    const db = {
        query: vi.fn(async (sql: string) => {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (s === 'SELECT revision,policy,updated_at FROM runtime_limit_settings WHERE singleton')
                return settings
                    ? { rows: [{ revision: settings.revision, policy: settings.policy, updated_at: '2026-01-02T03:04:05Z' }] }
                    : { rows: [] };
            throw new Error('Непредвиденный SQL: ' + s);
        }),
    };
    const models = {
        pool: db,
        actor: vi.fn(async () => ({ email: 'qa@localhost', activeRole: 'Разработчик' })),
        requireMain: vi.fn(async () => 'qa@localhost'),
        resolveProject: vi.fn(async () => ({ id: projectId, name: 'QA', state: 'active', headRevision: 1 })),
    };
    const service = new ModelChatProjectContext(models as unknown as ModelsService, {} as IModelInferenceRuntime);
    vi.spyOn(service.text.client, 'call').mockResolvedValue({
        mode: 'text',
        projectId,
        revision: 7,
        corpusHash,
        documentCount: 1,
        bytes: 42,
        updatedAt: null,
    } as never);
    return { service, db };
}

describe('ModelChatProjectContext.captureText', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('принимает контекст и фиксирует admission действующей политики', async () => {
        const { service } = fixture({ revision: 7, policy: fullPolicy() });
        const capture = await service.captureText(req(), projectId, selection(7, '  установка  '));
        expect(capture.searchEnabled).toBe(true);
        expect(capture.evidence.status).toBe('metadata');
        expect(capture.evidence.textRevision).toBe(7);
        expect(capture.evidence.corpusHash).toBe(corpusHash);
        expect(capture.evidence.textAdmission).toEqual({
            revision: 7,
            limits: DEFAULT_RUNTIME_LIMIT_POLICY.textKnowledge,
        });
        expect(requireFeatureEnabled).toHaveBeenCalledWith('project_text_knowledge');
    });

    it('запрос длиннее policy.queryBytes действующей политики — 400 с её значением', async () => {
        const policy = fullPolicy();
        (policy.textKnowledge as { queryBytes: number }).queryBytes = 10;
        const { service } = fixture({ revision: 4, policy });
        const error: unknown = await service
            .captureText(req(), projectId, selection(4, 'a'.repeat(12)))
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(String((error as BadRequestException).message)).toContain('10');
    });

    it('без строки — действует дефолт 2048 байт', async () => {
        const { service } = fixture(null);
        const error: unknown = await service
            .captureText(req(), projectId, selection(7, 'a'.repeat(2049)))
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(String((error as BadRequestException).message)).toContain('2048');
    });

    it('база изменилась после выбора — 409', async () => {
        const { service } = fixture({ revision: 7, policy: fullPolicy() });
        await expect(service.captureText(req(), projectId, selection(6, 'установка'))).rejects.toThrowError(
            'Текстовая база изменилась после выбора',
        );
    });
});
