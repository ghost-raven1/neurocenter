import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice, IBridgeJob, IBridgeJobDraft } from '../src/features/McpBridge/api';
import type { useBridge } from '../src/features/McpBridge/useBridge';
import { WorkspaceBindingWizard } from '../src/features/McpBridge/WorkspaceBindingWizard';
import { workspaceBindingNotice } from '../src/features/McpBridge/workspaceBinding';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; dependencies?: unknown[]; cleanup?: () => void}> = [];
    const effects: Array<() => void> = [];
    return {
        begin: () => { cursor = 0; },
        commit: () => { effects.splice(0).forEach(effect => effect()); },
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T | (() => T)) {
            const slot = slots[cursor++] ??= {value: typeof initial === 'function' ? (initial as () => T)() : initial};
            return [slot.value, (next: T | ((previous: T) => T)) => {
                slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next;
            }];
        },
        useRef<T>(initial: T) { return (slots[cursor++] ??= {value: {current: initial}}).value; },
        useEffect(effect: () => void | (() => void), dependencies?: unknown[]) {
            const index = cursor++;
            const previous = slots[index];
            if (previous && dependencies && previous.dependencies?.length === dependencies.length
                && dependencies.every((value, position) => Object.is(value, previous.dependencies![position]))) { return; }
            const slot = slots[index] = {dependencies};
            effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});
const ui = vi.hoisted(() => ({
    buttons: new Map<string, {onClick?: () => void; disabled?: boolean}>(),
    checkbox: undefined as {checked: boolean; disabled: boolean; onChange: (event: {target: {checked: boolean}}) => void} | undefined,
    modes: [] as string[],
    operation: {job: undefined as IBridgeJob | undefined, busy: false, error: '', setError: vi.fn(), submit: vi.fn()},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
    useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect,
}));
vi.mock('../src/features/McpBridge/useLocalJob', () => ({useLocalJob: () => ui.operation}));
vi.mock('../src/features/McpBridge/api', () => ({bridgeApi: {cancel: vi.fn()}}));
vi.mock('antd', async () => {
    const {createElement: h} = await import('react');
    const content = ({children}: {children?: ReactNode}) => children;
    return {
        Modal: content, Space: content, Steps: () => null,
        Descriptions: Object.assign(content, {Item: content}), Typography: {Paragraph: content, Text: content},
        Alert: ({message, description, action}: {message: ReactNode; description?: ReactNode; action?: ReactNode}) => h('div', null, message, description, action),
        Select: (props: {'aria-label': string; value: string}) => {
            if (props['aria-label'] === 'Действие с папкой') { ui.modes.push(props.value); }
            return null;
        },
        Checkbox: (props: NonNullable<typeof ui.checkbox> & {children: ReactNode}) => { ui.checkbox = props; return props.children; },
        Button: (props: {children: ReactNode; onClick?: () => void; disabled?: boolean}) => {
            if (typeof props.children === 'string') { ui.buttons.set(props.children, props); }
            return h('button', {disabled: props.disabled}, props.children);
        },
    };
});

const project = {id: 'project', name: 'Мой проект'};
const folderName = 'Локальный проект';
function fixture() {
    const device: IBridgeDevice = {
        id: 'computer', name: 'Компьютер', role: 'Разработчик', fingerprint: '', online: true, lastSeen: null,
        report: {protocolVersion: 2, capabilities: ['durable-completions','managed-installations','workspace-instance-v1'],
            root: '/fixture/projects', folders: [folderName], bindings: [{projectId: project.id, folderName, valid: true,
                identityStatus: 'verified', bindingId: 'a'.repeat(64), instanceId: '11111111-1111-1111-1111-111111111111'}]},
    };
    return {device, devices: [device], jobs: [] as IBridgeJob[], installations: [], devicesReady: true, jobsReady: true,
        installationsReady: true, loading: false, errors: {devices: '', jobs: '', installations: ''}, error: '', reload: vi.fn(), choose: vi.fn()};
}
let bridge: ReturnType<typeof fixture>;
function render() {
    hooks.begin(); ui.buttons.clear(); ui.checkbox = undefined;
    const html = renderToStaticMarkup(createElement(WorkspaceBindingWizard, {
        bridge: bridge as ReturnType<typeof useBridge>, project, canManage: true, onClose: vi.fn(),
    }));
    hooks.commit();
    return html;
}
function button(label: string) {
    const value = ui.buttons.get(label); expect(value).toBeDefined(); return value!;
}
function completePreparation(token = 'b'.repeat(64)) {
    ui.operation.job = {...ui.operation.job!, state: 'succeeded', result: {
        projectId: project.id, folderName, mode: 'new', preparation: token, requiresFileVerification: false,
    }};
    render(); render();
}
async function checkFolder() {
    button('Проверить выбранную папку').onClick!();
    await vi.waitFor(() => expect(ui.operation.submit).toHaveBeenCalled());
    await Promise.resolve();
}

