import { describe, expect, it } from 'vitest';
import { catalogSection, catalogSectionUrl } from '../src/modules/Store/catalogSection';
import { filterCatalogModels, modelHostingBusy, requireModelCatalog } from '../src/features/ModelCatalog/modelCatalogState';
import { ollamaModelPattern } from '../src/features/ModelCatalog/ModelEditModal';
import type { ICatalogModel, IModelHosting } from '../src/features/ModelCatalog/types';

const model = (id: string, overrides: Partial<ICatalogModel> = {}): ICatalogModel => ({
    id, name: 'Поиск', description: 'База знаний', capability: 'embedding', runtime: 'ollama', model: 'qwen3-embedding:4b',
    manifestSha256: null, dimension: 2560, source: 'custom', revision: 1, createdAt: '2026-10-19', updatedAt: '2026-10-19', ...overrides,
});

describe('Вкладки каталога моделей', () => {
    it('Прямая ссылка открывает модели и не принимает неизвестную вкладку', () => {
        expect(catalogSection('?tab=models&p=project')).toBe('models');
        expect(catalogSection('?tab=unknown')).toBe('tools');
        expect(catalogSection('?tab=store&catalogTab=models', true)).toBe('models');
    });
    it('Вложенные модели сохраняют вкладку проекта, поиск и якорь', () => {
        const next = new URL(catalogSectionUrl('/projects/prj-a', '?tab=store&q=RAG', 'models', true, '#catalog'), 'http://localhost');
        expect(next.pathname).toBe('/projects/prj-a');
        expect(next.searchParams.get('tab')).toBe('store');
        expect(next.searchParams.get('catalogTab')).toBe('models');
        expect(next.searchParams.get('q')).toBe('RAG');
        expect(next.hash).toBe('#catalog');
        expect(catalogSectionUrl('/projects/prj-a', next.search, 'tools', true)).toBe('/projects/prj-a?tab=store&q=RAG');
    });
    it('Смена общей вкладки сохраняет выбранный проект', () => {
        expect(catalogSectionUrl('/store', '?p=example&q=RAG', 'models')).toBe('/store?p=example&q=RAG&tab=models');
        expect(catalogSectionUrl('/store', '?tab=models&p=example', 'tools')).toBe('/store?p=example');
    });
});

describe('Отбор и проверка каталога моделей', () => {
    const catalog = { items: [model('one'), model('two', { capability: 'vision', name: 'Картинки', model: 'qwen3-vl:2b-instruct' })], assignedModelIds: ['two'] };
    it('Назначение определяется точным ID, а поиск учитывает назначение и идентификатор', () => {
        expect(filterCatalogModels(catalog, '', true).map(value => value.id)).toEqual(['two']);
        expect(filterCatalogModels(catalog, '  ИЗОБРАЖЕНИЯ ', false).map(value => value.id)).toEqual(['two']);
        expect(filterCatalogModels(catalog, 'embedding:4b', false).map(value => value.id)).toEqual(['one']);
        expect(filterCatalogModels(catalog, 'embedding:4b', true)).toEqual([]);
    });
    it('Неполный или повторяющийся ответ отклоняется вместо сброса назначений', () => {
        expect(requireModelCatalog(catalog)).toBe(catalog);
        expect(() => requireModelCatalog({ ...catalog, assignedModelIds: undefined! })).toThrow('неполный');
        expect(() => requireModelCatalog({ ...catalog, items: [model('one'), model('one')] })).toThrow('неполный');
        expect(() => requireModelCatalog({ ...catalog, items: [model('one', { capability: 'unknown' as 'chat' })] })).toThrow('неполный');
    });
    it.each(['qwen3:4b', 'author/model:q4_K_M', 'qwen3-vl:2b-instruct'])('Принимает явный тег реестра %s', value => {
        expect(ollamaModelPattern.test(value)).toBe(true);
    });
    it.each(['qwen3', 'https://host/model:tag', 'host:1234/model:tag', '../model:tag', 'model:tag --flag'])('Отклоняет адрес или неявную версию %s', value => {
        expect(ollamaModelPattern.test(value)).toBe(false);
    });
    it('Не завершает ожидание, пока операция выполняется, даже если модель ещё готова', () => {
        expect(modelHostingBusy(null)).toBe(false);
        expect(modelHostingBusy({ state: 'busy' } as IModelHosting)).toBe(true);
        expect(modelHostingBusy({ state: 'ready', operation: { state: 'running' } } as IModelHosting)).toBe(true);
        expect(modelHostingBusy({ state: 'ready', operation: { state: 'completed' } } as IModelHosting)).toBe(false);
    });
});
