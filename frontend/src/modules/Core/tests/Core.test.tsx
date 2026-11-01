// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { MemoryRouter } from 'react-router-dom';
import { Grid } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Core from '../Core';
import { FeatureAvailabilityContext } from '../../../features/FeatureFlags/context';
import { featureDefinitions } from '../../../features/FeatureFlags/constants';
import type { IEvaluatedFeatureFlags } from '../../../features/FeatureFlags/interfaces';
import { stubModalBrowser } from '../../../features/ModelCatalog/tests/browser.fixture';
vi.mock('../../../core/api', () => ({ setUnauthorizedHandler: vi.fn() }));
vi.mock('../../../core/hooks', () => {
    const dispatch = vi.fn();
    return { useAppDispatch: () => dispatch };
});
vi.mock('../../../features/UserBlock/redux/actions', () => ({ authInit: vi.fn() }));
vi.mock('../../../features/UserBlock/redux/reducers', () => ({ signOut: vi.fn() }));
vi.mock('../../../core/socket/socketClient', () => ({
    default: { connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../../features/UserBlock', () => ({ LoginScreen: () => <div>Вход в систему</div> }));
vi.mock('../../../features/UserBlock/components/UserInfo', () => ({ UserInfo: () => null }));
vi.mock('../../Operations/OperationsButton', () => ({ default: () => null }));
vi.mock('../../../features/McpBridge/BridgePairing', () => ({ BridgePairing: () => null }));
vi.mock('../../../features/ModelChat/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../../../features/ChatActivity/hooks/useChatPresence', () => ({ useChatPresence: () => undefined }));
vi.mock('../../../features/TabNotifications/hooks/useTabNotifications', () => ({
    useTabNotifications: () => undefined,
}));
vi.mock('../../../features/NotificationSounds/hooks/useNotificationSounds', () => ({
    useNotificationSounds: () => undefined,
}));
vi.mock('../../../features/ComputerSetup/ComputerEnvironment', () => ({
    ComputerEnvironmentProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../../features/ComputerSetup/ComputerHeader', () => ({ ComputerHeader: () => null }));
let root: Root, container: HTMLDivElement;
const user = {
    id: 'owner',
    email: 'owner@example.test',
    activeRole: 'Главный админ',
    userRoles: ['Главный админ'],
    routePermissions: ['assets', 'store'],
    projectRoles: [],
};
const initial = {
    userBlock: {
        isAuth: false,
        user: null as typeof user | null,
        authorizationUnconfirmed: false,
        processing: false,
        error: '',
    },
};
let store: ReturnType<typeof makeStore>;
function makeStore() {
    return createStore((state: typeof initial = initial, action: { type: string; authenticated?: boolean }) =>
        action.type === 'auth'
            ? {
                  ...state,
                  userBlock: {
                      ...state.userBlock,
                      isAuth: !!action.authenticated,
                      user: action.authenticated ? user : null,
                  },
              }
            : state,
    );
}
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ lg: true });
    store = makeStore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
async function render(enabled = true) {
    const flags = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, key === 'catalog_supplies_navigation' ? enabled : true]),
    ) as IEvaluatedFeatureFlags['flags'];
    const data: IEvaluatedFeatureFlags = {
        flags,
        configured: flags,
        blockedBy: Object.fromEntries(
            featureDefinitions.map(({ key }) => [key, [] as IEvaluatedFeatureFlags['blockedBy'][typeof key]]),
        ) as IEvaluatedFeatureFlags['blockedBy'],
    };
    await act(async () =>
        root.render(
            <Provider store={store}>
                <MemoryRouter initialEntries={['/store']}>
                    <FeatureAvailabilityContext.Provider
                        value={{ data, loading: false, error: null, refresh: async () => undefined }}
                    >
                        <Core
                            modulesStructure={[
                                { name: 'store', title: 'Каталог', route: '/store' },
                                { name: 'assets', title: 'Поставка', route: '/assets' },
                            ]}
                        >
                            <div>Содержимое</div>
                        </Core>
                    </FeatureAvailabilityContext.Provider>
                </MemoryRouter>
            </Provider>,
        ),
    );
}
it('login/logout retains hook order and switches the duplicate supply navigation only with the flag', async () => {
    await render();
    expect(container.textContent).toContain('Вход в систему');
    await act(async () => {
        store.dispatch({ type: 'auth', authenticated: true });
    });
    expect(container.textContent).toContain('Содержимое');
    expect(container.textContent).not.toContain('Поставка');
    await render(false);
    expect(container.textContent).toContain('Поставка');
    await act(async () => {
        store.dispatch({ type: 'auth', authenticated: false });
    });
    expect(container.textContent).toContain('Вход в систему');
});
