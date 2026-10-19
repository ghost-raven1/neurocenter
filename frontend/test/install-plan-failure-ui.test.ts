import { Children, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallPlanFailureModal } from '../src/modules/Store/installPlans/InstallPlanFailureModal';
import type { IInstallPlanFailure } from '../src/modules/Store/installPlans/installPlanFailure';

const ui = vi.hoisted(() => ({ actions: new Map<string, { onClick: () => void; disabled?: boolean }>() }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    return { Space: content, Typography: { Paragraph: content, Text: content }, Descriptions: Object.assign(content, { Item: content }),
        Alert: ({ message, description }: { message: ReactNode; description?: ReactNode }) => createElement('section', null, message, description),
        Modal: ({ open, children, footer }: { open: boolean; children?: ReactNode; footer?: ReactNode }) => open ? createElement('div', null, children, footer) : null,
        Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => {
            ui.actions.set(Children.toArray(children).join(''), { onClick, disabled }); return createElement('button', { disabled }, children);
        },
    };
});
const root = { id: 'root', kind: 'plugin' as const, name: 'Помощник', version: 3 };
const dependency = { id: 'dep', kind: 'mcp' as const, name: '<MCP поиска>', version: 1 };
const failure: IInstallPlanFailure = {
    app: { ...root, description: '', tags: [], origin: 'catalog' },
    issue: { package: dependency, root, path: [root, dependency], dependency: true,
        reason: 'Повреждена схема подключения.', message: 'Не удалось подготовить установку' },
};
const actions = () => ({ onCancel: vi.fn(), onRetry: vi.fn(), onOpenPackage: vi.fn(), onPackage: vi.fn() });

beforeEach(() => { ui.actions.clear(); });
describe('Восстановление после отказа подготовки комплекта', () => {
    it('Показывает точную версию, причину и путь, экранируя имя инструмента', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanFailureModal, { failure, ...actions() }));
        expect(html).toContain('Помощник'); expect(html).toContain('&lt;MCP поиска&gt;');
        expect(html).toContain('версия 3'); expect(html).toContain('версия 1');
        expect(html).toContain('Повреждена схема подключения.'); expect(html).toContain('Путь зависимости');
        expect(html).toContain('заново закрепить его точную версию');
        expect(html).toContain('создаёт отдельно опубликованный инструмент');
    });
    it('Передаёт только явные действия пользователя и не запускает установку при открытии', () => {
        const callbacks = actions();
        renderToStaticMarkup(createElement(InstallPlanFailureModal, { failure, ...callbacks }));
        for (const callback of Object.values(callbacks)) { expect(callback).not.toHaveBeenCalled(); }
        ui.actions.get('Проверить версию 3')!.onClick(); expect(callbacks.onRetry).toHaveBeenCalledOnce();
        ui.actions.get('Открыть карточку')!.onClick(); expect(callbacks.onOpenPackage).toHaveBeenCalledOnce();
        ui.actions.get('Упаковать инструмент')!.onClick(); expect(callbacks.onPackage).toHaveBeenCalledOnce();
        ui.actions.get('Закрыть')!.onClick(); expect(callbacks.onCancel).toHaveBeenCalledOnce();
    });
    it('Объясняет обращение к администратору, когда упаковка недоступна', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanFailureModal, { failure, onCancel: vi.fn(), onRetry: vi.fn() }));
        expect(html).toContain('Передайте администратору название, версию и причину отказа');
        expect(ui.actions.has('Упаковать инструмент')).toBe(false);
        expect(ui.actions.has('Открыть карточку')).toBe(false);
    });
    it('Для отказа корня не показывает вымышленную зависимость', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanFailureModal, { failure: { ...failure,
            issue: { ...failure.issue, package: root, path: [root], dependency: false } }, ...actions() }));
        expect(html).not.toContain('Путь зависимости'); expect(html).toContain('Недоступен комплект инструмента');
    });
    it('Не рендерит закрытый отказ и блокирует навигацию во время проверки', () => {
        expect(renderToStaticMarkup(createElement(InstallPlanFailureModal, { failure: null, ...actions() }))).toBe('');
        renderToStaticMarkup(createElement(InstallPlanFailureModal, { failure, busy: true, ...actions() }));
        expect(ui.actions.get('Упаковать инструмент')!.disabled).toBe(true);
        expect(ui.actions.get('Открыть карточку')!.disabled).toBe(true);
    });
});
