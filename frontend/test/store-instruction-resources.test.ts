import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISkillResource } from '../src/core/api/interfaces';
import StoreInstruction from '../src/modules/Store/StoreInstruction';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: { value: unknown }[] = [];
    return {
        begin: () => { cursor = 0; }, clear: () => { slots.length = 0; },
        useState<T>(initial: T) {
            const slot = slots[cursor++] ??= { value: initial };
            return [slot.value, (next: T | ((old: T) => T)) => { slot.value = typeof next === 'function' ? (next as (old: T) => T)(slot.value as T) : next; }];
        },
    };
});
const ui = vi.hoisted(() => ({ actions: new Map<string, () => void>() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: hooks.useState }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    return {
        Button: ({ children, onClick, 'aria-label': label }: { children: ReactNode; onClick?: () => void; 'aria-label'?: string }) => {
            if (label && onClick) { ui.actions.set(label, onClick); }
            return createElement('button', { 'aria-label': label }, children);
        },
        Collapse: Object.assign(content, { Panel: content }), Typography: { Text: content },
    };
});

let body: string, resources: ISkillResource[], skillKey: string;
const render = (): string => {
    hooks.begin(); ui.actions.clear();
    return renderToStaticMarkup(createElement(StoreInstruction, { body, resources, skillKey }));
};
const open = (path: string): void => {
    const action = ui.actions.get(`Открыть ${path}`);
    expect(action, `Нет доступного ресурса ${path}`).toBeTypeOf('function');
    action!();
};
beforeEach(() => {
    hooks.clear(); body = '[Руководство](references/guide.md)'; skillKey = 'common/one:1';
    resources = [{ path: 'references/guide.md', content: '# Ресурс\n\nТекст руководства.\n\n[Скрипт](../scripts/example.py)' },
        { path: 'scripts/example.py', content: 'print("только просмотр")' }];
});

describe('Опубликованные ресурсы инструкции', () => {
    it('Открывает существующий ресурс и соседний файл из того же пакета, возвращается к инструкции', () => {
        expect(render()).not.toContain('Ресурс не опубликован');
        open('references/guide.md');
        expect(render()).toContain('Текст руководства.');
        open('scripts/example.py');
        expect(render()).toContain('print(&quot;только просмотр&quot;)');
        ui.actions.get('К инструкции')!();
        expect(render()).toContain('Руководство');
        expect(render()).not.toContain('Текст руководства.');
    });

    it('Показывает GFM-таблицы в основной инструкции и вложенном Markdown', () => {
        body += '\n\n| Имя | Тип |\n| --- | --- |\n| **Поле** | `строка` |';
        resources[0].content += '\n\n| Действие | Статус |\n| --- | --- |\n| Читать | Да |';
        expect(render()).toContain('<table>'); expect(render()).toContain('<td><strong>Поле</strong></td>');
        open('references/guide.md');
        expect(render()).toContain('<th>Действие</th>');
        expect(render()).toContain('<td>Да</td>');
    });

    it('Не открывает отсутствующий файл, traversal и ссылку в другой скилл', () => {
        body = '[Нет](references/missing.md) [Другой](../other/references/guide.md) [Traversal](../../common/other/references/guide.md) [Encoded](%2e%2e%2fother%2fSKILL.md)';
        const html = render();
        expect(html).not.toContain('href="../');
        expect(ui.actions.has('Открыть references/missing.md')).toBe(false);
        expect(ui.actions.has('Открыть ../other/references/guide.md')).toBe(false);
        expect(ui.actions.has('Открыть ../../common/other/references/guide.md')).toBe(false);
        expect(html).not.toContain('Ресурс не опубликован');
    });

    it('Сохраняет безопасные внешние ссылки, блокирует unsafe URL и внешние изображения', () => {
        body = '[Документы](https://example.test/docs) [JS](javascript:alert) [Data](data:text/html,test) [File](file:///etc/passwd) [Credentials](https://user:pass@example.test)\n\n![Схема](https://example.test/pixel.png)';
        const html = render();
        expect(html).toContain('href="https://example.test/docs" target="_blank" rel="noopener noreferrer"');
        expect(html).not.toMatch(/href="(?:javascript:|data:|file:|https:\/\/user:)/);
        expect(html).not.toContain('<img');
    });

    it('Не сохраняет текст предыдущего скилла при смене карточки с тем же resource path', () => {
        render(); open('references/guide.md'); expect(render()).toContain('Текст руководства.');
        skillKey = 'common/two:1'; body = '# Другая инструкция';
        resources = [{ path: 'references/guide.md', content: 'Другая версия ресурса' }];
        const html = render();
        expect(html).toContain('Другая инструкция'); expect(html).not.toContain('Текст руководства.');
        expect(html).not.toContain('Другая версия ресурса');
    });

    it('Декодирует текстовый base64 ресурс и не исполняет HTML', () => {
        resources = [{ path: 'references/guide.md', encoding: 'base64', content: Buffer.from('# Текст\n\n<script>alert(1)</script>\n\nГотово').toString('base64') }];
        render(); open('references/guide.md'); const html = render();
        expect(html).toContain('Готово'); expect(html).not.toContain('<script');
    });
});
