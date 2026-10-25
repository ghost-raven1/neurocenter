// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AppNavigation} from '../src/features/AppNavigation/AppNavigation';
import {navigationEntries} from '../src/features/AppNavigation/model';
import AccessibleDrawer from '../src/common/components/AccessibleDrawer';

const structure = ['start', 'store', 'assets', 'projects', 'rag', 'maintenance', 'audit', 'model-usage', 'access', 'settings', 'help']
    .map(name => ({name, route: '/' + name, title: name}));
const entries = navigationEntries(structure, structure.map(item => item.name));
const mounted: Array<{root: Root; container: HTMLElement}> = [];
const nativeComputedStyle = window.getComputedStyle.bind(window);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
beforeEach(() => {
    vi.stubGlobal('matchMedia', (media: string) => ({matches: false, media, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    // jsdom has no pseudo-element styles; the real drawer only needs the ordinary scrollbar measurement.
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => nativeComputedStyle(element));
});
afterEach(async () => {for (const {root, container} of mounted.splice(0)) {await act(async () => root.unmount()); container.remove();} vi.restoreAllMocks();});
async function mount(pathname = '/projects/example', active = true, authorized = entries) {
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container); mounted.push({root, container});
    const onNavigate = vi.fn(), onClose = vi.fn();
    const render = async (path = pathname, visible = active, permitted = authorized) => {await act(async () => {
        root.render(<AppNavigation entries={permitted} pathname={path} active={visible} onNavigate={onNavigate} onClose={onClose}/>);
    });};
    await render(); return {container, root, render, onNavigate, onClose};
}
const title = (container: HTMLElement, text: string): HTMLElement => [...container.querySelectorAll<HTMLElement>('.ant-menu-submenu-title')].find(node => node.textContent === text)!;
const item = (container: HTMLElement, text: string): HTMLElement => [...container.querySelectorAll<HTMLElement>('.ant-menu-item')].find(node => node.textContent === text)!;
const expanded = (container: HTMLElement): string[] => [...container.querySelectorAll<HTMLElement>('.ant-menu-submenu-title[aria-expanded="true"]')].map(node => node.textContent!);

describe('Real Ant Design navigation', () => {
    it('Opens the current section and selects the original route without expanding the entire menu', async () => {
        const {container} = await mount();
        expect(expanded(container)).toEqual(['Работа']);
        expect(container.querySelector('.ant-menu-item-selected')?.textContent).toBe('Проекты');
        expect(container.querySelectorAll('.ant-menu-root > .ant-menu-submenu')).toHaveLength(4);
        expect(container.querySelectorAll('.ant-menu-root > .ant-menu-item')).toHaveLength(1);
    });
    it('Opens one group without navigation, then selects a route and closes mobile navigation', async () => {
        const {container, onNavigate, onClose} = await mount();
        await act(async () => title(container, 'Ресурсы').click());
        expect(expanded(container)).toEqual(['Ресурсы']); expect(onNavigate).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
        await act(async () => item(container, 'Каталог').click());
        expect(onNavigate).toHaveBeenCalledExactlyOnceWith('/store'); expect(onClose).toHaveBeenCalledOnce();
    });
    it('Reopens the selected group for a deep link and when the mobile drawer opens again', async () => {
        const {container, render} = await mount();
        await act(async () => title(container, 'Ресурсы').click());
        await render('/settings'); expect(expanded(container)).toEqual(['Управление']);
        expect(container.querySelector('.ant-menu-item-selected')?.textContent).toBe('Настройки');
        await act(async () => title(container, 'Управление').click()); expect(expanded(container)).toEqual([]);
        await render('/settings', false); await render('/settings', true);
        expect(expanded(container)).toEqual(['Управление']);
    });
    it('Removes empty groups when permissions change without exposing their routes', async () => {
        const {container, render} = await mount();
        await render('/projects/example', true, navigationEntries(structure, ['store']));
        expect([...container.querySelectorAll('.ant-menu-root > .ant-menu-submenu > .ant-menu-submenu-title')].map(node => node.textContent)).toEqual(['Ресурсы', 'Справка']);
        expect(container.querySelector('.ant-menu-item-selected')).toBeNull();
        expect(container.textContent).not.toContain('Настройки'); expect(container.textContent).not.toContain('Проекты');
    });
    it('Keeps Swagger a native separate-tab link and does not send it to the router', async () => {
        const {container, onNavigate, onClose} = await mount('/help');
        const link = container.querySelector<HTMLAnchorElement>('a[href="/api/docs"]')!;
        expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener noreferrer');
        await act(async () => link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, ctrlKey: true})));
        expect(onNavigate).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
    });
    it('Expands a group with the keyboard without closing the menu or navigating', async () => {
        const {container, onNavigate, onClose} = await mount();
        const resources = title(container, 'Ресурсы'); resources.focus();
        await act(async () => resources.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, which: 13, bubbles: true})));
        expect(expanded(container)).toEqual(['Ресурсы']); expect(onNavigate).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    });
    it('Retains the real mobile drawer Escape and trigger-focus path', async () => {
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container); mounted.push({root, container});
        function Mobile() {
            const [open, setOpen] = useState(false);
            return <><button onClick={() => setOpen(true)}>Открыть меню</button><AccessibleDrawer title="Нейроцентр" placement="left" open={open} onClose={() => setOpen(false)}>
                <AppNavigation entries={entries} pathname="/projects/example" active={open} onNavigate={() => undefined} onClose={() => setOpen(false)}/>
            </AccessibleDrawer></>;
        }
        await act(async () => root.render(<Mobile/>)); const trigger = container.querySelector('button')!; trigger.focus();
        await act(async () => trigger.click());
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
        await act(async () => {dialog.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, which: 27, bubbles: true})); await new Promise(resolve => setTimeout(resolve, 400));});
        expect(document.querySelector('.ant-drawer-open')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });
});