beforeEach(() => {
    vi.clearAllMocks(); bridge = fixture(); ui.buttons.clear(); ui.checkbox = undefined; ui.modes = [];
    ui.operation.job = undefined; ui.operation.busy = false; ui.operation.error = '';
    ui.operation.submit.mockImplementation(async (input: IBridgeJobDraft) => {
        const job: IBridgeJob = {id: `job-${ui.operation.submit.mock.calls.length}`, deviceId: input.deviceId,
            projectId: input.projectId, kind: input.kind, state: 'queued', message: 'Ожидает мост',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
        ui.operation.job = job; return job;
    });
});
afterEach(() => { hooks.dispose(); });

describe('Повторная проверка папки после отказа привязки', () => {
    it('После отказа подтверждения требует новую проверку и отдельное согласие', async () => {
        render(); await checkFolder(); completePreparation();
        ui.checkbox!.onChange({target: {checked: true}}); render();
        expect(button('Подтвердить привязку').disabled).toBe(false);
        button('Подтвердить привязку').onClick!();
        await vi.waitFor(() => expect(ui.operation.submit).toHaveBeenCalledTimes(2));
        ui.operation.job = {...ui.operation.job!, state: 'failed', message: 'Папка изменилась. Проверьте её заново.'};
        expect(render()).toContain(ui.operation.job.message);
        expect(button('Подтвердить привязку').disabled).toBe(true);
        button('Подтвердить привязку').onClick!();
        expect(ui.operation.submit).toHaveBeenCalledTimes(2);
        button('Проверить папку заново').onClick!(); render();
        expect(ui.buttons.has('Подтвердить привязку')).toBe(false);
        expect(button('Проверить выбранную папку').disabled).toBe(false);
        await checkFolder();
        expect(ui.operation.submit).toHaveBeenCalledTimes(3);
        expect(ui.operation.submit.mock.calls[2][0]).toEqual({
            kind: 'prepare-bind-project', deviceId: bridge.device.id, projectId: project.id, folderName, bindingMode: 'new',
        });
        completePreparation('c'.repeat(64));
        expect(ui.checkbox!.checked).toBe(false);
        expect(button('Подтвердить привязку').disabled).toBe(true);
    });

    it('После отказа проверки оставляет папку и режим для новой подготовки', async () => {
        render(); await checkFolder();
        ui.operation.job = {...ui.operation.job!, state: 'failed', message: 'Папка недоступна. Проверьте доступ на компьютере.'};
        expect(render()).toContain(ui.operation.job.message);
        button('Проверить папку заново').onClick!(); render();
        expect(button('Проверить выбранную папку').disabled).toBe(false);
        await checkFolder();
        expect(ui.operation.submit).toHaveBeenCalledTimes(2);
        expect(ui.operation.submit.mock.calls[1][0]).toEqual(ui.operation.submit.mock.calls[0][0]);
    });

    it.each(['copied', 'changed', 'unavailable'] as const)('Объясняет статус %s и сохраняет явный выбор действия', status => {
        bridge.device.report.bindings![0] = {...bridge.device.report.bindings![0], valid: false, identityStatus: status,
            error: '/private/path/секрет', bindingId: undefined, instanceId: undefined};
        const html = render();
        expect(html).toContain(workspaceBindingNotice(bridge.device.report.bindings![0]));
        expect(html).not.toContain('/private/path/секрет');
        expect(ui.modes).toEqual(['new']);
    });

    it('Рекомендует явный перенос только при подтверждённых данных прежнего экземпляра', () => {
        const binding = {...bridge.device.report.bindings![0], valid: false, identityStatus: 'unavailable' as const,
            previousBindingId: 'a'.repeat(64)};
        expect(workspaceBindingNotice(binding)).toContain('Перенести существующий экземпляр');
        expect(workspaceBindingNotice({...binding, instanceId: undefined})).not.toContain('Перенести существующий экземпляр');
        expect(workspaceBindingNotice({...binding, previousBindingId: 'invalid'})).not.toContain('Перенести существующий экземпляр');
        expect(workspaceBindingNotice(undefined)).toBe('');
    });
});
