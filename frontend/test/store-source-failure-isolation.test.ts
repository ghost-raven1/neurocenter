import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAiPlugin, IPage, IProjectAsset, ISkillListSummary } from '../src/core/api/interfaces';
import Store from '../src/modules/Store/Store';

const h = vi.hoisted(() => {
    let cursor = 0; const slots: Array<{ value?: any; deps?: unknown[]; cleanup?: () => void }> = [], effects: Array<() => void> = [];
    const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && b.every((value, index) => Object.is(value, a[index]));
    const memo = (factory: () => unknown, deps: unknown[]) => { const index = cursor++, old = slots[index]; if (!old || !same(old.deps, deps)) slots[index] = { value: factory(), deps }; return slots[index].value; };
    return { begin: () => { cursor = 0; }, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState: (initial: any) => { const slot = slots[cursor++] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, (next: any) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }]; },
        useRef: (initial: unknown) => (slots[cursor++] ??= { value: { current: initial } }).value,
        useMemo: memo, useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
        useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const index = cursor++, old = slots[index]; if (old && same(old.deps, deps)) return; const slot = slots[index] = { deps }; effects.push(() => { old?.cleanup?.(); slot.cleanup = effect() || undefined; }); },
    };
});
const ui = vi.hoisted(() => ({ scope: 'admin', owners: new Map<string, () => () => boolean>(), plugins: vi.fn(), skills: vi.fn(),
    refresh: undefined as (() => void) | undefined, buttons: new Map<string, () => void>(), missing: [] as IProjectAsset[],
    assets: [] as IProjectAsset[], cards: [] as string[], search: '?p=project-one',
    user: { activeRole: 'Главный админ', userRoles: ['Главный админ'], email: 'one@example.test', projectRoles: [] as Array<{projectId:string;projectName:string;role:string}> },
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.useState, useRef: h.useRef, useMemo: h.useMemo,
    useCallback: h.useCallback, useEffect: h.useEffect, useLayoutEffect: h.useEffect }));
vi.mock('react-redux', () => ({ useSelector: (read: (state: unknown) => unknown) => read({ userBlock: { user: ui.user } }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/store', search: ui.search, hash: '' }),
    useHistory: () => ({ replace: vi.fn(), push: vi.fn(), location: { pathname: '/store', search: ui.search, hash: '' } }) }));
vi.mock('../src/core/api/bff', () => ({ default: { listAiPlugins: (...args: unknown[]) => ui.plugins(...args), listSkills: (...args: unknown[]) => ui.skills(...args) } }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    if (!ui.owners.has(ui.scope)) { const scope = ui.scope; ui.owners.set(scope, () => () => scope === ui.scope); }
    return { scope: ui.scope, captureOwner: ui.owners.get(ui.scope)! };
} }));
vi.mock('../src/modules/Projects/useAvailableProjects', () => ({ useAvailableProjects: () => ({ projects: [{ id: 'project-one', name: 'Первый' }], ready: true, loading: false, error: '', scope: ui.scope, refresh: vi.fn() }) }));
vi.mock('../src/modules/Store/useProjectCatalog', () => ({ useProjectCatalog: () => ({ assets: ui.assets, ready: true, loading: false, error: '', refresh: vi.fn() }) }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: (_: unknown, refresh: () => void) => { ui.refresh = refresh; } }));
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => ({ jobs: [], installations: [], jobsReady: true, installationsReady: true }) }));
vi.mock('../src/modules/Store/installPlans/useInstallPlan', () => ({ useInstallPlan: () => ({}) }));
vi.mock('../src/modules/Store/CatalogTabs', () => ({ CatalogTabs: ({ tools }: { tools: ReactNode }) => tools }));
vi.mock('../src/modules/Store/AppCard', () => ({ default: ({ app }: { app: { name: string } }) => { ui.cards.push(app.name); return createElement('article', null, app.name); } }));
vi.mock('../src/modules/Store/UnavailableProjectAssets', () => ({ default: ({ assets }: { assets: IProjectAsset[] }) => { ui.missing = assets; return null; } }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ FeatureButton: () => null }));
vi.mock('../src/features/Discussions', () => ({ CatalogFeedback: () => null }));
vi.mock('../src/common/components/PageHeading', () => ({ PageHeading: () => null }));
vi.mock('../src/features/CatalogRequests/CatalogHeaderActions', () => ({ CatalogHeaderActions: () => null }));
vi.mock('../src/features/McpBridge/BridgeConnection', () => ({ BridgeConnection: () => null }));
vi.mock('../src/features/McpBridge/LocalInstallations', () => ({ LocalInstallations: () => null }));
vi.mock('../src/features/McpBridge/ProjectInstallationReadiness', () => ({ ProjectInstallationReadiness: () => null }));
vi.mock('../src/modules/Store/ProjectKnowledgeLink', () => ({ ProjectKnowledgeLink: () => null }));
vi.mock('../src/modules/Store/StoreArchiveAction', () => ({ StoreArchiveAction: () => null }));
vi.mock('../src/modules/Store/StoreCreateModal', () => ({ default: () => null }));
vi.mock('../src/modules/Store/StoreDetailsModal', () => ({ default: () => null }));
vi.mock('../src/features/Catalog/StoreEditModal', () => ({ default: () => null }));
vi.mock('../src/modules/Store/packaging/ToolPackagingModal', () => ({ ToolPackagingModal: () => null }));
vi.mock('../src/modules/Store/installPlans/InstallPlanModal', () => ({ InstallPlanModal: () => null }));
vi.mock('../src/modules/Store/installPlans/InstallPlanFailureModal', () => ({ InstallPlanFailureModal: () => null }));
vi.mock('antd', () => {
    const box = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Alert: ({ message, description, action }: { message: ReactNode; description?: ReactNode; action?: ReactNode }) => createElement('div', { role: 'alert' }, message, description, action),
        Button: ({ children, onClick, href }: { children: ReactNode; onClick: () => void; href?: string }) => { ui.buttons.set(Array.isArray(children) ? children.join('') : String(children), onClick); return createElement(href ? 'a' : 'button', {href}, children); },
        Typography: { Text: box, Paragraph: box }, Row: box, Col: box, Space: box, Radio: { Group: () => null },
        Checkbox: () => null, Empty: ({ description }: { description: string }) => createElement('div', null, description), Input: { Search: () => null },
        Modal: () => null, Select: () => null, Spin: () => createElement('span', null, 'Загрузка'), message: {} };
});
const plugin = (n: number): IAiPlugin => ({ id: 'mcp-' + n, name: 'MCP ' + n, kind: 'mcp', description: '', version: 1, tags: [], origin: '', files: [], createdAt: '', updatedAt: '' });
const page = (items: IAiPlugin[], number = 1, total = items.length, size = 100): IPage<IAiPlugin> => ({ items, page: number, total, size });
const skill: ISkillListSummary = { path: 'common/helper', meta: { name: 'Помощник', slug: 'helper', version: 1 } };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let n = 0; n < 25; n++) await Promise.resolve(); };
function render(props: ComponentProps<typeof Store> = {}) { h.begin(); ui.cards = []; ui.missing = []; ui.buttons.clear(); const html = renderToStaticMarkup(createElement(Store, props)); h.commit(); return html; }
async function settle(props: ComponentProps<typeof Store> = {}) { await flush(); return render(props); }
beforeEach(() => { vi.resetAllMocks(); ui.scope = 'admin'; ui.owners.clear(); ui.assets = []; ui.search = '?p=project-one'; ui.user.activeRole = 'Главный админ'; ui.user.userRoles = ['Главный админ']; ui.user.projectRoles = []; ui.plugins.mockResolvedValue(page([plugin(1)])); ui.skills.mockResolvedValue([skill]); });
afterEach(() => h.dispose());

