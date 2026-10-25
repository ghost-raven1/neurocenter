// @vitest-environment jsdom
import {act, createElement, Fragment, StrictMode, useLayoutEffect, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {configureStore} from '@reduxjs/toolkit';
import {Provider, useSelector} from 'react-redux';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {IUserInfo} from '../src/core/interfaces';
import type {IUserBlockState} from '../src/features/UserBlock/interfaces';
import {authDataScope} from '../src/features/UserBlock/authDataScope';
import {tabNotifications} from '../src/features/TabNotifications/tracker';
import {useNotificationSounds} from '../src/features/NotificationSounds/useNotificationSounds';
import {notificationSounds} from '../src/features/NotificationSounds/runtime';
import {soundPrincipal} from '../src/features/NotificationSounds/preferences';
import Settings from '../src/modules/Settings/Settings';
import UserInfo from '../src/features/UserBlock/components/UserInfo/UserInfo';
import {tabDeferred, tabModel, tabRow, tabSnapshot} from './tab-notification-fixtures';
import {controlledChime} from './notification-sound-fixtures';

const h = vi.hoisted(() => ({sounds: true, tabs: true, factory: vi.fn(), dispatch: vi.fn(), sliders: [] as Array<(volume: number) => void>}));
vi.mock('../src/features/NotificationSounds/browserChime', () => ({createBrowserChime: () => h.factory()}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: (...keys: string[]) => ({enabled: keys.every(key => key === 'tab_notifications' ? h.tabs : h.sounds), reason: 'Звук выключен администратором'})}));
vi.mock('../src/features/UserBlock/components/RoleSwitcher', () => ({RoleSwitcher: () => null}));
vi.mock('../src/core/hooks', () => ({useAppDispatch: () => h.dispatch}));
vi.mock('react-router-dom', () => ({useHistory: () => ({push: vi.fn()}), Link: ({to, children}: {to: string; children?: ReactNode}) => createElement('a', {href: to}, children)}));
vi.mock('antd', () => {
    type Box = {children?: ReactNode; title?: ReactNode; message?: ReactNode; description?: ReactNode};
    const content = ({children}: Box) => createElement('div', null, children);
    return {Card: ({title, children}: Box) => createElement('section', null, title, children), Space: content,
        Typography: {Text: content, Paragraph: content, Title: content}, Alert: ({message, description}: Box) => createElement('div', null, message, description),
        Button: ({children, disabled, loading, onClick, ...props}: Box & {disabled?: boolean; loading?: boolean; onClick?: () => void; 'aria-label'?: string}) => createElement('button', {disabled: disabled || loading, onClick, 'aria-label': props['aria-label']}, children),
        Switch: ({checked, disabled, onChange, ...props}: {checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; 'aria-label': string}) => createElement('button', {role: 'switch', 'aria-label': props['aria-label'], 'aria-checked': checked, disabled, onClick: () => onChange(!checked)}),
        Slider: ({value, disabled, onChange, ariaLabelForHandle}: {value: number; disabled?: boolean; onChange: (volume: number) => void; ariaLabelForHandle: string}) => {
            h.sliders.push(onChange); return createElement('input', {type: 'range', 'aria-label': ariaLabelForHandle, value, disabled, readOnly: true});
        },
        Dropdown: ({children, menu}: {children?: ReactNode; menu: {items: Array<{key: string; label: string; onClick: () => void}>}}) => createElement('div', null, children,
            menu.items.map(item => createElement('button', {key: item.key, onClick: item.onClick}, item.label))),
        Modal: ({open, title, children, onCancel}: Box & {open: boolean; onCancel: () => void}) => open ? createElement('section', {role: 'dialog', 'aria-label': String(title)}, children, createElement('button', {onClick: onCancel}, 'Закрыть настройки')) : null,
        message: {error: vi.fn()}};
});

