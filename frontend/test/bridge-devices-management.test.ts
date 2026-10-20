import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice } from '../src/features/McpBridge/api';
import { bridgeApi } from '../src/features/McpBridge/api';
import { BridgeDevicesManager } from '../src/features/McpBridge/BridgeDevicesManager';
import { bridgeDeviceStatus } from '../src/features/McpBridge/bridgeDevicePresentation';
import { BridgeConnection } from '../src/features/McpBridge/BridgeConnection';
import type { useBridge } from '../src/features/McpBridge/useBridge';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const states: Array<{ value: unknown }> = [];
    return {
        begin: () => { cursor = 0; }, reset: () => { states.length = 0; cursor = 0; },
        useState<T>(initial: T) {
            const index = cursor++;
            const state = states[index] ??= { value: initial };
            return [state.value, (value: T | ((previous: T) => T)) => { state.value = typeof value === 'function' ? (value as (previous: T) => T)(state.value as T) : value; }];
        },
        useRef<T>(initial: T) { return (states[cursor++] ??= { value: { current: initial } }).value; },
    };
});
const controls = vi.hoisted(() => ({
    buttons: new Map<string, { disabled?: boolean; loading?: boolean; onClick?: () => void }>(),
    confirmations: [] as Array<{ children: ReactNode; onOk: () => Promise<void> }>,
    menus: new Map<string, { disabled?: boolean; onClick: () => void }>(),
    owner: 'owner-a', generation: 0,
    closeManager: undefined as (() => void) | undefined,
    select: undefined as { value?: string; options: Array<{ value: string }>; onChange: (id: string) => void } | undefined,
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: hooks.useState, useRef: hooks.useRef }));
vi.mock('../src/features/McpBridge/api', () => ({ bridgeApi: { revoke: vi.fn() } }));
vi.mock('../src/features/McpBridge/PairingCode', () => ({ PairingCode: () => null }));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: vi.fn(), location: { pathname: '/projects' } }) }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: controls.owner, captureOwner: () => {
    const generation = controls.generation;
    return () => generation === controls.generation;
} }) }));
vi.mock('antd', async () => {
    const { createElement: h } = await import('react');
    const content = ({ children }: { children?: ReactNode }) => h('div', null, children);
    return {
        Space: content, Tag: content, Spin: content, Typography: { Paragraph: content, Text: content },
        Skeleton: () => h('div', { role: 'progressbar' }),
        Modal: (props: { open: boolean; title: ReactNode; children: ReactNode; footer?: ReactNode; onCancel: () => void; onOk: () => Promise<void> }) => {
            if (props.title === 'Отозвать доступ компьютера?' && props.open) { controls.confirmations.push(props); }
            if (props.title !== 'Отозвать доступ компьютера?') { controls.closeManager = props.onCancel; }
            return props.open ? h('section', null, props.title, props.children, props.footer) : null;
        },
        Select: (props: NonNullable<typeof controls.select>) => { controls.select = props; return null; },
        Alert: ({ message }: { message: ReactNode }) => h('div', { role: 'alert' }, message),
        Collapse: Object.assign(content, { Panel: content }),
        Dropdown: ({ menu, children }: { menu: { items: Array<{ disabled?: boolean; onClick: () => void }> }; children: ReactElement<{ 'aria-label': string }> }) => {
            controls.menus.set(children.props['aria-label'], menu.items[0]); return children;
        },
        Button: (props: { children: ReactNode; disabled?: boolean; loading?: boolean; onClick?: () => void; 'aria-label'?: string }) => {
            controls.buttons.set(props['aria-label'] || (Array.isArray(props.children) ? props.children.join('') : String(props.children)), props);
            return h('button', { disabled: props.disabled }, props.children);
        },
    };
});

const first: IBridgeDevice = { id: 'first', name: 'Рабочий компьютер', fingerprint: 'first', role: 'Разработчик', online: true,
    lastSeen: '2026-10-20T10:00:00.000Z', report: { root: '/projects', bridgeVersion: '0.9.4' } };
const second: IBridgeDevice = { ...first, id: 'second', name: 'Старый компьютер', online: false };
const onChoose = vi.fn(), onRevoked = vi.fn(), onReload = vi.fn(), onConnect = vi.fn();
let verified = true;
let open = true;
let devices = [first, second];
let loading = false;
function render() {
    hooks.begin(); controls.buttons.clear(); controls.confirmations = []; controls.menus.clear();
    return renderToStaticMarkup(createElement(BridgeDevicesManager, { open, devices, selectedId: first.id,
        verified, loading, onChoose, onRevoked, onReload, onConnect, onClose: vi.fn() }));
}

