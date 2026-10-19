import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OpenCodeExtensions from '../src/modules/Start/OpenCodeExtensions';

const navigation = vi.hoisted(() => ({
    location: { pathname: '/start', search: '', hash: '' },
    replace: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
    useHistory: () => ({ replace: navigation.replace }),
    useLocation: () => navigation.location,
}));
vi.mock('antd', async importOriginal => ({
    ...await importOriginal<typeof import('antd')>(),
    Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open
        ? createElement('section', { 'aria-label': 'Подключение расширения' }, children, footer) : null,
}));

const render = (project?: string): string => renderToStaticMarkup(createElement(OpenCodeExtensions, { project }));

describe('Расширения OpenCode переходят в каталог', () => {
    beforeEach(() => { navigation.location.search = ''; vi.clearAllMocks(); });

    it('Основные действия RAG и snip открывают точные поисковые ссылки', () => {
        const html = render();
        expect(html).toContain('href="/store?q=OpenCodeRAG"');
        expect(html).toContain('href="/store?q=opencode-snip"');
        expect(html.match(/Открыть в каталоге/g)).toHaveLength(2);
        expect(html).toContain('Встроено в OpenCode');
        expect(html).toContain('Как пользоваться');
        expect(html).not.toContain('Копировать для агента');
    });

    it.each([
        ['rag', 'OpenCodeRAG'],
        ['snip', 'opencode-snip'],
    ])('Старая ссылка extension=%s объясняет установку через каталог без ручной инструкции', (id, name) => {
        navigation.location.search = `?step=2&extension=${id}`;
        const html = render();
        expect(html.match(new RegExp(`href="/store\\?q=${name}"`, 'g'))).toHaveLength(2);
        expect(html).toContain(`установите ${name} через мост`);
        expect(html).toContain('После установки запуск проверяется отдельно');
        expect(html).not.toContain('Копировать для агента');
        expect(html).not.toContain('npm install');
    });

    it('Встроенный LSP сохраняет справку для агента', () => {
        navigation.location.search = '?extension=lsp';
        const html = render();
        expect(html).toContain('LSP встроен в OpenCode');
        expect(html).toContain('Копировать для агента');
    });
    it('Подготовка индекса объясняет явный запуск и сохраняет проект в каталоге и возврате', () => {
        navigation.location.search = '?extension=rag&p=prj-knowledge';
        const html = render('prj-knowledge');
        expect(html.match(/href="\/store\?q=OpenCodeRAG&amp;p=prj-knowledge"/g)).toHaveLength(2);
        expect(html).toContain('href="/projects/prj-knowledge?tab=rag"');
        expect(html).toContain('index_project');
        expect(html).toContain('сервиса эмбеддингов и модель');
        expect(html).toContain('Синхронизировать с сервером');
        expect(html).toContain('Вернуться к знаниям');
        expect(html).not.toContain('Копировать для агента');
    });

    it('Не предлагает проект из адреса, когда список текущего владельца его не подтвердил', () => {
        navigation.location.search = '?extension=rag&p=prj-previous-owner';
        const html = render();
        expect(html).not.toContain('prj-previous-owner');
        expect(html).not.toContain('Вернуться к знаниям');
        expect(html).toContain('href="/store?q=OpenCodeRAG"');
    });
});
