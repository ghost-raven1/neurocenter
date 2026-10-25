// @vitest-environment jsdom
import {act, createElement, StrictMode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useTabNotifications} from '../src/features/TabNotifications/useTabNotifications';
import {useTabWatch} from '../src/features/TabNotifications/useTabWatch';
import {tabNotifications} from '../src/features/TabNotifications/tracker';
import {readTabSnapshot} from '../src/features/TabNotifications/read';
import {tabDeferred, tabModel, tabService, tabRow, tabSnapshot} from './tab-notification-fixtures';
import type {TabSnapshot} from '../src/features/TabNotifications/types';
import api from '../src/core/api/base';

const h = vi.hoisted(() => {
    const state = {scope: 'alice', owner: {}, enabled: true, capture: () => {const owner = state.owner; return () => owner === state.owner;}};
    return state;
});
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.scope, captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: h.enabled})}));
vi.mock('../src/features/TabNotifications/read', () => ({readTabSnapshot: vi.fn()}));
vi.mock('../src/core/api/base', () => ({default: {post: vi.fn()}}));
const pending = tabSnapshot(tabModel, [tabRow('request')]);
const complete = tabSnapshot(tabModel, [tabRow('request', 'terminal')], 2);
function Monitor() {useTabNotifications(true, 'alice@example.test'); return null;}
function OpenChat() {useTabWatch(h.scope, [pending]); return createElement('div', null, 'Открытый чат');}
function App({chat}: {chat: boolean}) {return createElement(StrictMode, null, createElement(Monitor), chat && createElement(OpenChat));}
let root: Root, container: HTMLDivElement, head: string;
const render = async (chat = false) => {await act(async () => {root.render(createElement(App, {chat}));});};
const advance = async (ms = 4000) => {await act(async () => {await vi.advanceTimersByTimeAsync(ms);});};
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    h.scope = 'alice'; h.owner = {}; h.enabled = true;
    head = document.head.innerHTML; document.head.innerHTML = '<title>Нейроцентр</title><link rel="icon" href="/brand.svg?v=one">';
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.mocked(readTabSnapshot).mockResolvedValue(complete);
});
afterEach(async () => {
    await act(async () => {root.unmount();}); container.remove(); document.head.innerHTML = head;
    Reflect.deleteProperty(document, 'visibilityState'); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('A Core-owned reader outlives the chat window', () => {
    it('confirms completion after the chat closes while hidden, then stops polling a settled personal turn', async () => {
        await render(true); await render(false); expect(readTabSnapshot).not.toHaveBeenCalled();
        await advance(); expect(document.title).toBe('(1) Нейроцентр');
        expect(readTabSnapshot).toHaveBeenCalledExactlyOnceWith(tabModel, expect.any(AbortSignal), ['request']);
        await advance(20000); expect(readTabSnapshot).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
        document.dispatchEvent(new Event('visibilitychange')); expect(document.title).toBe('(1) Нейроцентр');
        await render(true); expect(document.title).toBe('Нейроцентр');
    });
    it('captures a fast completion on the first GET of an explicit pending receipt without another send', async () => {
        await render(); tabNotifications.expect(h.scope, tabModel, ['request']); await advance();
        expect(document.title).toBe('(1) Нейроцентр'); expect(readTabSnapshot).toHaveBeenCalledTimes(1);
    });
    it('offline and unknown results do not produce completion; one later authoritative read can recover', async () => {
        vi.mocked(readTabSnapshot).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(complete);
        await render(true); await render(false); await advance(); expect(document.title).toBe('Нейроцентр');
        await advance(12000); expect(readTabSnapshot).toHaveBeenCalledTimes(1); await advance(4000);
        expect(readTabSnapshot).toHaveBeenCalledTimes(2); expect(document.title).toBe('(1) Нейроцентр');
    });
    it('bounds one stalled GET so another subsystem is checked without overlapping live transports', async () => {
        let active = 0, maximum = 0, first = true;
        const aborted = vi.fn();
        vi.mocked(readTabSnapshot).mockImplementation((source, signal) => {
            active++; maximum = Math.max(maximum, active);
            if (source.kind === 'model' && first) {
                first = false;
                return new Promise<TabSnapshot>((_resolve, reject) => signal.addEventListener('abort', () => {
                    active--; aborted(); reject(new DOMException('Read aborted', 'AbortError'));
                }, {once: true}));
            }
            active--;
            return Promise.resolve(source.kind === 'service' ? tabSnapshot(tabService, [tabRow('role-request', 'terminal')], 2) : pending);
        });
        await render(); tabNotifications.expect(h.scope, tabModel, ['request']); tabNotifications.expect(h.scope, tabService, ['role-request']);
        await advance(30000);
        expect(aborted).toHaveBeenCalledOnce(); expect(maximum).toBe(1);
        expect(vi.mocked(readTabSnapshot).mock.calls.some(([source]) => source.kind === 'service')).toBe(true);
        expect(api.post).not.toHaveBeenCalled();
        expect(document.title).toBe('(1) Нейроцентр');
    });
    it.each([401, 403, 404])('a %s read removes only that watch rather than creating an error notification', async status => {
        vi.mocked(readTabSnapshot).mockRejectedValueOnce({response: {status}}); await render(true); await render(false); await advance();
        expect(document.title).toBe('Нейроцентр'); await advance(30000); expect(readTabSnapshot).toHaveBeenCalledTimes(1);
    });
    it('aborts the previous account GET and ignores its late answer after a role/account change', async () => {
        const late = tabDeferred<TabSnapshot>(); vi.mocked(readTabSnapshot).mockReturnValueOnce(late.promise);
        await render(true); await render(false); await advance(); const signal = vi.mocked(readTabSnapshot).mock.calls[0][1];
        h.scope = 'bob'; h.owner = {}; await render(); expect(signal.aborted).toBe(true);
        await act(async () => {late.resolve(complete); await Promise.resolve();}); expect(document.title).toBe('Нейроцентр');
        await advance(12000); expect(readTabSnapshot).toHaveBeenCalledTimes(1);
    });
    it('a forgotten private watch cannot be recreated by an already authorized late GET', async () => {
        const late = tabDeferred<TabSnapshot>(); vi.mocked(readTabSnapshot).mockReturnValueOnce(late.promise);
        await render(true); await render(false); await advance(); tabNotifications.forget(h.scope, tabModel);
        await act(async () => {late.resolve(complete); await Promise.resolve();}); expect(document.title).toBe('Нейроцентр');
        await advance(12000); expect(readTabSnapshot).toHaveBeenCalledTimes(1);
    });
    it('OFF restores the original document, aborts an in-flight read and leaves no duplicate StrictMode poller', async () => {
        const late = tabDeferred<TabSnapshot>(); vi.mocked(readTabSnapshot).mockReturnValueOnce(late.promise);
        await render(true); await render(false); await advance(); const signal = vi.mocked(readTabSnapshot).mock.calls[0][1];
        h.enabled = false; await render(); expect(signal.aborted).toBe(true);
        await act(async () => {late.resolve(complete); await Promise.resolve();});
        expect(document.title).toBe('Нейроцентр'); expect(document.querySelector('link')!.getAttribute('href')).toBe('/brand.svg?v=one');
        await advance(20000); expect(readTabSnapshot).toHaveBeenCalledTimes(1);
    });
});
