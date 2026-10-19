import {describe, expect, it} from 'vitest';
import {projectRagCatalogUrl,projectRagSetupUrl, projectTabSearch} from '../src/modules/Projects/projectNavigation';

describe('Навигация вкладок проекта', () => {
    it('Сохраняет другие параметры при смене вкладки', () => {
        const params = new URLSearchParams(projectTabSearch('?filter=active&tab=overview&source=knowledge', 'rag'));
        expect([...params]).toEqual([['filter', 'active'], ['tab', 'rag'], ['source', 'knowledge']]);
    });
    it('Заменяет повторный параметр вкладки одним значением', () => {
        const params = new URLSearchParams(projectTabSearch('?tab=overview&tab=audit&filter=a&filter=b', 'members'));
        expect(params.getAll('tab')).toEqual(['members']);
        expect(params.getAll('filter')).toEqual(['a', 'b']);
    });
    it('Сохраняет текст и специальные символы в параметрах', () => {
        const params = new URLSearchParams(projectTabSearch('?search=%D0%BC%D0%BE%D0%B9+%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%26%D1%82%D0%B5%D1%81%D1%82', 'overview'));
        expect(params.get('search')).toBe('мой проект&тест');
        expect(params.get('tab')).toBe('overview');
    });
    it('Справка по RAG передаёт выбранный проект без подмены параметров URL', () => {
        const url = new URL(projectRagSetupUrl('мой проект&other=wrong'), 'http://localhost');
        expect(url.pathname).toBe('/start');
        expect(url.searchParams.get('extension')).toBe('rag');
        expect(url.searchParams.get('p')).toBe('мой проект&other=wrong');
        expect(url.searchParams.has('other')).toBe(false);
    });
    it('Установка знаний выбирает нативный плагин и сохраняет точный проект',()=>{
        const url=new URL(projectRagCatalogUrl('мой проект&other=wrong'),'http://localhost');
        expect(url.pathname).toBe('/store');expect(url.searchParams.get('q')).toBe('OpenCodeRAG (плагин)');
        expect(url.searchParams.get('p')).toBe('мой проект&other=wrong');expect(url.searchParams.has('other')).toBe(false);
    });
});
