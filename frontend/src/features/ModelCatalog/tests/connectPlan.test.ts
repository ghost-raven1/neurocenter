import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProjectReindexPlan } from '../../ProjectEmbedding/reindex';
import type { ICatalogModel } from '../interfaces';
import { observeConnectRun, planConnectStep } from '../hooks/connectPlan';

vi.mock('../api', () => ({
    modelCatalogApi: {
        connection: vi.fn(),
    },
}));
vi.mock('../../RemoteProviderAccess/api', () => ({
    personalProviderApi: {
        read: vi.fn(),
    },
}));
import { modelCatalogApi } from '../api';
import { personalProviderApi } from '../../RemoteProviderAccess/api';

const sha = 'a'.repeat(64);
const model: ICatalogModel = {
    id: 'm1',
    name: 'Model',
    description: '',
    capability: 'embedding',
    runtime: 'remote-openai',
    model: 'model',
    manifestSha256: null,
    modelVersion: 'v1',
    dimension: 1536,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
    modelPin: sha,
};
const plan = (overrides: Partial<IProjectReindexPlan> = {}): IProjectReindexPlan => ({
    id: '11111111-1111-4111-8111-111111111111',
    projectId: 'p1',
    state: 'applied',
    digest: sha,
    approved: true,
    data: {
        context: { revision: 1, generation: '11111111-1111-4111-8111-111111111111', dataRevision: 1 },
        modelId: model.id,
        modelPin: sha,
        profile: { provider: 'openai', model: `neurocenter/${model.id}/sha256/${sha}`, dimension: 1536 },
        sourceSnapshot: null,
        rowCount: 10,
        requiredBytes: 1024,
    },
    progress: 100,
    message: 'Готово',
    createdAt: new Date().toISOString(),
    ...overrides,
});

beforeEach(() => {
    vi.mocked(modelCatalogApi.connection).mockReset();
    vi.mocked(personalProviderApi.read).mockReset();
});

describe('planConnectStep', () => {
    it('модель без серверного подключения идёт сразу в шаг «Готовность»', async () => {
        const local = { ...model, runtime: 'ollama' as const };
        await expect(planConnectStep(local, true)).resolves.toBe('run');
        expect(modelCatalogApi.connection).not.toHaveBeenCalled();
        expect(personalProviderApi.read).not.toHaveBeenCalled();
    });
    it('главный администратор без общего адреса идёт в шаг «Подключение»', async () => {
        vi.mocked(modelCatalogApi.connection).mockResolvedValue({
            modelId: model.id,
            modelRevision: 1,
            revision: 0,
            baseUrl: '',
            requestDimensions: false,
            credential: 'none',
            credentialEnv: null,
            hasKey: false,
            checkedAt: null,
            verified: false,
            canStoreKey: false,
            options: {},
            timeoutMs: 90000,
            authMode: 'required',
        });
        await expect(planConnectStep(model, true)).resolves.toBe('connection');
    });
    it('главный администратор с общим адресом и личным ключом идёт в шаг «Ключ»', async () => {
        vi.mocked(modelCatalogApi.connection).mockResolvedValue({
            modelId: model.id,
            modelRevision: 1,
            revision: 2,
            baseUrl: 'https://provider.example/v1',
            requestDimensions: false,
            credential: 'none',
            credentialEnv: null,
            hasKey: false,
            checkedAt: null,
            verified: false,
            canStoreKey: true,
            options: {},
            timeoutMs: 90000,
            authMode: 'required',
        });
        await expect(planConnectStep(model, true)).resolves.toBe('access');
    });
    it('главный администратор без авторизации идёт сразу в шаг «Готовность»', async () => {
        vi.mocked(modelCatalogApi.connection).mockResolvedValue({
            modelId: model.id,
            modelRevision: 1,
            revision: 2,
            baseUrl: 'https://provider.example/v1',
            requestDimensions: false,
            credential: 'none',
            credentialEnv: null,
            hasKey: false,
            checkedAt: null,
            verified: false,
            canStoreKey: false,
            options: {},
            timeoutMs: 90000,
            authMode: 'none',
        });
        await expect(planConnectStep(model, true)).resolves.toBe('run');
    });
    it('разработчик с личным ключом провайдера идёт в шаг «Ключ»', async () => {
        vi.mocked(personalProviderApi.read).mockResolvedValue({
            modelId: model.id,
            providerId: sha,
            providerUrl: 'https://provider.example/v1',
            connectionRevision: 2,
            authMode: 'required',
            credentialRevision: 0,
            hasKey: false,
            updatedAt: null,
            canStoreKey: true,
            legacySharedKeyRetained: false,
        });
        await expect(planConnectStep(model, false)).resolves.toBe('access');
        expect(modelCatalogApi.connection).not.toHaveBeenCalled();
    });
    it('без доступного взгляда на доступ операция выполняется напрямую', async () => {
        vi.mocked(personalProviderApi.read).mockRejectedValue(new Error('404'));
        await expect(planConnectStep(model, false)).resolves.toBe('run');
    });
});

describe('observeConnectRun', () => {
    it('подтверждённый выбор означает готовность', () => {
        expect(observeConnectRun(model, { connected: true, pending: false }).state).toBe('ready');
    });
    it('сбой плана этой модели завершает шаг «Готовность» с сообщением плана', () => {
        const outcome = observeConnectRun(model, {
            connected: false,
            plan: plan({ state: 'failed', message: 'Сервер отклонил смену модели' }),
            pending: false,
        });
        expect(outcome.state).toBe('failed');
        expect(outcome.message).toBe('Сервер отклонил смену модели');
    });
    it('сбой плана другой модели не влияет на текущий шаг', () => {
        const outcome = observeConnectRun(model, {
            connected: false,
            plan: plan({ data: { ...plan().data, modelId: 'other' }, state: 'failed' }),
            pending: false,
        });
        expect(outcome.state).toBe('running');
    });
    it('сбой локального задания этой модели завершает шаг «Готовность»', () => {
        const outcome = observeConnectRun(model, {
            connected: false,
            plan: plan({ local: { jobId: null, state: 'failed', message: 'Компьютер недоступен', percent: null } }),
            pending: false,
        });
        expect(outcome.state).toBe('failed');
        expect(outcome.message).toBe('Компьютер недоступен');
    });
    it('преходящая ошибка чтения не ломает запущенную операцию', () => {
        const outcome = observeConnectRun(model, {
            connected: false,
            plan: plan({ state: 'building' }),
            reindexError: 'Не удалось проверить ход переиндексации.',
            pending: true,
        });
        expect(outcome.state).toBe('running');
    });
    it('ошибка без запущенной операции завершает шаг «Готовность»', () => {
        const outcome = observeConnectRun(model, {
            connected: false,
            reindexError: 'Не удалось подготовить подключение модели.',
            pending: false,
        });
        expect(outcome.state).toBe('failed');
        expect(outcome.message).toBe('Не удалось подготовить подключение модели.');
    });
});
