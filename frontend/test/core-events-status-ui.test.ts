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
vi.mock('../src/features/McpBridge/BridgePairing', () => ({ BridgePairing: () => null }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Grid: { useBreakpoint: () => ({ lg: !fixture.compact }) },
        Layout: Object.assign(content, { Sider: content, Header: content, Content: content }),
        Menu: () => null, Button: () => null, Space: content, Typography: { Text: content },
        Badge: ({ status }: { status: string }) => createElement('i', { 'data-status': status }) };
});

function render(live: boolean, compact: boolean, menuOpen = false): string {
    fixture.compact = compact;
    // Снимок оболочки: меню и операции закрыты; проверяем только представление канала событий.
    fixture.states = [menuOpen, false, live];
    return renderToStaticMarkup(createElement(Core, { modulesStructure: [], children: 'Содержимое страницы' }));
}

describe('Канал событий сайта отделён от доступности моста', () => {
    it.each([false, true])('Подключённый канал имеет точную подпись и доступное имя, компактный режим=%s', compact => {
        const html = render(true, compact);
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-label="Автообновление данных подключено."');
        expect(html).toContain('Изменения на сайте приходят автоматически');
        expect(html.replaceAll('<wbr/>','')).toContain('class="app__live-label">Автообновление</span>');
        expect(html).not.toContain('На связи');
    });

    it('Потеря канала обозначена как недоступность обновлений сайта', () => {
        const html = render(false, true);
        expect(html.replaceAll('<wbr/>','')).toContain('Нет автообновления');
        expect(html).toContain('Автообновление данных недоступно. Восстанавливаем соединение.');
        expect(html).toContain('Статус компьютеров находится в списке мостов');
        expect(html).toContain('app__live--disconnected');
    });

    it('Мобильное меню оставляет короткий заголовок без слогана', () => {
        const html = render(true, true, true);
        expect(html).toContain('<section data-drawer="true">Нейроцентр');
        expect(html).not.toContain('Рабочее пространство команды');
        expect(html).not.toContain('app__brand');
    });

    it('Постоянная боковая панель сохраняет название и существующее описание', () => {
        expect(render(true, false)).toContain('Рабочее пространство команды');
    });
});
