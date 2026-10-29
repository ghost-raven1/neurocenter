// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { act, createElement, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bffApi from '../src/core/api/bff';
import type { IAuthMe } from '../src/core/interfaces';
import { authInit, authLogout } from '../src/features/UserBlock/redux/actions';
import userBlock, { signOut } from '../src/features/UserBlock/redux/reducers';
import projects from '../src/modules/Projects/redux/reducers';
import rag from '../src/modules/Rag/redux/reducers';
import maintenance from '../src/modules/Maintenance/redux/reducers';
import access from '../src/modules/Access/redux/reducers';
import audit from '../src/modules/Audit/redux/reducers';
import Core from '../src/modules/Core/Core';

vi.mock('../src/core/api/bff', () => ({ default: { me: vi.fn(), logout: vi.fn() } }));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ replace: vi.fn() }), useLocation: () => ({ pathname: '/projects', search: '', hash: '' }) }));
vi.mock('../src/core/api', () => ({ setUnauthorizedHandler: vi.fn() }));
vi.mock('../src/core/socket/socketClient', () => ({ default: { connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock('../src/features/UserBlock', () => ({ LoginScreen: () => createElement('p', null, 'Войти в систему') }));
vi.mock('../src/features/UserBlock/components/UserInfo', () => ({ UserInfo: () => null }));
vi.mock('../src/common/components/LazySection', () => ({ lazySection: () => () => null }));
vi.mock('../src/common/components/AccessibleDrawer', () => ({ default: () => null }));
vi.mock('../src/modules/Operations/OperationsButton', () => ({ default: () => null }));
vi.mock('../src/features/ModelChat/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/features/ChatActivity/useChatPresence', () => ({ useChatPresence: () => undefined }));
vi.mock('../src/features/McpBridge/BridgePairing', () => ({ BridgePairing: () => null }));
vi.mock('../src/features/ComputerSetup/ComputerEnvironment', () => ({ComputerEnvironmentProvider: ({children}: {children: ReactNode}) => children}));
vi.mock('../src/features/ComputerSetup/ComputerHeader', () => ({ComputerHeader: () => null}));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Grid: { useBreakpoint: () => ({ lg: true }) }, Layout: Object.assign(content, { Sider: content, Header: content, Content: content }),
        Menu: () => null, Space: content, Typography: { Text: content },
        Alert: ({ message, description, action }: { message: ReactNode; description?: ReactNode; action?: ReactNode }) => createElement('div', { role: 'alert' }, message, description, action),
        Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => createElement('button', { onClick, disabled }, children) };
});

const session: IAuthMe = { user: { id: 'one', email: 'one@example.test', principalName: 'one', displayName: 'Первый',
    activeRole: 'Главный админ', userRoles: ['Главный админ'], routePermissions: ['projects'], projectRoles: [] }, policies: { projects: ['read', 'write'] } };
const reducer = { userBlock, projects, rag, maintenance, access, audit };
const denied = (status: number) => ({ isAxiosError: true, response: { status } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function loaded() {
    const initial = configureStore({ reducer });
    vi.mocked(bffApi.me).mockResolvedValueOnce(session); await initial.dispatch(authInit());
    const state = initial.getState();
    return configureStore({ reducer, preloadedState: { ...state,
        projects: { ...state.projects, query: 'Не потерять фильтр', selectedId: 'project-one' },
        rag: { ...state.rag, list: [{ projectKey: 'project-one', rowCount: 9, lastSyncedAt: null, dimension: 16 }] },
        maintenance: { ...state.maintenance, storage: { totalBytesUsed: 100, totalBytesLimit: 200, stagingBytesBudget: 0, buckets: [] } },
        access: { ...state.access, decisions: [{ scope: 'project', scopeId: 'project-one', actions: ['read'], decisionId: 'one', policyRevision: 1, ttlSeconds: 0 }] },
        audit: { ...state.audit, loadedPage: 1, total: 10 },
    } });
}
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

/** Mount the real shell once so a lost uncontrolled draft exposes a remount. */
async function mount(store: Awaited<ReturnType<typeof loaded>>) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
        root.render(createElement(Provider, { store, children: createElement(Core, { modulesStructure: [],
            children: createElement('textarea', { 'aria-label': 'Сообщение', defaultValue: 'Начальный текст' }) }) }));
    });
    return container;
}
async function mountSession() {
    const store = await loaded();
    vi.mocked(bffApi.me).mockResolvedValueOnce(session);
    return { store, container: await mount(store) };
}
afterEach(async () => {
    for (const { root, container } of mounted.splice(0)) {
        await act(async () => { root.unmount(); });
        container.remove();
    }
    vi.resetAllMocks();
});

