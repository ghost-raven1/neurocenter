import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import bffApi from '../src/core/api/bff';

vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(async () => ({data: {}}))}}));

describe('Каталог для выбора зависимостей', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    it('Загружает следующую страницу без потери номера и размера', async () => {
        await bffApi.listAiPlugins({page:3,pageSize:100});
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/ai-plugins',{params:{page:3,size:100}});
    });
    it('Не меняет запросы старых клиентов первой страницы', async () => {
        await bffApi.listAiPlugins();
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/ai-plugins',{params:{size:100}});
    });
    it('Получает пакет выбранной версии по canonical ID', async () => {
        await bffApi.getAiPluginPackage('ai-plug-search',2);
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/ai-plugins/ai-plug-search/package',{params:{version:2}});
    });
});
