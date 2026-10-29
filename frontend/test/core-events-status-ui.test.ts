import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Core from '../src/modules/Core/Core';

const fixture = vi.hoisted(() => ({ compact: false, states: [] as boolean[] }));
vi.mock('react', async original => {
    const actual = await original<typeof import('react')>();
    return { ...actual, useLayoutEffect: () => undefined, useState: (initial?: unknown) =>
        actual.useState(typeof initial === 'boolean' && fixture.states.length ? fixture.states.shift() : initial) };
});
vi.mock('react-redux', () => ({
    useSelector: () => ({ isAuth: true, user: { email: 'fixture@example.test', routePermissions: [] } }),
    useStore: () => ({ getState: () => ({ userBlock: {} }) }),
}));
vi.mock('react-router-dom', () => ({
    useHistory: () => ({ replace: vi.fn() }),
    useLocation: () => ({ pathname: '/projects', search: '', hash: '' }),
}));
vi.mock('../src/core/hooks', () => ({ useAppDispatch: () => vi.fn() }));
vi.mock('../src/core/api', () => ({ setUnauthorizedHandler: vi.fn() }));
vi.mock('../src/core/socket/socketClient', () => ({ default: {} }));
vi.mock('../src/features/UserBlock', () => ({ LoginScreen: () => null }));
vi.mock('../src/features/UserBlock/components/RoleSwitcher', () => ({ RoleSwitcher: () => null }));
vi.mock('../src/features/UserBlock/components/UserInfo', () => ({ UserInfo: () => null }));
vi.mock('../src/features/UserBlock/redux/actions', () => ({ authInit: vi.fn() }));
vi.mock('../src/features/UserBlock/redux/reducers', () => ({ signOut: vi.fn() }));
vi.mock('../src/common/components/LazySection', () => ({ lazySection: () => () => null }));
vi.mock('../src/common/components/AccessibleDrawer', () => ({ default: ({ open, title, children }: { open: boolean; title: ReactNode; children?: ReactNode }) =>
    open ? createElement('section', { 'data-drawer': true }, title, children) : null }));
vi.mock('../src/modules/Operations/OperationsButton', () => ({ default: () => null }));
vi.mock('../src/features/ModelChat/ChatLauncher', () => ({ChatLauncher:()=>null}));
vi.mock('../src/features/McpBridge/BridgePairing', () => ({ BridgePairing: () => null }));
vi.mock('../src/features/ComputerSetup/ComputerEnvironment', () => ({ComputerEnvironmentProvider: ({children}: {children: ReactNode}) => children}));
vi.mock('../src/features/ComputerSetup/ComputerHeader', () => ({ComputerHeader: () => createElement('div', {'data-computer-header': true}, 'Рабочий компьютер · OpenCode')}));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Grid: { useBreakpoint: () => ({ lg: !fixture.compact }) },
        Layout: Object.assign(content, { Sider: content, Header: content, Content: content }),
        Menu: () => null, Button: () => null, Space: content, Typography: { Text: content },
        Badge: ({ status }: { status: string }) => createElement('i', { 'data-status': status }) };
});

function render(compact: boolean, menuOpen = false): string {
    fixture.compact = compact;
    fixture.states = [menuOpen, false];
    return renderToStaticMarkup(createElement(Core, { modulesStructure: [], children: 'Содержимое страницы' }));
}

describe('Header keeps computer status separate from background events', () => {
    it.each([false, true])('shows computer/OpenCode instead of the auto-update label, compact=%s', compact => {
        const html = render(compact);
        expect(html).toContain('data-computer-header="true"');
        expect(html).toContain('Рабочий компьютер · OpenCode');
        expect(html).not.toContain('app__live');
        expect(html).not.toContain('Автообновление');
        expect(html).not.toContain('Нет автообновления');
    });
    it('Мобильное меню оставляет короткий заголовок без слогана', () => {
        const html = render(true, true);
        expect(html).toContain('<section data-drawer="true"><span class="app__drawer-brand">');
        expect(html).toContain('Нейроцентр</span>');
        expect(html).not.toContain('Рабочее пространство команды');
        expect(html).not.toContain('app__brand');
    });
    it('Постоянная боковая панель сохраняет название и существующее описание', () => {
        expect(render(false)).toContain('Рабочее пространство команды');
    });
});
