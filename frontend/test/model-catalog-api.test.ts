import { beforeEach, describe, expect, it, vi } from 'vitest';
import base from '../src/core/api/base';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';
import type { ICatalogModel } from '../src/features/ModelCatalog/types';

vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
const model = { id: 'model/one', revision: 7 } as ICatalogModel;
beforeEach(() => {
    vi.clearAllMocks();
    for (const method of [base.get, base.post, base.patch, base.delete]) vi.mocked(method).mockResolvedValue({ data: { ok: true } });
});

describe('Контракт моделей и хостинга', () => {
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
