import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserInfo } from '../src/features/UserBlock/components/UserInfo';

const fixture = vi.hoisted(() => ({
    open: false, processing: false,
    user: { displayName: 'Алексей', email: 'alex@example.test', activeRole: 'Главный админ', userRoles: ['Главный админ'] },
    dispatch: vi.fn(),
    select: null as null | { disabled: boolean; value: string; onChange: (role: string) => void },
}));
vi.mock('react-redux', () => ({ useSelector: (select: (state: unknown) => unknown) => select({ userBlock: { user: fixture.user, processing: fixture.processing } }) }));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: vi.fn() }) }));
vi.mock('../src/core/hooks', () => ({ useAppDispatch: () => fixture.dispatch }));
vi.mock('../src/features/UserBlock/redux/actions', () => ({ authLogout: vi.fn(), authSwitchRole: (role: string) => ({ type: 'switch-role', role }) }));
vi.mock('antd', () => ({
    Button: ({ children, 'aria-label': label }: { children: ReactNode; 'aria-label': string }) => createElement('button', { 'aria-label': label }, children),
    Dropdown: ({ children, dropdownRender }: { children: ReactNode; dropdownRender: (menu: ReactNode) => ReactNode }) =>
        createElement('div', null, children, fixture.open ? dropdownRender(createElement('div', null, 'Выйти')) : null),
    Select: (props: { disabled: boolean; value: string; onChange: (role: string) => void; 'aria-label': string }) => {
        fixture.select = props;
        return createElement('select', { disabled: props.disabled, 'aria-label': props['aria-label'], value: props.value, onChange: () => undefined },
            fixture.user.userRoles.map(role => createElement('option', { key: role, value: role }, role)));
    },
    message: { error: vi.fn() },
}));

const render = (): string => renderToStaticMarkup(createElement(UserInfo));
beforeEach(() => {
    fixture.open = false; fixture.processing = false; fixture.select = null; fixture.dispatch.mockClear();
    fixture.user.activeRole = 'Главный админ'; fixture.user.userRoles = ['Главный админ'];
});

describe('Роль находится в меню пользователя', () => {
    it('Закрытое меню не дублирует роль в шапке', () => {
        const html = render();
        expect(html).toContain('aria-label="Меню пользователя"');
        expect(html).not.toContain('Главный админ');
        expect(html).not.toContain('Активная роль');
    });

    it('Открытое меню показывает учётную запись, единственную роль и выход', () => {
        fixture.open = true;
        const html = render();
        expect(html).toContain('alex@example.test');
        expect(html).toContain('Активная роль');
        expect(html).toContain('Главный админ');
        expect(html).toContain('Выйти');
        expect(fixture.select).toBeNull();
    });

    it('Несколько назначенных ролей сохраняют рабочее переключение из меню', () => {
        fixture.open = true; fixture.user.userRoles = ['Главный админ', 'Наблюдатель'];
        expect(render()).toContain('aria-label="Активная роль"');
        fixture.select?.onChange('Наблюдатель');
        expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'switch-role', role: 'Наблюдатель' });
    });

    it('Во время смены роли селектор остаётся заблокированным', () => {
        fixture.open = true; fixture.processing = true; fixture.user.userRoles = ['Главный админ', 'Наблюдатель'];
        render();
        expect(fixture.select?.disabled).toBe(true);
    });
});