beforeEach(() => {
    hooks.reset(); vi.clearAllMocks(); verified = true; open = true; devices = [first, second]; loading = false; controls.owner = 'owner-a'; controls.generation = 0;
    vi.mocked(bridgeApi.revoke).mockResolvedValue(undefined); onRevoked.mockResolvedValue(undefined);
});

function deferred() {
    let resolve!: () => void, reject!: (cause: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function connectionFixture(): ReturnType<typeof useBridge> {
    const third = { ...first, id: 'third', name: 'Третий компьютер' };
    const bridge: ReturnType<typeof useBridge> = { device: first, devices: [first, second, third], devicesReady: true,
        jobsReady: true, installationsReady: true, jobs: [], installations: [], error: '', errors: { devices: '', jobs: '', installations: '' },
        loading: false, reload: vi.fn(async () => undefined), choose: vi.fn() };
    vi.mocked(bridge.choose).mockImplementation(id => { bridge.device = bridge.devices.find(item => item.id === id); });
    return bridge;
}
function renderConnection(bridge: ReturnType<typeof useBridge>) {
    hooks.begin(); controls.buttons.clear(); controls.confirmations = []; controls.menus.clear();
    return renderToStaticMarkup(createElement(BridgeConnection, { bridge, compact: true }));
}
function showComputers(bridge: ReturnType<typeof useBridge>) {
    renderConnection(bridge); controls.buttons.get(`Мои компьютеры (${bridge.devices.length})`)?.onClick?.(); renderConnection(bridge);
}
function requestRevoke(name: string, rerender = render) {
    const item = controls.menus.get(`Действия с компьютером ${name}`)!;
    expect(item).toBeDefined(); expect(item.disabled).toBe(false);
    item.onClick(); rerender();
    expect(controls.confirmations).toHaveLength(1);
    return controls.confirmations[0];
}

describe('Управление подключёнными компьютерами', () => {
    it('Выбирает конкретный компьютер из полного списка, сохраняя различимые статусы', () => {
        const html = render();
        expect(html).toContain('Рабочий компьютер'); expect(html).toContain('Старый компьютер');
        expect(html).toContain('На связи'); expect(html).toContain('Не в сети');
        expect(controls.buttons.has('Выбрать компьютер Рабочий компьютер')).toBe(false);
        expect(html).toContain('Выбран');
        controls.buttons.get('Выбрать компьютер Старый компьютер')?.onClick?.();
        expect(onChoose).toHaveBeenCalledExactlyOnceWith('second');
    });

    it('Отзыв выполняется только после подтверждения и адресует выбранное подключение', async () => {
        render();
        expect(bridgeApi.revoke).not.toHaveBeenCalled();
        const confirmation = requestRevoke(second.name);
        const explanation = renderToStaticMarkup(createElement('div', null, confirmation.children));
        expect(explanation).toContain('Старый компьютер'); expect(explanation).toContain('ожидающие задания будут отменены');
        expect(explanation).toContain('Локальные файлы и история сохранятся');
        await confirmation.onOk();
        expect(bridgeApi.revoke).toHaveBeenCalledExactlyOnceWith('second');
        expect(onRevoked).toHaveBeenCalledExactlyOnceWith('second');
    });

    it('Ошибка отзыва сохраняет подключение и объясняет отказ', async () => {
        vi.mocked(bridgeApi.revoke).mockRejectedValue(new Error('Сервер недоступен'));
        render(); await requestRevoke(first.name).onOk();
        expect(onRevoked).not.toHaveBeenCalled();
        const html = render();
        expect(html).toContain('Сервер недоступен'); expect(html).toContain('Рабочий компьютер');
    });

    it('Повторное подтверждение во время запроса не отправляет второй отзыв', async () => {
        const pending = deferred(); vi.mocked(bridgeApi.revoke).mockReturnValue(pending.promise);
        render(); const confirmation = requestRevoke(first.name);
        const revoking = confirmation.onOk();
        const repeated = confirmation.onOk();
        expect(bridgeApi.revoke).toHaveBeenCalledOnce();
        pending.resolve(); await Promise.all([revoking, repeated]);
        expect(onRevoked).toHaveBeenCalledOnce();
    });

    it('Подтверждение показывает папку компьютера с неоднозначным именем', () => {
        render(); const confirmation = requestRevoke(second.name);
        const html = renderToStaticMarkup(createElement('div', null, confirmation.children));
        expect(html).toContain('/projects');
    });

    it('Закрытие и повторное открытие сохраняет занятость текущего отзыва', async () => {
        const pending = deferred(); vi.mocked(bridgeApi.revoke).mockReturnValue(pending.promise);
        render(); const revoking = requestRevoke(first.name).onOk();
        open = false; render(); open = true; render();
        expect(controls.buttons.get('Действия с компьютером Рабочий компьютер')?.disabled).toBe(true);
        expect(controls.buttons.get('Действия с компьютером Рабочий компьютер')?.loading).toBe(true);
        pending.reject(new Error('Ошибка старого окна')); await revoking;
        expect(render()).not.toContain('Ошибка старого окна');
        expect(controls.buttons.get('Действия с компьютером Рабочий компьютер')?.disabled).toBe(false);
    });

    it('Возврат прежнего владельца не оживляет занятость старой сессии', async () => {
        const pending = deferred(); vi.mocked(bridgeApi.revoke).mockReturnValue(pending.promise);
        render(); const revoking = requestRevoke(first.name).onOk();
        controls.owner = 'owner-b'; controls.generation++; render();
        controls.owner = 'owner-a'; controls.generation++; render();
        expect(controls.buttons.get('Действия с компьютером Рабочий компьютер')?.disabled).toBe(false);
        pending.resolve(); await revoking;
        expect(onRevoked).not.toHaveBeenCalled();
    });

    it('Возврат прежнего владельца не оживляет подтверждение из старой сессии', () => {
        render(); requestRevoke(first.name);
        controls.owner = 'owner-b'; controls.generation++; render();
        controls.owner = 'owner-a'; controls.generation++; render();
        expect(controls.confirmations).toHaveLength(0);
    });

    it('Непроверенный снимок не разрешает выбор и отзыв и не обещает онлайн', () => {
        verified = false; const html = render();
        expect(html).not.toContain('На связи');
        expect(controls.buttons.get('Выбрать компьютер Старый компьютер')?.disabled).toBe(true);
        expect(controls.buttons.get('Действия с компьютером Старый компьютер')?.disabled).toBe(true);
        controls.buttons.get('Обновить список компьютеров')?.onClick?.();
        expect(onReload).toHaveBeenCalledOnce();
    });

    it('Истёкшее подключение не показывает прежний online как доступный мост', () => {
        expect(bridgeDeviceStatus({ ...first, requiresReconnect: true }, true)).toBe('подключение истекло');
    });

    it('Пустой подтверждённый список предлагает одно явное подключение', () => {
        devices = []; const html = render();
        expect(html).toContain('Подключите первый компьютер');
        expect(html.match(/>Подключить компьютер<\/button>/g)).toHaveLength(1);
        expect(controls.buttons.has('Выбрать компьютер Рабочий компьютер')).toBe(false);
    });

    it('Первая загрузка не маскируется под отсутствие компьютеров', () => {
        devices = []; verified = false; loading = true; const html = render();
        expect(html).toContain('Загружаем компьютеры');
        expect(html).not.toContain('Подключите первый компьютер');
        expect(html).not.toContain('Не удалось загрузить компьютеры');
    });

    it('Ошибка первого чтения предлагает обновление вместо ложного пустого списка', () => {
        devices = []; verified = false; const html = render();
        expect(html).toContain('Не удалось загрузить компьютеры');
        expect(html).not.toContain('Подключите первый компьютер');
        controls.buttons.get('Обновить список компьютеров')?.onClick?.();
        expect(onReload).toHaveBeenCalledOnce();
    });

    it('Единственный выбранный компьютер не получает бессмысленную выключенную кнопку выбора', () => {
        devices = [first]; const html = render();
        expect(html).toContain('bridge-device-card_selected');
        expect(html).toContain('Выбран');
        expect(controls.buttons.has('Выбрать компьютер Рабочий компьютер')).toBe(false);
    });

    it('Одинаковые имена различаются короткими папками, а полный путь остаётся в сведениях', () => {
        devices = [{ ...first, report: { ...first.report, root: '/Users/test/Первый проект' } },
            { ...second, name: first.name, report: { ...second.report, root: 'C:\\Projects\\Второй проект' } }];
        const html = render();
        expect(html).toContain('class="bridge-device-card__folder" title="/Users/test/Первый проект">Первый проект');
        expect(html).toContain('class="bridge-device-card__folder" title="C:\\Projects\\Второй проект">Второй проект');
        expect(html).toContain('<summary>Подробнее');
    });

    it.each([
        { online: true, expired: false, checked: true, status: 'На связи' },
        { online: false, expired: false, checked: true, status: 'Не в сети' },
        { online: true, expired: true, checked: true, status: 'Нужно переподключить' },
        { online: true, expired: false, checked: false, status: 'Статус не проверен' },
    ])('Длинное имя сохраняется рядом с явным статусом «$status»', ({ online, expired, checked, status }) => {
        devices = [{ ...first, name: 'MacBook-Pro-Aleksej.local-компьютер-с-очень-длинным-именем', online, requiresReconnect: expired }]; verified = checked;
        const html = render();
        expect(html).toContain(devices[0].name); expect(html).toContain(status);
    });

    it('Поздний отзыв A после закрытия списка сохраняет выбранный C и убирает только A', async () => {
        const bridge = connectionFixture(), pending = deferred();
        vi.mocked(bridgeApi.revoke).mockReturnValue(pending.promise);
        showComputers(bridge);
        const revoking = requestRevoke(first.name, () => renderConnection(bridge)).onOk();
        controls.closeManager?.(); renderConnection(bridge);
        controls.select?.onChange('third'); renderConnection(bridge);
        pending.resolve(); await revoking; renderConnection(bridge);
        expect(bridge.choose).toHaveBeenCalledExactlyOnceWith('third');
        expect(controls.select?.value).toBe('third');
        expect(controls.select?.options.map(item => item.value)).toEqual(['second', 'third']);
        expect(bridge.reload).toHaveBeenCalledOnce();
    });

    it('При отзыве всё ещё выбранного A переключается на актуальный оставшийся компьютер', async () => {
        const bridge = connectionFixture(), pending = deferred();
        vi.mocked(bridgeApi.revoke).mockReturnValue(pending.promise);
        showComputers(bridge); const revoking = requestRevoke(first.name, () => renderConnection(bridge)).onOk();
        bridge.devices = bridge.devices.filter(item => item.id !== 'second'); renderConnection(bridge);
        pending.resolve(); await revoking;
        expect(bridge.choose).toHaveBeenCalledExactlyOnceWith('third');
    });

    it.each(['success', 'failure'])('Поздний %s прежнего владельца не меняет выбор и занятость новой попытки', async outcome => {
        const oldBridge = connectionFixture(), old = deferred(), current = deferred();
        vi.mocked(bridgeApi.revoke).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        showComputers(oldBridge); const oldRevoking = requestRevoke(first.name, () => renderConnection(oldBridge)).onOk();
        controls.owner = 'owner-b'; controls.generation++;
        const bridge = connectionFixture(); bridge.device = second; renderConnection(bridge);
        const newRevoking = requestRevoke(second.name, () => renderConnection(bridge)).onOk(); renderConnection(bridge);
        if (outcome === 'success') { old.resolve(); } else { old.reject(new Error('Ошибка прежнего владельца')); }
        await oldRevoking;
        const html = renderConnection(bridge);
        expect(html).not.toContain('Ошибка прежнего владельца');
        expect(controls.buttons.get('Действия с компьютером Старый компьютер')?.loading).toBe(true);
        expect(oldBridge.reload).not.toHaveBeenCalled(); expect(bridge.reload).not.toHaveBeenCalled();
        expect(oldBridge.choose).not.toHaveBeenCalled(); expect(bridge.choose).not.toHaveBeenCalled();
        expect(controls.select?.options.map(item => item.value)).toContain('first');
        current.resolve(); await newRevoking;
        expect(bridge.reload).toHaveBeenCalledOnce();
    });

    it('Поздняя ошибка закрытого списка не появляется при повторном открытии', async () => {
        const pending = deferred(); vi.mocked(bridgeApi.revoke).mockReturnValue(pending.promise);
        render(); const revoking = requestRevoke(first.name).onOk();
        open = false; render(); pending.reject(new Error('Ошибка закрытого списка')); await revoking;
        open = true; const html = render();
        expect(html).not.toContain('Ошибка закрытого списка');
        expect(controls.buttons.get('Действия с компьютером Рабочий компьютер')?.disabled).toBe(false);
    });
});