describe('Переход из каталога проекта в общий каталог', () => {
    const props = {embedded: true, presetTarget: 'project-one'};
    it('Объясняет пустой проект и предлагает администратору добавить инструменты', async () => {
        render(props); const html = await settle(props);
        expect(ui.cards).toEqual([]);
        expect(html).toContain('В каталог проекта ещё не добавлены инструменты.');
        expect(html).toContain('<a href="/store?p=project-one">Добавить из общего каталога</a>');
    });
    it('Сохраняет точный проект и не переносит поиск или вкладку в общий каталог', async () => {
        ui.search = '?p=another-project&q=missing&tab=store';
        render(props); const html = await settle(props);
        expect(html).toContain('По этим условиям ничего не найдено');
        expect(html).toContain('<a href="/store?p=project-one">Добавить из общего каталога</a>');
    });
    it('Оставляет добавление доступным после первого инструмента', async () => {
        ui.assets = [{assetKind: 'mcp', assetId: 'mcp-1', addedBy: '', addedAt: ''}];
        render(props); const html = await settle(props);
        expect(ui.cards).toEqual(['MCP 1']);
        expect(html).toContain('Добавить из общего каталога');
    });
    it.each(['Разработчик', 'Наблюдатель'])('Не предлагает изменение каталога для роли %s', async activeRole => {
        ui.user.activeRole = activeRole; ui.user.userRoles = [activeRole];
        ui.user.projectRoles = [{projectId: 'project-one', projectName: 'Первый', role: activeRole}];
        render(props); expect(await settle(props)).not.toContain('Добавить из общего каталога');
    });
    it('Не переносит права администратора другого проекта в выбранный', async () => {
        ui.user.activeRole = 'Админ проекта'; ui.user.userRoles = ['Админ проекта'];
        ui.user.projectRoles = [{projectId: 'another-project', projectName: 'Другой', role: 'Админ проекта'}];
        render(props); expect(await settle(props)).not.toContain('Добавить из общего каталога');
    });
    it('Не предлагает переход в общий каталог из самого общего каталога', async () => {
        render(); expect(await settle()).not.toContain('Добавить из общего каталога');
    });
});

