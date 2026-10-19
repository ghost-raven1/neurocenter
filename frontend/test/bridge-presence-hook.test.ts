import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeApi, type IBridgeDevice } from '../src/features/McpBridge/api';
import socket from '../src/core/socket/socketClient';
import { useBridge } from '../src/features/McpBridge/useBridge';

const fixture = vi.hoisted(() => ({
    user: {
        id: 'user', email: 'bridge-presence@example.test', activeRole: 'Разработчик',
        userRoles: ['Разработчик'], routePermissions: [], projectRoles: [],
    },
    policies: {},
}));

/** Минимальный цикл хуков: настоящий useBridge, управляемые ответы API и часы. */
const hooks = vi.hoisted(() => {
    let cursor = 0;
    let updates = 0;
    const slots: Array<{ value?: unknown; dependencies?: unknown[]; cleanup?: () => void }> = [];
    const effects: Array<() => void> = [];
    const unchanged = (previous: unknown[] | undefined, next: unknown[] | undefined) =>
        Boolean(previous && next && previous.length === next.length && next.every((value, index) => Object.is(value, previous[index])));
    return {
        begin: () => { cursor = 0; },
        updates: () => updates,
        commit: () => { effects.splice(0).forEach(effect => effect()); },
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T | (() => T)) {
            const slot = slots[cursor++] ??= {value: typeof initial === 'function' ? (initial as () => T)() : initial};
            return [slot.value, (next: T | ((previous: T) => T)) => {
                const value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next;
                if (!Object.is(value, slot.value)) { updates++; }
                slot.value = value;
            }];
        },
        useRef<T>(initial: T) { return (slots[cursor++] ??= {value: {current: initial}}).value; },
        useCallback<T>(callback: T, dependencies: unknown[]) {
            const index = cursor++;
            const previous = slots[index];
            if (previous && unchanged(previous.dependencies, dependencies)) { return previous.value; }
            slots[index] = {value: callback, dependencies};
            return callback;
        },
        useEffect(effect: () => void | (() => void), dependencies?: unknown[]) {
            const index = cursor++;
            const previous = slots[index];
            if (previous && unchanged(previous.dependencies, dependencies)) { return; }
            const slot = slots[index] = {dependencies};
            effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});

vi.mock('react', () => ({
    useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useCallback: hooks.useCallback,
}));
vi.mock('react-redux', () => ({
    useSelector: (selector: (state: unknown) => unknown) => selector({userBlock: {user: fixture.user, policies: fixture.policies}}),
}));
vi.mock('../src/features/McpBridge/api', () => ({bridgeApi: {devices: vi.fn(), jobs: vi.fn(), installations: vi.fn()}}));
vi.mock('../src/core/socket/socketClient', () => ({default: {connect: vi.fn(), on: vi.fn(), off: vi.fn()}}));

const device: IBridgeDevice = {
    id: 'computer', name: 'Рабочий компьютер', fingerprint: 'test', role: 'Разработчик', online: true,
    lastSeen: '2099-01-01T00:00:00.000Z', report: {platform: 'darwin', bridgeVersion: '0.9.4'},
};
const expiredMessage = 'Статус подключения устарел. Проверьте подключение снова.';
let browser: EventTarget;
let documentEvents: EventTarget & {visibilityState: string};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return {promise, resolve};
}

function render() {
    hooks.begin();
    const bridge = useBridge();
    hooks.commit();
    return bridge;
}

async function settle() {
    for (let index = 0; index < 10; index++) { await Promise.resolve(); }
    render();
    return render();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00.000Z'));
    vi.clearAllMocks();
    fixture.user.activeRole = 'Разработчик';
    browser = new EventTarget();
    documentEvents = Object.assign(new EventTarget(), {visibilityState: 'visible'});
    vi.stubGlobal('window', browser);
    vi.stubGlobal('document', documentEvents);
    vi.stubGlobal('localStorage', {getItem: vi.fn(() => null), setItem: vi.fn()});
    vi.mocked(bridgeApi.devices).mockResolvedValue([device]);
    vi.mocked(bridgeApi.jobs).mockResolvedValue([]);
    vi.mocked(bridgeApi.installations).mockResolvedValue([]);
});