describe('Отказ проверки сессии не разрушает независимое рабочее состояние', () => {
    it.each([new Error('Network unavailable'), denied(503)])('Сохраняет подтверждённого владельца и все пять кэшей при временном отказе %j', async error => {
        const store = await loaded(), before = store.getState();
        vi.mocked(bffApi.me).mockRejectedValueOnce(error); await store.dispatch(authInit());
        expect(store.getState().userBlock).toMatchObject({ isAuth: true, user: session.user, policies: session.policies, authorizationUnconfirmed: true, processing: false });
        expect(store.getState().userBlock.user).toBe(before.userBlock.user);
        for (const key of ['projects', 'rag', 'maintenance', 'access', 'audit'] as const) expect(store.getState()[key]).toEqual(before[key]);
    });
    it.each([401, 403])('Подтверждённый HTTP %i очищает владельца и все кэши', async status => {
        const store = await loaded(); vi.mocked(bffApi.me).mockRejectedValueOnce(denied(status)); await store.dispatch(authInit());
        expect(store.getState().userBlock).toMatchObject({ isAuth: false, user: null, policies: {} });
        expect(Boolean(store.getState().userBlock.authorizationUnconfirmed)).toBe(false);
        for (const key of ['projects', 'rag', 'maintenance', 'access', 'audit'] as const) expect(store.getState()[key].authScope).toBeNull();
    });
    it('Старый 401 после нового временного отказа не завершает последнего подтверждённого владельца', async () => {
        const store = await loaded(), old = deferred<IAuthMe>();
        vi.mocked(bffApi.me).mockReturnValueOnce(old.promise).mockRejectedValueOnce(denied(503));
        const pending = store.dispatch(authInit()); await store.dispatch(authInit()); old.reject(denied(401)); await pending;
        expect(store.getState().userBlock).toMatchObject({ isAuth: true, user: session.user, authorizationUnconfirmed: true });
        expect(store.getState().rag.list).toHaveLength(1);
    });
    it.each(['signOut', 'logout', 'owner-change'])('После временного отказа %s по-прежнему очищает данные прежнего владельца', async action => {
        const store = await loaded(); vi.mocked(bffApi.me).mockRejectedValueOnce(denied(503)); await store.dispatch(authInit());
        if (action === 'signOut') store.dispatch(signOut());
        else if (action === 'logout') { vi.mocked(bffApi.logout).mockResolvedValueOnce({}); await store.dispatch(authLogout()); }
        else { vi.mocked(bffApi.me).mockResolvedValueOnce({ ...session, user: { ...session.user, id: 'two' } }); await store.dispatch(authInit()); }
        expect(store.getState().rag.list).toEqual([]); expect(store.getState().access.decisions).toEqual([]);
        expect(Boolean(store.getState().userBlock.authorizationUnconfirmed)).toBe(false);
    });
});

describe('Смонтированная форма следует подтверждённому состоянию сессии', () => {
    it('Сохраняет введённый черновик и DOM-узел при 503, ожидании повтора и успешном ответе', async () => {
        const { store, container } = await mountSession();
        const field = container.querySelector('textarea')!;
        const draft = 'Черновик после ручного ввода — не начальное значение';
        field.value = draft;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        expect(field.value).not.toBe(field.defaultValue);

        vi.mocked(bffApi.me).mockRejectedValueOnce(denied(503));
        await act(async () => { await store.dispatch(authInit()); });
        expect(container.querySelector('textarea')).toBe(field);
        expect(field.value).toBe(draft);
        expect(container.textContent).toContain('Не удалось проверить доступ');
        expect(container.textContent).not.toContain('Войти в систему');

        const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Повторить проверку доступа')!;
        const response = deferred<IAuthMe>();
        vi.mocked(bffApi.me).mockReturnValueOnce(response.promise);
        await act(async () => { retry.click(); });
        expect(retry.disabled).toBe(true);
        expect(container.querySelector('textarea')).toBe(field);
        expect(field.value).toBe(draft);

        await act(async () => { response.resolve(session); });
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.querySelector('textarea')).toBe(field);
        expect(field.value).toBe(draft);
        expect(store.getState().userBlock).toMatchObject({ authorizationUnconfirmed: false, error: '', isAuth: true });
    });
    it.each([401, 403])('Удаляет форму и предлагает вход после подтверждённого HTTP %i', async status => {
        const { store, container } = await mountSession();
        const field = container.querySelector('textarea')!;
        field.value = 'Черновик предыдущего владельца';
        vi.mocked(bffApi.me).mockRejectedValueOnce(denied(status));
        await act(async () => { await store.dispatch(authInit()); });
        expect(container.querySelector('textarea')).toBeNull();
        expect(field.isConnected).toBe(false);
        expect(container.textContent).toContain('Войти в систему');
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });
    it('Первый 503 показывает вход без формы неизвестного пользователя', async () => {
        const store = configureStore({ reducer });
        vi.mocked(bffApi.me).mockRejectedValueOnce(denied(503));
        const container = await mount(store);
        expect(container.querySelector('textarea')).toBeNull();
        expect(container.textContent).toContain('Войти в систему');
        expect(store.getState().userBlock).toMatchObject({ isAuth: false, user: null });
        expect(Boolean(store.getState().userBlock.authorizationUnconfirmed)).toBe(false);
    });
});