describe('Источники инструментов не блокируют друг друга', () => {
    it('Готовый MCP виден, пока сервис скиллов не отвечает', async () => {
        const hung = deferred<ISkillListSummary[]>(); ui.skills.mockReturnValueOnce(hung.promise); render();
        await settle(); expect(ui.cards).toContain('MCP 1'); expect(ui.cards).not.toContain('Помощник');
        hung.resolve([skill]); await settle(); expect(ui.cards).toEqual(['MCP 1', 'Помощник']);
    });
    it('Готовый скилл виден, пока каталог MCP не отвечает', async () => {
        const hung = deferred<IPage<IAiPlugin>>(); ui.plugins.mockReturnValueOnce(hung.promise); render();
        await settle(); expect(ui.cards).toContain('Помощник');
        hung.resolve(page([plugin(1)])); await settle(); expect(ui.cards).toEqual(['MCP 1', 'Помощник']);
    });
    it('Отказ скиллов сохраняет здоровые карточки и повторяет только отказавший источник', async () => {
        ui.skills.mockRejectedValueOnce(new Error('Skills unavailable')); render();
        const html = await settle(); expect(ui.cards).toEqual(['MCP 1']); expect(html).toContain('Не удалось загрузить скиллы');
        ui.buttons.get('Повторить загрузку скиллов')!(); await settle(); expect(ui.cards).toEqual(['MCP 1', 'Помощник']);
        expect(ui.plugins).toHaveBeenCalledTimes(1); expect(ui.skills).toHaveBeenCalledTimes(2);
    });
    it('Отказ обновления сохраняет предыдущий источник и не объявляет его назначения отсутствующими', async () => {
        ui.assets = [{ assetKind: 'skill', assetId: 'common/deleted-or-unavailable', addedBy: '', addedAt: '' }];
        render(); await settle(); expect(ui.missing).toHaveLength(1);
        ui.skills.mockRejectedValueOnce(new Error('Skills unavailable')); ui.refresh!(); await settle();
        expect(ui.cards).toEqual(['MCP 1', 'Помощник']); expect(ui.missing).toEqual([]);
    });
    it('Неизвестный источник не мешает определить отсутствие в успешно загруженном', async () => {
        const hung = deferred<ISkillListSummary[]>(); ui.skills.mockReturnValueOnce(hung.promise);
        ui.assets = [{ assetKind: 'skill', assetId: 'common/unknown', addedBy: '', addedAt: '' }, { assetKind: 'mcp', assetId: 'gone', addedBy: '', addedAt: '' }];
        render(); await settle(); expect(ui.missing.map(asset => asset.assetId)).toEqual(['gone']); hung.resolve([]); await settle();
        expect(ui.missing.map(asset => asset.assetId)).toEqual(['common/unknown', 'gone']);
    });
    it('Пагинация публикует MCP только целиком, независимо от готового скилла', async () => {
        const last = deferred<IPage<IAiPlugin>>(); ui.plugins.mockResolvedValueOnce(page([plugin(1)], 1, 2, 1)).mockReturnValueOnce(last.promise);
        render(); await settle(); expect(ui.cards).toEqual(['Помощник']); last.resolve(page([plugin(2)], 2, 2, 1)); await settle();
        expect(ui.cards).toEqual(['MCP 1', 'MCP 2', 'Помощник']);
    });
    it('Поздний отказ и результат прежнего владельца не меняют новый каталог', async () => {
        const oldPlugins = deferred<IPage<IAiPlugin>>(), oldSkills = deferred<ISkillListSummary[]>();
        ui.plugins.mockReturnValueOnce(oldPlugins.promise); ui.skills.mockReturnValueOnce(oldSkills.promise); render(); ui.scope = 'reader'; render(); await settle();
        oldPlugins.resolve(page([plugin(99)])); oldSkills.reject(new Error('Previous owner')); const html = await settle();
        expect(ui.cards).toEqual(['MCP 1', 'Помощник']); expect(html).not.toContain('Previous owner');
    });
    it('Запоздалые источники не откатывают более свежее обновление того же владельца', async () => {
        render(); await settle(); const oldPlugins = deferred<IPage<IAiPlugin>>(), oldSkills = deferred<ISkillListSummary[]>();
        ui.plugins.mockReturnValueOnce(oldPlugins.promise); ui.skills.mockReturnValueOnce(oldSkills.promise); ui.refresh!(); await settle();
        ui.plugins.mockResolvedValueOnce(page([plugin(2)])); ui.refresh!(); await settle(); expect(ui.cards).toEqual(['MCP 2', 'Помощник']);
        oldPlugins.resolve(page([plugin(99)])); oldSkills.resolve([]); await settle(); expect(ui.cards).toEqual(['MCP 2', 'Помощник']);
    });
    it('Подтверждённый отказ доступа скрывает только прежние карточки отказавшего источника', async () => {
        render(); await settle(); ui.skills.mockRejectedValueOnce({ isAxiosError: true, response: { status: 403 } }); ui.refresh!(); await settle();
        expect(ui.cards).toEqual(['MCP 1']);
    });
});
