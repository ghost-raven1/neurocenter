import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {bridgeApi, type IBridgeInstallation} from '../src/features/McpBridge/api';
import {LocalInstallations} from '../src/features/McpBridge/LocalInstallations';
import {ragUiFixture} from './ragUiFixture';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; cleanup?: () => void}> = [];
    const effects: Array<() => void> = [];
    return {
        begin: () => { cursor = 0; },
        commit: () => { effects.splice(0).forEach(effect => effect()); },
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial?: T) {
            const slot = slots[cursor++] ??= {value: initial};
            return [slot.value, (next: T) => { slot.value = next; }];
        },
        useRef<T>(initial: T) { return (slots[cursor++] ??= {value: {current: initial}}).value; },
        useEffect(effect: () => void | (() => void)) {
            const index = cursor++;
            if (!slots[index]) { const slot = slots[index] = {}; effects.push(() => { slot.cleanup = effect() || undefined; }); }
        },
    };
});
interface ButtonProps {children?: ReactNode; disabled?: boolean; loading?: boolean; onClick?: () => void;}
interface ModalProps {open: boolean; onOk: () => void; okButtonProps: {loading: boolean}; children?: ReactNode;}
const ui = vi.hoisted(() => ({buttons: new Map<string, ButtonProps>(), modal: undefined as ModalProps | undefined, errors: [] as string[]}));
vi.mock('react', async () => ({...await vi.importActual('react'), useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect}));
vi.mock('../src/features/McpBridge/api', () => ({bridgeApi: {create: vi.fn()}}));
vi.mock('../src/features/McpBridge/InstallationInspectionStatus', () => ({InstallationInspectionStatus: () => null, matchingInspection: () => undefined}));
vi.mock('../src/features/McpBridge/InstallationOperationActions', () => ({InstallationOperationActions: () => null}));
vi.mock('../src/features/McpBridge/RuntimeProbeStatus', () => ({RuntimeProbeStatus: () => null}));
vi.mock('../src/features/McpBridge/InstallationReadinessStatus', () => ({InstallationReadinessStatus: () => null}));
vi.mock('../src/features/McpBridge/ProjectInventory', () => ({ProjectInventory: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {
        Alert: ({type, message}: {type: string; message: string}) => { if (type === 'error') ui.errors.push(message); return null; },
        Button: (props: ButtonProps) => { ui.buttons.set(String(props.children), props); return null; },
        Modal: (props: ModalProps) => { ui.modal = props; return props.open ? props.children : null; },
        List: Object.assign(({dataSource, renderItem}: {dataSource: IBridgeInstallation[]; renderItem: (item: IBridgeInstallation) => ReactNode}) => dataSource.map(renderItem), {Item: content}),
        Tabs: ({items}: {items: Array<{children: ReactNode}>}) => items[0].children,
        Card: content, Collapse: Object.assign(content, {Panel: content}), Space: content, Tag: content,
        Typography: {Text: content, Paragraph: content},
    };
});

function setup() {
    const fixture = ragUiFixture(), reload = vi.fn(async () => undefined);
    fixture.device.report.capabilities!.push('install-set-v1', 'installation-inspection-v1');
    const bridge = {...fixture.bridge, reload};
    const render = () => {
        hooks.begin(); ui.buttons.clear(); ui.errors.length = 0;
        renderToStaticMarkup(createElement(LocalInstallations, {bridge, projectId: fixture.item.projectId, canManage: true, canInspect: true,
            catalog: [], approved: new Set(['mcp:' + fixture.item.assetId])}));
        hooks.commit();
    };
    const click = (kind: 'remove' | 'inspect') => {
        if (kind === 'inspect') { ui.buttons.get('Проверить файлы')!.onClick!(); }
        else {
            if (!ui.modal?.open) { ui.buttons.get('Удалить с компьютера')!.onClick!(); render(); }
            ui.modal!.onOk();
        }
    };
    const busy = (kind: 'remove' | 'inspect') => kind === 'remove' ? ui.modal!.okButtonProps.loading : ui.buttons.get('Проверить файлы')!.loading;
    render(); return {...fixture, reload, bridge, render, click, busy};
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(bridgeApi.create).mockResolvedValue(ragUiFixture().job()); });
afterEach(() => { hooks.dispose(); vi.restoreAllMocks(); });

describe('Локальные установки освобождают действия после отказа подготовки запроса', () => {
    const actions = [{kind: 'remove', name: 'Удаление'}, {kind: 'inspect', name: 'Проверка файлов'}] as const;
    it.each(actions)('$name: отказ UUID не блокирует кнопку, повтор отправляет одно задание', async ({kind}) => {
        vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => { throw new TypeError('crypto.randomUUID unavailable'); });
        const h = setup(); h.click(kind);
        await vi.waitFor(() => { h.render(); expect(ui.errors.join()).toMatch(/Не удалось подготовить запрос к мосту/); }, {timeout: 100});
        expect(h.busy(kind)).toBe(false); expect(ui.errors.join()).not.toContain('crypto'); expect(bridgeApi.create).not.toHaveBeenCalled();
        h.click(kind);
        await vi.waitFor(() => { h.render(); expect(h.reload).toHaveBeenCalledOnce(); });
        expect(h.busy(kind)).toBe(false); expect(bridgeApi.create).toHaveBeenCalledOnce();
        expect(vi.mocked(bridgeApi.create).mock.calls[0][0].kind).toBe(kind === 'remove' ? 'uninstall' : 'inspect-installation');
    });

    it.each(actions)('$name: сетевой отказ сохраняет ключ повторного запроса', async ({kind}) => {
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Связь прервана'));
        const h = setup(); h.click(kind);
        await vi.waitFor(() => { h.render(); expect(ui.errors.join()).toContain('Связь прервана'); });
        expect(h.busy(kind)).toBe(false); h.click(kind);
        await vi.waitFor(() => expect(h.reload).toHaveBeenCalledOnce());
        const requests = vi.mocked(bridgeApi.create).mock.calls.map(([request]) => request);
        expect(requests).toHaveLength(2); expect(requests[1].requestKey).toBe(requests[0].requestKey);
    });
});