const alice = (role = 'Разработчик'): IUserInfo => ({id: 'alice-ui', principalName: 'alice-ui', email: 'alice@example.test', displayName: 'Alice', activeRole: role,
    userRoles: ['Разработчик', 'Наблюдатель'], routePermissions: role === 'Наблюдатель' ? [] : ['settings'], projectRoles: []});
const initial = (): {userBlock: IUserBlockState} => ({userBlock: {isAuth: true, user: alice(), policies: {}, processing: false, error: '', authorizationUnconfirmed: false, request: null}});
const makeStore = () => configureStore({reducer: (state = initial(), action: {type: string; user?: IUserInfo}) => action.type === 'session'
    ? {userBlock: {...state.userBlock, user: action.user ?? null, isAuth: !!action.user}} : state});
type TestState = ReturnType<ReturnType<typeof makeStore>['getState']>;
function App({page}: {page: boolean}) {
    const {user, policies} = useSelector((state: TestState) => state.userBlock), scope = user ? authDataScope({user, policies}) : '';
    useLayoutEffect(() => {const release = tabNotifications.configure(scope, user?.email ?? '', h.tabs); tabNotifications.setHidden(true); return release;}, [scope, user?.email, h.tabs]);
    useNotificationSounds(!!user);
    return createElement(Fragment, null, createElement(UserInfo), page && createElement(Settings));
}
let root: Root, container: HTMLDivElement, store: ReturnType<typeof makeStore>, audio: ReturnType<typeof controlledChime>;
const render = async (page = false) => {h.sliders = []; await act(async () => {root.render(<Provider store={store}><StrictMode><App page={page}/></StrictMode></Provider>);});};
const button = (text: string, within: ParentNode = container): HTMLButtonElement => {
    const value = [...within.querySelectorAll('button')].find(node => node.textContent?.includes(text)); if (!value) throw Error('Missing button ' + text); return value;
};
const toggle = (within: ParentNode = container): HTMLButtonElement => within.querySelector('[role="switch"]')!;
const click = async (node: HTMLElement) => {await act(async () => {node.click();});};
const volume = async (value: number) => {await act(async () => {h.sliders[0](value);});};
const advance = async (ms: number) => {await act(async () => {await vi.advanceTimersByTimeAsync(ms);});};
const complete = async () => {await act(async () => {const {user, policies} = store.getState().userBlock; const scope = authDataScope({user: user!, policies});
    tabNotifications.expect(scope, tabModel, ['result']); tabNotifications.accept(scope, tabSnapshot(tabModel, [tabRow('result', 'terminal')], 2));});};
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
    notificationSounds.configure('', '', false, () => false); h.sounds = true; h.tabs = true; audio = controlledChime(); h.factory.mockReturnValue(audio.port);
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); store = makeStore();
});
afterEach(async () => {await act(async () => {root.unmount();}); notificationSounds.configure('', '', false, () => false); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('One personal sound form across Settings and the user menu', () => {
    it('shares volume and mute between both entrypoints; explicit Test does not silently enable sound', async () => {
        await render(true); expect(toggle().getAttribute('aria-checked')).toBe('false');
        await volume(25); await click(button('Проверить звук')); await advance(0); expect(audio.play).toHaveBeenCalledExactlyOnceWith(0.25); expect(toggle().getAttribute('aria-checked')).toBe('false');
        await click(toggle()); await click(button('Настройки уведомлений')); const dialog = container.querySelector('[role="dialog"]')!;
        expect(toggle(dialog).getAttribute('aria-checked')).toBe('true'); expect(dialog.querySelector('input')?.value).toBe('25');
        await click(toggle(dialog)); expect(toggle().getAttribute('aria-checked')).toBe('false'); expect(audio.stop).toHaveBeenCalled();
    });
    it('a demoted Observer without Settings route access can still open personal controls and mute a pending resume', async () => {
        await render(); await click(button('Настройки уведомлений')); await click(toggle());
        const deferred = tabDeferred<void>(); audio.setState('suspended'); audio.resume.mockReturnValueOnce(deferred.promise); await click(button('Проверить звук'));
        await act(async () => {store.dispatch({type: 'session', user: alice('Наблюдатель')});}); await render();
        expect(button('Настройки уведомлений')).toBeDefined(); expect(toggle().getAttribute('aria-checked')).toBe('true'); await click(toggle());
        audio.setState('running'); deferred.resolve(); await advance(2000); expect(audio.play).not.toHaveBeenCalled(); expect(notificationSounds.snapshot().enabled).toBe(false);
    });
    it('account changes reveal no previous preference and retained controls cannot write to either account', async () => {
        await render(); await click(button('Настройки уведомлений')); await click(toggle()); await volume(72); const stale = h.sliders[0];
        const bob = {...alice(), id: 'bob-ui', principalName: 'bob-ui', email: 'bob@example.test', displayName: 'Bob'};
        await act(async () => {store.dispatch({type: 'session', user: bob});}); await render();
        expect(toggle().getAttribute('aria-checked')).toBe('false'); expect(container.querySelector('input')?.value).toBe('50');
        await act(async () => {stale(1);}); expect(notificationSounds.snapshot()).toMatchObject({enabled: false, volume: 50});
        await act(async () => {store.dispatch({type: 'session', user: alice('Наблюдатель')});}); await render();
        expect(toggle().getAttribute('aria-checked')).toBe('true'); expect(container.querySelector('input')?.value).toBe('72');
    });
    it('Core keeps sound after the settings close and StrictMode creates only one delivery', async () => {
        await render(); await click(button('Настройки уведомлений')); await click(toggle()); await click(button('Закрыть настройки'));
        expect(container.querySelector('[role="dialog"]')).toBeNull(); await complete(); await advance(250); expect(audio.play).toHaveBeenCalledOnce();
        await advance(10000); expect(audio.play).toHaveBeenCalledOnce(); expect(tabNotifications.count()).toBe(1);
    });
    it('a blocked browser explains the Test gesture, and an explicit retry remains local and quiet by default', async () => {
        await render(); await click(button('Настройки уведомлений')); audio.setState('suspended'); audio.resume.mockRejectedValueOnce(Error('autoplay blocked'));
        await click(button('Проверить звук')); expect(container.textContent).toContain('Браузер пока не разрешил звук');
        const retry = controlledChime(); h.factory.mockReturnValueOnce(retry.port); await click(button('Проверить звук')); await advance(0);
        expect(retry.play).toHaveBeenCalledOnce(); expect(toggle().getAttribute('aria-checked')).toBe('false');
    });
    it('zero volume and feature OFF keep Test silent while a user can still mute their personal preference', async () => {
        await render(); await click(button('Настройки уведомлений')); await click(toggle()); await volume(0); expect(button('Проверить звук').disabled).toBe(true);
        await complete(); await advance(250); expect(audio.play).not.toHaveBeenCalled();
        await volume(50); h.sounds = false; await render(); expect(button('Проверить звук').disabled).toBe(true); expect(tabNotifications.count()).toBe(1);
        await click(toggle()); expect(notificationSounds.snapshot().enabled).toBe(false); expect(audio.play).not.toHaveBeenCalled();
    });
    it('logout synchronously stops active audio and removes the personal menu', async () => {
        await render(); await click(button('Настройки уведомлений')); await click(button('Проверить звук')); await advance(0); expect(audio.play).toHaveBeenCalledOnce();
        await act(async () => {store.dispatch({type: 'session'});}); expect(audio.stop).toHaveBeenCalled(); expect(container.querySelector('[role="dialog"]')).toBeNull();
        await advance(2000); expect(audio.play).toHaveBeenCalledTimes(1); expect(soundPrincipal(store.getState().userBlock.user)).toBe('');
    });
});
