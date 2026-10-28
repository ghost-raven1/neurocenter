// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {UserInfo} from '../src/features/UserBlock/components/UserInfo';

const h = vi.hoisted(() => ({dispatch: vi.fn(), user: {
    displayName: 'QA User', email: 'qa@example.test', activeRole: 'Наблюдатель', userRoles: ['Наблюдатель'],
}}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: h.user}})}));
vi.mock('react-router-dom', () => ({useHistory: () => ({push: vi.fn()})}));
vi.mock('../src/core/hooks', () => ({useAppDispatch: () => h.dispatch}));
vi.mock('../src/features/UserBlock/redux/actions', () => ({authLogout: vi.fn(), authSwitchRole: vi.fn()}));
vi.mock('../src/features/NotificationSounds/NotificationSoundSettings', () => ({
    NotificationSoundSettings: () => createElement('button', null, 'Проверить звук'),
}));

let root: Root, container: HTMLDivElement;
const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Меню пользователя"]')!;
const popup = () => document.querySelector<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden) [role="menu"]');
const key = async (target: HTMLElement, value: string, code: number) => {
    await act(async () => {target.dispatchEvent(new KeyboardEvent('keydown', {key: value, keyCode: code, which: code, bubbles: true}));});
};
const settleFrames = async () => {await act(async () => {await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));});};
const click = async (target: HTMLElement) => {await act(async () => {target.click();});};
async function openMenu() {
    // jsdom does not synthesize the browser's click default for an Enter key on a button.
    trigger().focus(); await key(trigger(), 'Enter', 13); await click(trigger());
    await vi.waitFor(() => expect(popup()).not.toBeNull());
}
beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}}));
    // jsdom has no layout; real AntD skips all keyboard targets unless their platform visibility is supplied.
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
        return this.closest('.ant-dropdown-hidden') ? null : this.parentElement;
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => {root.render(createElement('div', null, createElement(UserInfo), createElement('button', {id: 'outside'}, 'Другая кнопка')));});
});
afterEach(async () => {await act(async () => {root.unmount();}); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

it('announces the real menu popup state on its keyboard trigger', async () => {
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await openMenu(); expect(trigger().getAttribute('aria-expanded')).toBe('true');
    await key(popup()!, 'Escape', 27);
    await vi.waitFor(() => expect(popup()).toBeNull());
    await settleFrames();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
});

it('Escape from the actual AntD menu closes it and returns focus to its trigger', async () => {
    await openMenu(); popup()!.focus(); expect(document.activeElement).toBe(popup());
    await key(popup()!, 'Escape', 27);
    await vi.waitFor(() => expect(popup()).toBeNull());
    await settleFrames();
    expect(document.activeElement).toBe(trigger());
});

it('an outside click keeps focus on its target rather than moving it back to the trigger', async () => {
    await openMenu(); popup()!.focus(); const outside = container.querySelector<HTMLButtonElement>('#outside')!;
    await act(async () => {outside.focus(); outside.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); outside.click();});
    await vi.waitFor(() => expect(popup()).toBeNull()); expect(document.activeElement).toBe(outside);
});

it('opening notification settings closes the menu without stealing the modal focus', async () => {
    await openMenu();
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(node => node.textContent?.includes('Настройки уведомлений'))!;
    await click(item);
    await vi.waitFor(() => expect(popup()).toBeNull());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull(); await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(trigger());
});
