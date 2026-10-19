import { describe, expect, it } from 'vitest';
import { storeProjectQuery, storeQueryUrl, storeSearchQuery } from '../src/modules/Store/storeQuery';

const url = (value: string): URL => new URL(value, 'http://localhost');

describe('Поисковые ссылки каталога', () => {
    it('Читает проект из каждой записи истории, включая ID, имя и снятие выбора', () => {
        expect(storeProjectQuery('?p=prj-first&q=test')).toBe('prj-first');
        expect(storeProjectQuery(storeQueryUrl('', { project: 'Другой проект' }).split('?')[1])).toBe('Другой проект');
        expect(storeProjectQuery('?q=test')).toBeNull();
        expect(storeProjectQuery('?p=')).toBeNull();
        expect(storeProjectQuery('?p=несуществующий')).toBe('несуществующий');
    });
    it('Открывает инструмент по q и читает новое значение при следующем переходе', () => {
        expect(storeSearchQuery('?q=OpenCodeRAG')).toBe('OpenCodeRAG');
        expect(storeSearchQuery('?p=example&q=opencode-snip')).toBe('opencode-snip');
        expect(storeSearchQuery('?p=example')).toBe('');
    });

    it('Смена проекта сохраняет поисковый запрос, другие параметры и якорь', () => {
        const next = url(storeQueryUrl('?q=OpenCodeRAG&mode=compact&p=old', { project: 'новый проект' }, '#tools'));
        expect(next.pathname).toBe('/store');
        expect(next.searchParams.get('q')).toBe('OpenCodeRAG');
        expect(next.searchParams.get('p')).toBe('новый проект');
        expect(next.searchParams.get('mode')).toBe('compact');
        expect(next.hash).toBe('#tools');
    });

    it('Выбор проекта после редактирования поиска сохраняет текущий текст вместо старого q', () => {
        const next = url(storeQueryUrl('?q=OpenCodeRAG', { project: 'example', query: 'opencode-snip' }));
        expect(next.searchParams.get('q')).toBe('opencode-snip');
        expect(next.searchParams.get('p')).toBe('example');
    });

    it('Снятие проекта сохраняет фильтр; сброс поиска сохраняет выбранный проект', () => {
        expect(url(storeQueryUrl('?q=OpenCodeRAG&p=example', { project: null })).searchParams.get('q')).toBe('OpenCodeRAG');
        const next = url(storeQueryUrl('?q=OpenCodeRAG&p=example', { query: '' }));
        expect(next.searchParams.has('q')).toBe(false);
        expect(next.searchParams.get('p')).toBe('example');
        expect(storeQueryUrl('?q=OpenCodeRAG', { query: '' })).toBe('/store');
    });

    it('Название с символами запроса не создаёт скрытый параметр и не дублирует q', () => {
        const next = url(storeQueryUrl('?q=old&q=older', { query: 'контекст + путь? & p=чужой' }));
        expect(next.searchParams.getAll('q')).toEqual(['контекст + путь? & p=чужой']);
        expect(next.searchParams.has('p')).toBe(false);
        expect(storeSearchQuery(next.search)).toBe('контекст + путь? & p=чужой');
    });
});
