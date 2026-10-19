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
vi.mock('../src/common/components/AccessibleDrawer', () => ({ default: () => null }));
vi.mock('../src/modules/Operations/OperationsButton', () => ({ default: () => null }));
vi.mock('../src/features/McpBridge/BridgePairing', () => ({ BridgePairing: () => null }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Grid: { useBreakpoint: () => ({ lg: !fixture.compact }) },
        Layout: Object.assign(content, { Sider: content, Header: content, Content: content }),
        Menu: () => null, Button: () => null, Space: content, Typography: { Text: content },
        Badge: ({ status }: { status: string }) => createElement('i', { 'data-status': status }) };
});

function render(live: boolean, compact: boolean): string {
    fixture.compact = compact;
    // Снимок оболочки: меню и операции закрыты; проверяем только представление канала событий.
    fixture.states = [false, false, live];
    return renderToStaticMarkup(createElement(Core, { modulesStructure: [], children: 'Содержимое страницы' }));
}

describe('Канал событий сайта отделён от доступности моста', () => {
    it.each([false, true])('Подключённый канал имеет точную подпись и доступное имя, компактный режим=%s', compact => {
        const html = render(true, compact);
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-label="Онлайн-обновления сайта подключены. Статус моста смотрите в списке компьютеров."');
        expect(html).toContain('Канал событий сайта подключён');
        expect(html).toContain('Онлайн-обновления');
        expect(html).not.toContain('На связи');
    });

    it('Потеря канала обозначена как недоступность обновлений сайта', () => {
        const html = render(false, true);
        expect(html).toContain('Обновления: нет связи');
        expect(html).toContain('Канал событий сайта восстанавливается');
        expect(html).toContain('Статус моста смотрите в списке компьютеров');
        expect(html).toContain('data-status="warning"');
    });
});