afterEach(() => {
    hooks.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('Свежесть присутствия моста в открытом интерфейсе', () => {
    it('Снимает «на связи» через 30 секунд и сохраняет данные компьютера даже при будущих серверных часах', async () => {
        render();
        expect((await settle()).device).toEqual(device);
        documentEvents.visibilityState = 'hidden';
        await vi.advanceTimersByTimeAsync(29_999);
        expect(render()).toMatchObject({devicesReady: true, device: {online: true}});
        const beforeExpiry = hooks.updates();
        await vi.advanceTimersByTimeAsync(1);
        expect(hooks.updates()).toBeGreaterThan(beforeExpiry);
        expect(render()).toMatchObject({devicesReady: false, device: {...device, online: false}, errors: {devices: expiredMessage}});
        expect(render().devices).toEqual([{...device, online: false}]);
    });

    it('Считает свежесть от полученного ответа, а не от начала запроса или lastSeen', async () => {
        const response = deferred<IBridgeDevice[]>();
        vi.mocked(bridgeApi.devices).mockReturnValue(response.promise);
        documentEvents.visibilityState = 'hidden';
        render();
        await vi.advanceTimersByTimeAsync(45_000);
        response.resolve([{...device, lastSeen: '2000-01-01T00:00:00.000Z'}]);
        expect(await settle()).toMatchObject({devicesReady: true, device: {online: true}});
        await vi.advanceTimersByTimeAsync(29_999);
        expect(render().devicesReady).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(render()).toMatchObject({devicesReady: false, device: {online: false}});
    });

    it('После ошибки списка сохраняет имя и отчёт, но не выдаёт прошлое online за текущий статус', async () => {
        render();
        const bridge = await settle();
        vi.mocked(bridgeApi.devices).mockRejectedValueOnce(new Error('Сеть недоступна'));
        await bridge.reload();
        expect(render()).toMatchObject({devicesReady: false, device: {...device, online: false}});
        expect(render().errors.devices).toContain('Не удалось загрузить список компьютеров');
        expect(render().devices).toEqual([{...device, online: false}]);
    });

    it('Ошибки очереди и установок не скрывают успешно проверенный online компьютера', async () => {
        vi.mocked(bridgeApi.jobs).mockRejectedValue(new Error('Очередь недоступна'));
        vi.mocked(bridgeApi.installations).mockRejectedValue(new Error('Установки недоступны'));
        render();
        const bridge = await settle();
        expect(bridge).toMatchObject({devicesReady: true, device: {online: true}, errors: {devices: ''}});
        expect(bridge.errors.jobs).toBeTruthy();
        expect(bridge.errors.installations).toBeTruthy();
    });

    it('Возврат фокуса сразу запрашивает актуальный статус без ожидания периодического таймера', async () => {
        render();
        await settle();
        vi.mocked(bridgeApi.devices).mockClear();
        browser.dispatchEvent(new Event('focus'));
        expect(bridgeApi.devices).toHaveBeenCalledOnce();
        await settle();
    });

    it('Возврат видимой вкладки обновляет статус сразу, скрытие вкладки не создаёт запрос', async () => {
        render();
        await settle();
        vi.mocked(bridgeApi.devices).mockClear();
        documentEvents.visibilityState = 'hidden';
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        browser.dispatchEvent(new Event('focus'));
        expect(bridgeApi.devices).not.toHaveBeenCalled();
        documentEvents.visibilityState = 'visible';
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        expect(bridgeApi.devices).toHaveBeenCalledOnce();
        await settle();
    });

    it('Успешная повторная проверка возвращает online после устаревания и очищает причину', async () => {
        render();
        await settle();
        documentEvents.visibilityState = 'hidden';
        await vi.advanceTimersByTimeAsync(30_000);
        expect(render().devicesReady).toBe(false);
        await render().reload();
        expect(await settle()).toMatchObject({devicesReady: true, device: {online: true}, errors: {devices: ''}});
    });

    it('При смене прав не показывает прежний online и игнорирует поздний ответ старого запроса', async () => {
        const oldResponse = deferred<IBridgeDevice[]>();
        const currentResponse = deferred<IBridgeDevice[]>();
        vi.mocked(bridgeApi.devices).mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise);
        render();
        fixture.user.activeRole = 'Наблюдатель';
        expect(render()).toMatchObject({devicesReady: false, devices: [], device: undefined});
        oldResponse.resolve([device]);
        expect(await settle()).toMatchObject({devicesReady: false, devices: [], device: undefined});
        currentResponse.resolve([{...device, role: 'Наблюдатель', online: false}]);
        expect(await settle()).toMatchObject({devicesReady: true, device: {role: 'Наблюдатель', online: false}});
    });

    it('Размонтирование удаляет таймеры и подписки: focus, видимость и сокет больше не запрашивают API', async () => {
        const windowRemove = vi.spyOn(browser, 'removeEventListener');
        const documentRemove = vi.spyOn(documentEvents, 'removeEventListener');
        render();
        await settle();
        const listenerPairs = vi.mocked(socket.on).mock.calls;
        hooks.dispose();
        vi.mocked(bridgeApi.devices).mockClear();
        browser.dispatchEvent(new Event('focus'));
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bridgeApi.devices).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(windowRemove).toHaveBeenCalledWith('focus', expect.any(Function));
        expect(documentRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        for (const [event, handler] of listenerPairs) { expect(socket.off).toHaveBeenCalledWith(event, handler); }
    });
});
