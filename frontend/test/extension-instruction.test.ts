import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ExtensionInstruction from '../src/modules/Start/ExtensionInstruction';

const render = (content: string): string => renderToStaticMarkup(createElement(ExtensionInstruction, { content }));

describe('Предпросмотр инструкции расширения', () => {
    it('Рисует Markdown-таблицу с заголовками, ячейками и форматированием', () => {
        const html = render('| Команда | Назначение |\n| --- | --- |\n| `rag search` | **Поиск** по коду |');
        expect(html).toContain('<table>');
        expect(html).toContain('<thead>');
        expect(html).toContain('<th>Команда</th>');
        expect(html).toContain('<td><code>rag search</code></td>');
        expect(html).toContain('<td><strong>Поиск</strong> по коду</td>');
        expect(html).not.toContain('| --- |');
    });

    it.each(['OPENCODE-RAG.md', 'OPENCODE-LSP.md', 'OPENCODE-SNIP.md'])(
        'Таблицы настоящего документа %s отображаются как таблицы', document => {
            const content = readFileSync(new URL(`../src/modules/Start/docs/${document}`, import.meta.url), 'utf8');
            expect(render(content)).toContain('<table>');
        },
    );

    it('Не исполняет HTML, не загружает внешние изображения и блокирует опасную ссылку', () => {
        const html = render('<script>alert("xss")</script>\n\n<img src="https://example.test/pixel" onerror="alert(1)">\n\n![Схема](https://example.test/image.png)\n\n[Опасная ссылка](javascript:alert%281%29)');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('onerror');
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('https://example.test/image.png');
        expect(html).toContain('<span>Схема</span>');
    });

    it('Открывает обычные и GFM-ссылки безопасно в отдельной вкладке', () => {
        const html = render('[Документация](https://example.test/docs)\n\nhttps://example.test/help');
        expect(html).toContain('href="https://example.test/docs" target="_blank" rel="noopener noreferrer"');
        expect(html).toContain('href="https://example.test/help" target="_blank" rel="noopener noreferrer"');
    });
});
