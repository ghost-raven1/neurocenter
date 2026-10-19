import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import Store from '../src/modules/Store/Store';
import bffApi from '../src/core/api/bff';
import type {IAiPlugin} from '../src/core/api/interfaces';
import type {ToolBuild} from '../src/modules/Store/packaging/types';

const hooks = vi.hoisted(() => {
    let cursor = 0, mounted = true, disposedWrites = 0;
    const slots: Array<{value?: unknown; dependencies?: unknown[]; cleanup?: () => void}> = [];
    const effects: Array<() => void> = [];
    const same = (left?: unknown[], right?: unknown[]) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
    const memo = (factory: () => unknown, dependencies: unknown[]) => {
        const index = cursor++, previous = slots[index];
        if (!previous || !same(previous.dependencies, dependencies)) slots[index] = {value: factory(), dependencies};
        return slots[index].value;
    };
    return {
        begin: () => { if (!slots.length) disposedWrites = 0; mounted = true; cursor = 0; }, commit: () => { effects.splice(0).forEach(effect => effect()); },
        dispose: () => { mounted = false; slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        lateWrites: () => disposedWrites,
        useState<T>(initial: T | (() => T)) {
            const slot = slots[cursor++] ??= {value: typeof initial === 'function' ? (initial as () => T)() : initial};
            return [slot.value, (next: T | ((previous: T) => T)) => { if (!mounted) disposedWrites++; slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next; }];
        },
        useRef<T>(initial?: T) { return (slots[cursor++] ??= {value: {current: initial}}).value; },
        useMemo: memo, useCallback: (callback: unknown, dependencies: unknown[]) => memo(() => callback, dependencies),
        useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous && same(previous.dependencies, dependencies)) return;
            const slot = slots[index] = {dependencies};
            effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});
interface ButtonProps {children?: ReactNode; disabled?: boolean; loading?: boolean; onClick?: () => void;}
const ui = vi.hoisted(() => ({
    scope: 'admin-a', owners: new Map<string, () => () => boolean>(),
    location: {pathname: '/store', search: '?p=prj-a', hash: ''},
    buttons: new Map<string, ButtonProps>(), errors: [] as string[], form: false, open: false,
    job: undefined as ToolBuild | undefined, view: null as {id: string} | null, reset: vi.fn(),
    history: {location: {pathname: '/store', search: '?p=prj-a', hash: ''}, replace: vi.fn(), push: vi.fn()},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: hooks.useState,
    useRef: hooks.useRef, useEffect: hooks.useEffect, useMemo: hooks.useMemo, useCallback: hooks.useCallback,
}));
vi.mock('react-router-dom', () => ({useLocation: () => ui.location, useHistory: () => ui.history}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: {
    activeRole: 'Главный админ', userRoles: ['Главный админ'], projectRoles: [],
}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    if (!ui.owners.has(ui.scope)) { const scope = ui.scope; ui.owners.set(scope, () => () => scope === ui.scope); }
    return {scope: ui.scope, captureOwner: ui.owners.get(ui.scope)!};
}}));
vi.mock('../src/modules/Projects/useAvailableProjects', () => ({useAvailableProjects: () => ({
    projects: [{id: 'prj-a', name: 'Проект A'}, {id: 'prj-b', name: 'Проект B'}], ready: true, scope: ui.scope,
})}));
vi.mock('../src/modules/Store/useProjectCatalog', () => ({useProjectCatalog: () => ({assets: [], ready: true, loading: false, refresh: vi.fn(async () => undefined)})}));
vi.mock('../src/features/McpBridge/useBridge', () => ({useBridge: () => ({devices: [], jobs: [], installations: [], errors: {}, reload: vi.fn()})}));
vi.mock('../src/modules/Store/installPlans/useInstallPlan', () => ({useInstallPlan: () => ({busy: '', review: null, failure: null})}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: () => undefined}));
vi.mock('../src/core/api/bff', () => ({default: {getAiPlugin: vi.fn(), listAiPlugins: vi.fn(), listSkills: vi.fn()}}));
vi.mock('../src/modules/Store/packaging/useNpmMetadata', () => ({useNpmMetadata: () => ({resolve: vi.fn()})}));
vi.mock('../src/modules/Store/packaging/useRepositoryMetadata', () => ({useRepositoryMetadata: () => ({resolve: vi.fn()})}));
vi.mock('../src/modules/Store/packaging/useToolBuild', () => ({useToolBuild: () => ({job: ui.job, reset: ui.reset, active: false, submitting: false, unresolved: false})}));
vi.mock('../src/common/components/PageHeading', () => ({PageHeading: ({actions}: {actions: ReactNode}) => actions}));
vi.mock('../src/features/McpBridge/BridgeConnection', () => ({BridgeConnection: () => null}));
vi.mock('../src/features/McpBridge/LocalInstallations', () => ({LocalInstallations: () => null}));
vi.mock('../src/features/McpBridge/ProjectInstallationReadiness', () => ({ProjectInstallationReadiness: () => null}));
vi.mock('../src/modules/Store/ProjectKnowledgeLink', () => ({ProjectKnowledgeLink: () => null}));
vi.mock('../src/modules/Store/CatalogTabs', () => ({CatalogTabs: ({tools}: {tools: ReactNode}) => tools}));
vi.mock('../src/modules/Store/UnavailableProjectAssets', () => ({default: () => null}));
vi.mock('../src/modules/Store/StoreCreateModal', () => ({default: () => null}));
vi.mock('../src/modules/Store/StoreEditModal', () => ({default: () => null}));
vi.mock('../src/modules/Store/StoreDetailsModal', () => ({default: ({viewApp}: {viewApp: typeof ui.view}) => { ui.view = viewApp; return null; }}));
vi.mock('../src/modules/Store/installPlans/InstallPlanModal', () => ({InstallPlanModal: () => null}));
vi.mock('../src/modules/Store/installPlans/InstallPlanFailureModal', () => ({InstallPlanFailureModal: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    const input = () => null;
    return {
        Alert: ({type, message}: {type: string; message: string}) => { if (type === 'error') ui.errors.push(message); return null; },
        Button: (props: ButtonProps) => { ui.buttons.set(String(props.children), props); return null; },
        Modal: ({open, children}: {open: boolean; children?: ReactNode}) => { if (open) ui.open = true; return open ? children : null; },
        Form: Object.assign(({children}: {children?: ReactNode}) => { ui.form = true; return children; }, {Item: content}),
        Input: Object.assign(input, {Search: input, TextArea: input}), Radio: {Group: () => null}, Select: input,
        Collapse: Object.assign(content, {Panel: content}), Checkbox: content, Col: content, Row: content, Empty: content,
        Space: content, Spin: () => null, Progress: () => null, Typography: {Text: content, Paragraph: content},
    };
});

const job = (id: string): ToolBuild => ({id, operationId: id, state: 'SUCCEEDED', percent: 100, message: 'Готово', result: {catalogId: id, name: id, version: 1}});
const plugin = (id: string): IAiPlugin => ({id, kind: 'mcp', name: id, description: '', tags: [], version: 1, origin: 'fixture', files: []} as unknown as IAiPlugin);
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
const flush = async () => { for (let index = 0; index < 14; index++) await Promise.resolve(); };
function render() {
    hooks.begin(); ui.buttons.clear(); ui.errors = []; ui.form = false; ui.open = false;
    renderToStaticMarkup(createElement(Store)); hooks.commit();
}
function click(label: string) { const button = ui.buttons.get(label)!; expect(button).toBeDefined(); expect(button.disabled).not.toBe(true); button.onClick!(); }
function open() { render(); click('Упаковать инструмент'); render(); click('Открыть в каталоге'); render(); }

beforeEach(() => {
    vi.resetAllMocks(); ui.scope = 'admin-a'; ui.owners.clear(); ui.location = {pathname: '/store', search: '?p=prj-a', hash: ''};
    ui.history.location = ui.location; ui.job = job('old-package'); ui.view = null;
    ui.reset.mockImplementation(() => { ui.job = undefined; });
    vi.mocked(bffApi.listAiPlugins).mockResolvedValue({items: [], page: 1, size: 100, total: 0});
    vi.mocked(bffApi.listSkills).mockResolvedValue([]);
});
afterEach(() => hooks.dispose());

describe('Открытие опубликованного инструмента принадлежит текущей форме упаковки', () => {
    it.each(['success', 'failure'] as const)('Поздний %s прежнего открытия не меняет новый черновик после reset', async outcome => {
        const response = deferred<IAiPlugin>(); vi.mocked(bffApi.getAiPlugin).mockReturnValue(response.promise);
        open(); click('Упаковать ещё'); render(); expect(ui.form).toBe(true);
        if (outcome === 'success') response.resolve(plugin('old-package')); else response.reject(new Error('Отказ прежней карточки'));
        await flush(); render();
        expect(ui.form).toBe(true); expect(ui.view).toBeNull(); expect(ui.errors).toEqual([]);
    });

    it.each((['close', 'reopen', 'project', 'project-return', 'owner', 'owner-return', 'job', 'unmount'] as const)
        .flatMap(change => (['success', 'failure'] as const).map(outcome => ({change, outcome}))))('Поздний $outcome игнорируется после события $change', async ({change, outcome}) => {
        const response = deferred<IAiPlugin>(); vi.mocked(bffApi.getAiPlugin).mockReturnValue(response.promise); open();
        if (change === 'close') { click('Скрыть'); render(); }
        if (change === 'reopen') { click('Скрыть'); render(); click('Упаковать инструмент'); render(); }
        if (change === 'project') { ui.location.search = '?p=prj-b'; render(); }
        if (change === 'project-return') { ui.location.search = '?p=prj-b'; render(); ui.location.search = '?p=prj-a'; render(); }
        if (change === 'owner') ui.scope = 'admin-b';
        if (change === 'owner-return') { ui.scope = 'admin-b'; render(); ui.scope = 'admin-a'; render(); }
        if (change === 'job') { ui.job = job('new-package'); render(); }
        if (change === 'unmount') hooks.dispose();
        if (outcome === 'success') response.resolve(plugin('old-package')); else response.reject(new Error('Отказ прежней карточки'));
        await flush();
        if (change !== 'unmount') render();
        expect(ui.view).toBeNull(); expect(ui.errors).toEqual([]); expect(hooks.lateWrites()).toBe(0); expect(bffApi.getAiPlugin).toHaveBeenCalledOnce();
    });

    it('Завершение старого GET не снимает занятость открытия следующего результата', async () => {
        const old = deferred<IAiPlugin>(), fresh = deferred<IAiPlugin>();
        vi.mocked(bffApi.getAiPlugin).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        open(); click('Упаковать ещё'); ui.job = job('new-package'); render(); click('Открыть в каталоге'); render();
        old.resolve(plugin('old-package')); await flush(); render();
        expect(ui.buttons.get('Открыть в каталоге')!.loading).toBe(true); expect(ui.view).toBeNull();
        fresh.resolve(plugin('new-package')); await flush(); render();
        expect(ui.view?.id).toBe('new-package');
    });

    it('Двойное нажатие до render отправляет один GET, текущий отказ допускает повтор', async () => {
        const response = deferred<IAiPlugin>(); vi.mocked(bffApi.getAiPlugin).mockReturnValueOnce(response.promise);
        render(); click('Упаковать инструмент'); render(); click('Открыть в каталоге'); click('Открыть в каталоге');
        expect(bffApi.getAiPlugin).toHaveBeenCalledOnce(); response.reject(new Error('Нет связи')); await flush(); render();
        expect(ui.errors).toContain('Нет связи');
        vi.mocked(bffApi.getAiPlugin).mockResolvedValueOnce(plugin('old-package')); click('Открыть в каталоге'); await flush(); render();
        expect(ui.view?.id).toBe('old-package');
    });
});
