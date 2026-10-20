import { beforeEach, describe, expect, it, vi } from 'vitest';
import base from '../src/core/api/base';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';
import type { ICatalogModel } from '../src/features/ModelCatalog/types';

vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
const model = { id: 'model/one', revision: 7 } as ICatalogModel;
beforeEach(() => {
    vi.clearAllMocks();
    for (const method of [base.get, base.post, base.put, base.patch, base.delete]) vi.mocked(method).mockResolvedValue({ data: { ok: true } });
});

describe('Контракт моделей и хостинга', () => {
    it('Приватное подключение использует отдельный endpoint и CAS карточки и конфигурации', async () => {
        const input = { expectedRevision: 2, expectedModelRevision: 7, baseUrl: 'https://fixture.test/v1', requestDimensions: true, credential: 'stored' as const, apiKey: 'fixture-key' };
        await modelCatalogApi.configure(model.id, input); await modelCatalogApi.connection(model.id); await modelCatalogApi.revoke(model, 2);
        expect(base.put).toHaveBeenCalledWith('/api/models/model%2Fone/connection', input);
        expect(base.get).toHaveBeenCalledWith('/api/models/model%2Fone/connection');
        expect(base.delete).toHaveBeenCalledWith('/api/models/model%2Fone/connection', { data: { expectedRevision: 2, expectedModelRevision: 7 } });
        expect(base.post).not.toHaveBeenCalled();
    });
    it('Создание передаёт стабильный request key для повтора потерянного ответа', async () => {
        const input={name:'API',runtime:'remote-openai' as const,capability:'embedding' as const,model:'fixture-v1',modelVersion:'v1'};
        await modelCatalogApi.create(input,'11111111-1111-4111-8111-111111111111');
        expect(base.post).toHaveBeenCalledWith('/api/models',{...input,requestKey:'11111111-1111-4111-8111-111111111111'});
    });
    it('Общий и проектный каталог используют отдельные назначения моделей', async () => {
        await modelCatalogApi.list('prj-a');
        await modelCatalogApi.assign('prj/a', 'model-one');
        await modelCatalogApi.unassign('prj/a', 'model/one');
        expect(base.get).toHaveBeenCalledWith('/api/models', { params: { projectId: 'prj-a' } });
        expect(base.post).toHaveBeenCalledWith('/api/projects/prj%2Fa/models', { modelId: 'model-one' });
        expect(base.delete).toHaveBeenCalledWith('/api/projects/prj%2Fa/models/model%2Fone');
        expect(JSON.stringify(vi.mocked(base.post).mock.calls)).not.toContain('/assets');
    });
    it('Изменение и удаление отправляют исходную ревизию', async () => {
        await modelCatalogApi.update(model, { name: 'Новое', description: 'Описание' });
        await modelCatalogApi.remove(model);
        expect(base.patch).toHaveBeenCalledWith('/api/models/model%2Fone', { name: 'Новое', description: 'Описание', expectedRevision: 7 });
        expect(base.delete).toHaveBeenCalledWith('/api/models/model%2Fone', { data: { expectedRevision: 7 } });
    });
    it.each(['start', 'stop', 'check'] as const)('Хостинг %s привязан к точной карточке и ревизии', async action => {
        await modelCatalogApi.operate(model, action);
        expect(base.post).toHaveBeenCalledWith('/api/models/model%2Fone/hosting', { action, expectedRevision: 7 });
        expect(modelCatalogApi.endpoint(model.id)).toBe('/api/models/model%2Fone/ollama/api');
    });
});
