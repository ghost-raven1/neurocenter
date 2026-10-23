import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {SafeMarkdown, safeMarkdownUrl} from '../src/features/Discussions/SafeMarkdown';
import {attachmentUrl, mergeComments} from '../src/features/Discussions/model';
import {filterArticles, validHelpSlug} from '../src/modules/Help/model';
import type {DiscussionComment} from '../src/features/Discussions/types';
describe('Help and comment Markdown', () => {
    it('Renders Markdown lists/tables without HTML, executable links or remote image requests', () => {
        const html = renderToStaticMarkup(createElement(SafeMarkdown, {body: '# Ответ\n\n- Пункт\n\n|A|B|\n|-|-|\n|1|2|\n\n<script>alert(1)</script>\n\n[опасно](javascript:alert(1))\n\n![remote](https://external.test/tracker.png)'}));
        expect(html).toContain('<h1'); expect(html).toContain('<li>Пункт</li>'); expect(html).toContain('<table>'); expect(html).not.toContain('<script'); expect(html).not.toContain('javascript:'); expect(html).not.toContain('<img'); expect(html).not.toContain('tracker.png');
    });
    it('Maps a relative .md article to Help while denying arbitrary relative/admin links', () => {
        expect(safeMarkdownUrl('./getting-started.md#установка')).toBe('/help/getting-started#установка');
        expect(safeMarkdownUrl('/help/troubleshooting')).toBe('/help/troubleshooting'); expect(safeMarkdownUrl('#установка')).toBe('#установка');
        for (const value of ['//external.test/a', 'data:text/html,a', '/api/admin/delete', '../secret.md', '/help/../api/admin', '/help/%2e%2e/admin', '/help/%2fadmin', '/help\\evil', 'https://user:pass@example.test/']) expect(safeMarkdownUrl(value)).toBe('');
        for (const value of ['/start', '/store?tab=models', '/settings#sources', '/projects/prj-example?tab=rag']) expect(safeMarkdownUrl(value)).toBe(value);
        expect(safeMarkdownUrl('https://docs.example.test/a')).toBe('https://docs.example.test/a');
        const html = renderToStaticMarkup(createElement(SafeMarkdown, {body: '## Установка\n\n[Здесь](#установка) · [В статье](./getting-started.md#установка)'}));
        expect(html).toContain('href="#%D1%83'); expect(html).toContain('href="/help/getting-started#%D1%83');
    });
    it('Allows only authenticated discussion download paths', () => {
        expect(attachmentUrl('/api/discussions/attachments/a-b-123/content')).toBe('/api/discussions/attachments/a-b-123/content');
        expect(attachmentUrl('https://external.test/file')).toBeUndefined(); expect(attachmentUrl('/api/discussions/attachments/../secret/content')).toBeUndefined();
    });
    it('Searches all terms across a real title, summary and slug', () => {
        const items = [{slug: 'bridge', title: 'Установка моста', summary: 'Локальный архив и подключение', revision: 'sha', updatedAt: ''}, {slug: 'models', title: 'Модели', summary: 'API', revision: 'sha', updatedAt: ''}];
        expect(filterArticles(items, '  МОСТА архив ')).toEqual([items[0]]); expect(filterArticles(items, 'неизвестно')).toEqual([]); expect(filterArticles(items, '')).toEqual(items);
        expect(validHelpSlug('getting-started')).toBe(true); for (const value of ['../secret', 'a/b', 'A', 'a-', '']) expect(validHelpSlug(value)).toBe(false);
    });
    it('A slower list cannot roll a comment receipt back to its old version', () => {
        const current = {id: 'a', version: 3, body: 'Три', createdAt: '2026-10-23'} as DiscussionComment;
        expect(mergeComments([current], [{...current, version: 2, body: 'Два'}])).toEqual([current]);
        expect(mergeComments([current], [{...current, version: 4, deleted: true, body: ''}])[0].deleted).toBe(true);
    });
});
