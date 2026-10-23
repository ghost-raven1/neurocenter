import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {SafeMarkdown} from '../src/features/Discussions/SafeMarkdown';

const render = (content: string): string => renderToStaticMarkup(createElement(SafeMarkdown, { body: content }));
const lspArticle = new URL('../../services/catalog-service/content/help/opencode-lsp.md', import.meta.url);

describe('Инструкции OpenCode в Markdown-помощи', () => {
    it('Статья установки ведёт к точной команде площадки и не содержит шаблонных команд',()=>{
        const content=readFileSync(new URL('../../services/catalog-service/content/help/opencode-install.md',import.meta.url),'utf8');
        expect(content).toContain('](/start?step=0)');expect(content).toContain('](/help/opencode-lsp)');expect(content).toContain('bash install_opencode.sh --binary');expect(content).not.toContain('__INSTALL_');
    });
    it('Рисует Markdown-таблицу с заголовками, ячейками и форматированием', () => {
        const html = render('| Команда | Назначение |\n| --- | --- |\n| `rag search` | **Поиск** по коду |');
        expect(html).toContain('<table>');
        expect(html).toContain('<thead>');
        expect(html).toContain('<th>Команда</th>');
        expect(html).toContain('<td><code>rag search</code></td>');
        expect(html).toContain('<td><strong>Поиск</strong> по коду</td>');
        expect(html).not.toContain('| --- |');
    });

    it.each(['OPENCODE-RAG.md', 'OPENCODE-SNIP.md'])(
        'Таблицы настоящего документа %s отображаются как таблицы', document => {
            const content = readFileSync(new URL(`../src/modules/Start/docs/${document}`, import.meta.url), 'utf8');
            expect(render(content)).toContain('<table>');
        },
    );
    it('Статья LSP из Помощи сохраняет диагностическую таблицу',()=>{expect(render(readFileSync(lspArticle,'utf8'))).toContain('<table>');});

    it('Примеры LSP разбираются как JSON и используют совместимые формы false/объект', () => {
        const content = readFileSync(lspArticle, 'utf8');
        const examples = [...content.matchAll(/```json\s*\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]) as Record<string, unknown>);
        expect(examples.length).toBeGreaterThanOrEqual(3);
        expect(examples.some(example => example.lsp === false)).toBe(true);
        expect(examples.some(example => typeof example.lsp === 'object' && example.lsp !== null && Object.keys(example.lsp).length === 0)).toBe(true);
        for (const { lsp } of examples) {
            if (lsp === false) continue;
            expect(lsp).toBeTypeOf('object');
            expect(lsp).not.toBeNull();
            expect(Array.isArray(lsp)).toBe(false);
            for (const entry of Object.values(lsp as Record<string, Record<string, unknown>>)) {
                if (entry.disabled === true) continue;
                expect(Array.isArray(entry.command)).toBe(true);
                expect((entry.command as unknown[]).length).toBeGreaterThan(0);
                expect((entry.command as unknown[]).every(value => typeof value === 'string' && value.length > 0)).toBe(true);
                if (entry.extensions !== undefined) {
                    expect(Array.isArray(entry.extensions)).toBe(true);
                    expect((entry.extensions as unknown[]).every(value => typeof value === 'string' && value.startsWith('.'))).toBe(true);
                }
            }
        }
    });

    it('Не исполняет HTML, не загружает внешние изображения и блокирует опасную ссылку', () => {
        const html = render('<script>alert("xss")</script>\n\n<img src="https://example.test/pixel" onerror="alert(1)">\n\n![Схема](https://example.test/image.png)\n\n[Опасная ссылка](javascript:alert%281%29)');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('onerror');
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('https://example.test/image.png');
        expect(html).toContain('Изображение: Схема');
    });

    it('Открывает обычные и GFM-ссылки безопасно в отдельной вкладке', () => {
        const html = render('[Документация](https://example.test/docs)\n\nhttps://example.test/help');
        expect(html).toContain('href="https://example.test/docs" target="_blank" rel="noopener noreferrer"');
        expect(html).toContain('href="https://example.test/help" target="_blank" rel="noopener noreferrer"');
    });
});
