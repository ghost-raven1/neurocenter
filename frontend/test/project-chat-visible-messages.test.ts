import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {observeVisibleMessages} from '../src/features/ProjectChat/observeVisibleMessages';

let focused: boolean, visibility: string, hit: unknown;
let callback: IntersectionObserverCallback, stop: (() => void) | undefined;
const rect = (top: number, bottom: number) => ({top, bottom, left: 0, right: 300, width: 300, height: bottom - top});
const article = (id: string, top = 0, bottom = 120) => Object.assign(new EventTarget(), {dataset: {chatMessageId: id}, getBoundingClientRect: () => rect(top, bottom), contains: (node: unknown) => node === hit && hit === id});
let viewport: HTMLElement, visible: ReturnType<typeof vi.fn>, one: ReturnType<typeof article>, two: ReturnType<typeof article>;
beforeEach(() => {
    vi.useFakeTimers(); focused = true; visibility = 'visible'; hit = 'one'; visible = vi.fn(); one = article('one'); two = article('two', 400, 520);
    vi.stubGlobal('window', Object.assign(new EventTarget(), {innerWidth: 600, innerHeight: 300}));
    vi.stubGlobal('document', Object.defineProperty(Object.assign(new EventTarget(), {hasFocus: () => focused, elementFromPoint: () => hit}), 'visibilityState', {get: () => visibility}));
    vi.stubGlobal('IntersectionObserver', class {constructor(value: IntersectionObserverCallback) {callback = value;} observe = vi.fn(); disconnect = vi.fn();});
    viewport = Object.assign(new EventTarget(), {getBoundingClientRect: () => rect(0, 250), querySelectorAll: () => [one, two]}) as unknown as HTMLElement;
});
afterEach(() => {stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals();});
const intersect = (...nodes: ReturnType<typeof article>[]) => callback(nodes.map(target => ({target, isIntersecting: true})) as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);

describe('Просмотр требует фактической видимости сообщения', () => {
    it('Подключение истории само ничего не отмечает, пересечение отмечает только видимый article', () => {
        stop = observeVisibleMessages(viewport, visible); expect(visible).not.toHaveBeenCalled(); intersect(one, two); expect(visible.mock.calls.at(-1)![0]).toEqual(['one']);
    });
    it('Скрытая вкладка, другое окно и перекрывающая модалка не создают просмотр; закрытие восстанавливает его', async () => {
        focused = false; stop = observeVisibleMessages(viewport, visible); intersect(one); expect(visible.mock.calls.at(-1)![0]).toEqual([]);
        focused = true; visibility = 'hidden'; window.dispatchEvent(new Event('focus')); expect(visible.mock.calls.at(-1)![0]).toEqual([]);
        visibility = 'visible'; hit = 'modal'; document.dispatchEvent(new Event('visibilitychange')); expect(visible.mock.calls.at(-1)![0]).toEqual([]);
        hit = 'one'; await vi.advanceTimersByTimeAsync(750); expect(visible.mock.calls.at(-1)![0]).toEqual(['one']);
    });
    it('Unmount removes observers and rechecks', async () => {
        stop = observeVisibleMessages(viewport, visible); intersect(one); visible.mockClear(); stop(); stop = undefined;
        await vi.advanceTimersByTimeAsync(1500); window.dispatchEvent(new Event('focus')); expect(visible).not.toHaveBeenCalled();
    });
});
