import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {KnowledgeSync} from '../src/features/McpBridge/KnowledgeSync';
import {bridgeApi, type IBridgeJob} from '../src/features/McpBridge/api';

const hooks = vi.hoisted(() => {
    let cursor = 0, mounted = true, lateWrites = 0;
    const slots: Array<{value?: unknown; dependencies?: unknown[]; cleanup?: () => void}> = [];
    const effects: Array<() => void> = [];
    return {
        begin: () => {if (!slots.length) lateWrites = 0; cursor = 0; mounted = true;},
        commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => {mounted = false; slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0;},
        lateWrites: () => lateWrites,
        useState: (initial: unknown) => {
            const slot = slots[cursor++] ??= {value: initial};
            return [slot.value, (value: unknown) => {if (!mounted) lateWrites++; slot.value = value;}];
        },
        useRef: (initial: unknown) => (slots[cursor++] ??= {value: {current: initial}}).value,
        useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
            const index = cursor++, previous = slots[index];
            if (previous?.dependencies?.length === dependencies.length && dependencies.every((value, item) => Object.is(value, previous.dependencies![item]))) return;
            const slot = slots[index] = {dependencies};
            effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});
        },
    };
});
const ui = vi.hoisted(() => ({
    projectId: 'project-a', owner: 'owner-a', owners: new Map<string, () => () => boolean>(),
    buttons: new Map<string, {disabled?: boolean; onClick: () => void}>(), errors: [] as string[],
    bridge: {device: {id: 'device-a', name: 'Компьютер', role: 'Разработчик', online: true, report: {
        protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'project-rag-sync-v1'],
        bindings: [{projectId: 'project-a', bindingId: 'a'.repeat(64), valid: true}, {projectId: 'project-b', bindingId: 'b'.repeat(64), valid: true}],
    }}, devicesReady: true, jobsReady: true, installationsReady: true, jobs: [], reload: vi.fn(async () => undefined)},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
    useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect,
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    if (!ui.owners.has(ui.owner)) {const owner = ui.owner; ui.owners.set(owner, () => () => owner === ui.owner);}
    return {scope: ui.owner, captureOwner: ui.owners.get(ui.owner)!};
}}));
vi.mock('../src/features/McpBridge/api', () => ({bridgeApi: {create: vi.fn()}}));
vi.mock('../src/features/McpBridge/useBridge', () => ({useBridge: () => ui.bridge}));
vi.mock('../src/features/McpBridge/BridgeConnection', () => ({BridgeConnection: () => null}));
vi.mock('../src/features/McpBridge/ragUi/OpenCodeRagUi', () => ({OpenCodeRagUi: () => null}));
vi.mock('react-router-dom', () => ({Link: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Space: content, Typography: {Text: content}, Alert: ({type, message}: {type: string; message: string}) => {if (type === 'error') ui.errors.push(message); return null;},
        Button: (props: {children: ReactNode; disabled?: boolean; onClick: () => void}) => {ui.buttons.set(String(props.children), props); return null;}};
});
const sync = 'Синхронизировать с сервером', restore = 'Скачать в проект через мост';
const job = (id: string, state: IBridgeJob['state'] = 'queued') => ({id, state}) as IBridgeJob;
function render() {hooks.begin(); ui.buttons.clear(); ui.errors = []; renderToStaticMarkup(createElement(KnowledgeSync, {projectId: ui.projectId, canWrite: true, serverReady: true})); hooks.commit();}
function click(label = sync) {const button = ui.buttons.get(label)!; expect(button.disabled).toBe(false); button.onClick();}
async function flush() {for (let index = 0; index < 12; index++) await Promise.resolve();}
function deferred() {
    let resolve!: (value: IBridgeJob) => void, reject!: (error: Error) => void;
    const promise = new Promise<IBridgeJob>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
beforeEach(() => {
    vi.resetAllMocks(); ui.projectId = 'project-a'; ui.owner = 'owner-a'; ui.owners.clear();
    ui.bridge.device.id = 'device-a'; ui.bridge.device.report.bindings[0].bindingId = 'a'.repeat(64);
    ui.bridge.reload.mockResolvedValue(undefined);
});
afterEach(() => {hooks.dispose(); vi.unstubAllGlobals();});

describe('Повтор синхронизации сохраняет неопределённый запрос текущей папки', () => {
    it.each([sync, restore])('%s: принятый POST с потерянным ответом повторяется даже после завершения job', async label => {
        const accepted = new Map<string, IBridgeJob>(); let lost = true;
        vi.mocked(bridgeApi.create).mockImplementation(async input => {
            if (!accepted.has(input.requestKey)) accepted.set(input.requestKey, job('job-' + (accepted.size + 1)));
            const saved = accepted.get(input.requestKey)!;
            if (lost) {lost = false; saved.state = 'succeeded'; throw new Error('Ответ потерян после принятия задания');}
            return saved;
        });
        render(); click(label); await flush(); render(); click(label); await flush(); render();
        const keys = vi.mocked(bridgeApi.create).mock.calls.map(([input]) => input.requestKey);
        expect(keys[1]).toBe(keys[0]); expect(accepted.size).toBe(1);
        click(label); await flush();
        expect(vi.mocked(bridgeApi.create).mock.calls[2][0].requestKey).not.toBe(keys[0]); expect(accepted.size).toBe(2);
    });

    it('Смена направления оставляет прежнюю попытку отдельным действием', async () => {
        vi.mocked(bridgeApi.create).mockRejectedValue(new Error('Нет ответа'));
        render(); click(sync); await flush(); render(); click(restore); await flush(); render(); click(sync); await flush();
        const keys = vi.mocked(bridgeApi.create).mock.calls.map(([input]) => input.requestKey);
        expect(new Set(keys).size).toBe(3);
    });

    it.each(['project', 'device', 'binding', 'owner'])('Смена %s и возврат не возвращают ключ прежнего контекста', async change => {
        vi.mocked(bridgeApi.create).mockRejectedValue(new Error('Нет ответа'));
        render(); click(); await flush();
        const alter = (changed: boolean) => {
            if (change === 'project') ui.projectId = changed ? 'project-b' : 'project-a';
            if (change === 'device') ui.bridge.device.id = changed ? 'device-b' : 'device-a';
            if (change === 'binding') ui.bridge.device.report.bindings[0].bindingId = (changed ? 'c' : 'a').repeat(64);
            if (change === 'owner') ui.owner = changed ? 'owner-b' : 'owner-a';
        };
        alter(true); render(); click(); await flush(); alter(false); render(); click(); await flush();
        expect(new Set(vi.mocked(bridgeApi.create).mock.calls.map(([input]) => input.requestKey)).size).toBe(3);
    });

    it('Отказ UUID освобождает кнопку и сообщает способ повтора', async () => {
        vi.stubGlobal('crypto', {randomUUID: vi.fn().mockImplementationOnce(() => {throw new Error('Нет генератора');}).mockReturnValue('a'.repeat(36))});
        vi.mocked(bridgeApi.create).mockResolvedValue(job('job-a'));
        render(); click(); await flush(); render();
        expect(bridgeApi.create).not.toHaveBeenCalled(); expect(ui.errors.join()).toContain('HTTPS');
        click(); await flush(); render(); expect(bridgeApi.create).toHaveBeenCalledOnce(); expect(ui.errors).toEqual([]);
    });

    it.each(['success', 'failure'])('Поздний %s после закрытия не меняет state и не обновляет очередь', async outcome => {
        const pending = deferred(); vi.mocked(bridgeApi.create).mockReturnValue(pending.promise);
        render(); click(); hooks.dispose();
        if (outcome === 'success') pending.resolve(job('old')); else pending.reject(new Error('Старый отказ'));
        await flush(); expect(hooks.lateWrites()).toBe(0); expect(ui.bridge.reload).not.toHaveBeenCalled();
    });

    it.each(['success', 'failure'])('Поздний %s прежней папки не снимает занятость новой попытки', async outcome => {
        const old = deferred(), current = deferred(); vi.mocked(bridgeApi.create).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        render(); click(); ui.projectId = 'project-b'; render(); render(); click(); render();
        if (outcome === 'success') old.resolve(job('old')); else old.reject(new Error('Старый отказ'));
        await flush(); render(); expect(ui.buttons.get(sync)!.disabled).toBe(true); expect(ui.errors).toEqual([]); expect(ui.bridge.reload).not.toHaveBeenCalled();
        current.resolve(job('current')); await flush(); render(); expect(ui.buttons.get(sync)!.disabled).toBe(false); expect(ui.bridge.reload).toHaveBeenCalledOnce();
    });

    it.each(['success', 'failure'])('Отзыв владельца до render игнорирует старый %s', async outcome => {
        const pending = deferred(); vi.mocked(bridgeApi.create).mockReturnValue(pending.promise);
        render(); click(); ui.owner = 'owner-b';
        if (outcome === 'success') pending.resolve(job('old')); else pending.reject(new Error('Старая ошибка'));
        await flush(); render();
        expect(ui.errors).toEqual([]); expect(ui.bridge.reload).not.toHaveBeenCalled();
    });

    it('Два нажатия до render передают мосту один запрос', async () => {
        const pending = deferred(); vi.mocked(bridgeApi.create).mockReturnValue(pending.promise);
        render(); click(); click(); expect(bridgeApi.create).toHaveBeenCalledOnce();
        pending.resolve(job('accepted')); await flush();
    });

    it('Задержка чтения очереди не удерживает принятую отправку; отказ чтения отличается от POST', async () => {
        const reload = deferred(); ui.bridge.reload.mockReturnValue(reload.promise as unknown as Promise<void>);
        vi.mocked(bridgeApi.create).mockResolvedValue(job('accepted'));
        render(); click(); await flush(); render(); expect(ui.buttons.get(sync)!.disabled).toBe(false);
        reload.reject(new Error('Чтение недоступно')); await flush(); render(); expect(ui.errors.join()).toContain('Задание принято');
        click(); await flush();
        const keys = vi.mocked(bridgeApi.create).mock.calls.map(([input]) => input.requestKey);
        expect(keys[1]).not.toBe(keys[0]);
    });
});
