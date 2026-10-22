import './feature-flags-enabled';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {KnowledgeSync} from '../src/features/McpBridge/KnowledgeSync';
import {bridgeApi, type IBridgeJob} from '../src/features/McpBridge/api';

interface RestoreDialog {
    title: ReactNode; content: ReactNode; okText: string; onOk: () => Promise<void>; onCancel: () => void;
    destroyed: boolean; destroy: ReturnType<typeof vi.fn>;
}

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
            const slot: (typeof slots)[number] = slots[index] = {dependencies};
            effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});
        },
    };
});
const ui = vi.hoisted(() => ({
    projectId: 'project-a', owner: 'owner-a', canWrite: true, serverReady: true as boolean | undefined, owners: new Map<string, () => () => boolean>(), dialogs: [] as RestoreDialog[],
    buttons: new Map<string, {disabled?: boolean; onClick: () => void}>(), errors: [] as string[], warnings: [] as string[],
    bridge: {device: {id: 'device-a', name: 'Компьютер', role: 'Разработчик', online: true, report: {
        root: '/fixture/root', protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'project-rag-generations-v1'],
        bindings: [{projectId: 'project-a', folderName: 'Локальный проект A', bindingId: 'a'.repeat(64), instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', valid: true}, {projectId: 'project-b', folderName: 'Локальный проект B', bindingId: 'b'.repeat(64), instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', valid: true}],
    }}, devicesReady: true, jobsReady: true, installationsReady: true, loading: false, jobs: [] as IBridgeJob[],
        errors: {devices: '', jobs: '', installations: ''}, reload: vi.fn(async (): Promise<void> => undefined)},
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
    return {Space: content, Typography: {Text: content}, Alert: ({type, message, description}: {type: string; message: string; description?: string}) => {
        if (type === 'error') ui.errors.push(message); if (type === 'warning') ui.warnings.push(message + ' ' + (description || '')); return null;},
        Modal: {confirm: (options: Omit<RestoreDialog, 'destroyed' | 'destroy'>) => {
            const dialog: RestoreDialog = {...options, destroyed: false, destroy: vi.fn()};
            dialog.destroy.mockImplementation(() => {dialog.destroyed = true;}); ui.dialogs.push(dialog); return dialog;
        }},
        Button: (props: {children: ReactNode; disabled?: boolean; onClick: () => void}) => {ui.buttons.set(String(props.children), props); return null;}};
});
const sync = 'Синхронизировать с сервером', restore = 'Скачать в проект через мост';
const job = (id: string, state: IBridgeJob['state'] = 'queued') => ({id, state, deviceId: ui.bridge.device.id, projectId: ui.projectId,
    kind: 'sync-rag', bindingId: ui.bridge.device.report.bindings.find(item => item.projectId === ui.projectId)!.bindingId,
    message: 'Ожидает моста', createdAt: '', updatedAt: ''}) as IBridgeJob;
function render() {hooks.begin(); ui.buttons.clear(); ui.errors = []; ui.warnings = []; renderToStaticMarkup(createElement(KnowledgeSync, {projectId: ui.projectId, canWrite: ui.canWrite, serverReady: ui.serverReady})); hooks.commit();}
function click(label = sync, confirm = true) {const button = ui.buttons.get(label)!; expect(button.disabled).toBe(false); button.onClick(); if (label === restore && confirm) void ui.dialogs[ui.dialogs.length - 1]?.onOk();}
async function flush() {for (let index = 0; index < 12; index++) await Promise.resolve();}
function deferred() {
    let resolve!: (value: IBridgeJob) => void, reject!: (error: Error) => void;
    const promise = new Promise<IBridgeJob>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
beforeEach(() => {
    vi.resetAllMocks(); ui.projectId = 'project-a'; ui.owner = 'owner-a'; ui.canWrite = true; ui.serverReady = true; ui.owners.clear(); ui.dialogs = [];
    ui.bridge.device.id = 'device-a'; ui.bridge.device.report.bindings[0].bindingId = 'a'.repeat(64);
    ui.bridge.device.report.root = '/fixture/root'; ui.bridge.device.report.bindings[0].instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    ui.bridge.jobs = []; ui.bridge.devicesReady = true; ui.bridge.jobsReady = true; ui.bridge.loading = false; ui.bridge.errors.jobs = '';
    ui.bridge.reload.mockResolvedValue(undefined);
});
afterEach(() => {hooks.dispose(); vi.unstubAllGlobals();});

describe('Явное подтверждение замены локального RAG', () => {
    it('Восстановление не отправляется до явного подтверждения замены', async () => {
        vi.mocked(bridgeApi.create).mockResolvedValue({...job('accepted'), kind: 'restore-rag'});
        render(); click(restore, false); await flush();
        expect(bridgeApi.create).not.toHaveBeenCalled(); expect(ui.bridge.reload).not.toHaveBeenCalled();
        const dialog = ui.dialogs[ui.dialogs.length - 1]!;
        expect(dialog.title).toBe('Заменить локальный индекс?'); expect(dialog.okText).toBe('Заменить локальный индекс');
        const text = renderToStaticMarkup(createElement('div', null, dialog.content));
        expect(text).toContain('project-a'); expect(text).toContain('Компьютер'); expect(text).toContain('Локальный проект A');
        expect(text).toContain('заменён серверной копией'); expect(text).toContain('Несинхронизированные локальные данные не объединяются');
        expect(text).toContain('закройте OpenCode');
    });

    it('Отмена не создаёт задание и оставляет возможность осознанно повторить', async () => {
        vi.mocked(bridgeApi.create).mockResolvedValue({...job('accepted'), kind: 'restore-rag'});
        render(); click(restore, false); ui.dialogs[ui.dialogs.length - 1]!.onCancel(); await flush(); render();
        expect(bridgeApi.create).not.toHaveBeenCalled(); expect(ui.bridge.reload).not.toHaveBeenCalled();
        click(restore); await flush();
        expect(bridgeApi.create).toHaveBeenCalledExactlyOnceWith({deviceId: 'device-a', projectId: 'project-a',
            kind: 'restore-rag', expectedBindingId: 'a'.repeat(64), requestKey: expect.any(String)});
    });

    it('Отказ отправки виден, а новый confirm повторяет исходный неопределённый запрос', async () => {
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Сервер недоступен')).mockResolvedValue({...job('accepted'), kind: 'restore-rag'});
        render(); click(restore); await flush(); render(); expect(ui.errors.join()).toContain('Сервер недоступен');
        click(restore, false); expect(bridgeApi.create).toHaveBeenCalledOnce(); await ui.dialogs[ui.dialogs.length - 1]!.onOk(); render();
        expect(ui.errors).toEqual([]); expect(bridgeApi.create).toHaveBeenCalledTimes(2);
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(vi.mocked(bridgeApi.create).mock.calls[0][0]);
        expect(ui.buttons.get(restore)!.disabled).toBe(true);
    });

    it('Повтор click и confirm до render не создаёт второй диалог или второй POST', async () => {
        const pending = deferred(); vi.mocked(bridgeApi.create).mockReturnValue(pending.promise);
        render(); click(restore, false); click(restore, false); expect(ui.dialogs).toHaveLength(1);
        const dialog = ui.dialogs[0]; void dialog.onOk(); void dialog.onOk(); expect(bridgeApi.create).toHaveBeenCalledOnce();
        pending.resolve({...job('accepted'), kind: 'restore-rag'}); await flush(); render();
        expect(ui.buttons.get(restore)!.disabled).toBe(true);
    });

    it.each(['project', 'device', 'binding', 'instance', 'root', 'owner', 'role'])('Смена %s закрывает диалог и запрещает старый confirm', async change => {
        render(); click(restore, false); const dialog = ui.dialogs[0];
        if (change === 'project') ui.projectId = 'project-b';
        if (change === 'device') ui.bridge.device.id = 'device-b';
        if (change === 'binding') ui.bridge.device.report.bindings[0].bindingId = 'c'.repeat(64);
        if (change === 'instance') ui.bridge.device.report.bindings[0].instanceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        if (change === 'root') ui.bridge.device.report.root = '/fixture/other';
        if (change === 'owner') ui.owner = 'owner-b';
        if (change === 'role') ui.canWrite = false;
        render(); await dialog.onOk(); await flush();
        expect(dialog.destroyed).toBe(true); expect(bridgeApi.create).not.toHaveBeenCalled(); expect(ui.bridge.reload).not.toHaveBeenCalled();
    });

    it('Отзыв владельца до render не разрешает старое подтверждение', async () => {
        render(); click(restore, false); const dialog = ui.dialogs[0]; ui.owner = 'owner-b'; await dialog.onOk(); await flush();
        expect(bridgeApi.create).not.toHaveBeenCalled(); expect(ui.bridge.reload).not.toHaveBeenCalled();
    });

    it('Закрытие компонента уничтожает диалог и не разрешает сохранённый callback', async () => {
        render(); click(restore, false); const dialog = ui.dialogs[0]; hooks.dispose(); await dialog.onOk(); await flush();
        expect(dialog.destroyed).toBe(true); expect(bridgeApi.create).not.toHaveBeenCalled(); expect(hooks.lateWrites()).toBe(0);
    });

    it('Принятое параллельное действие сохраняет pending барьер до подтверждения', async () => {
        vi.mocked(bridgeApi.create).mockResolvedValue(job('sync-accepted'));
        render(); click(restore, false); const dialog = ui.dialogs[0]; click(sync); await flush(); await dialog.onOk(); await flush();
        expect(bridgeApi.create).toHaveBeenCalledOnce(); expect(vi.mocked(bridgeApi.create).mock.calls[0][0].kind).toBe('sync-rag');
    });

    it('Свежий запрет серверной копии за время диалога запрещает restore, сохраняя sync', async () => {
        vi.mocked(bridgeApi.create).mockResolvedValue(job('sync-accepted'));
        render(); click(restore, false); const dialog = ui.dialogs[0]; ui.serverReady = false; render(); await dialog.onOk(); await flush();
        expect(bridgeApi.create).not.toHaveBeenCalled(); expect(ui.buttons.get(restore)!.disabled).toBe(true);
        click(sync); await flush(); expect(bridgeApi.create).toHaveBeenCalledOnce();
        expect(vi.mocked(bridgeApi.create).mock.calls[0][0].kind).toBe('sync-rag');
    });
});

describe('Повтор синхронизации сохраняет неопределённый запрос текущей папки', () => {
    it.each([sync, restore])('%s: принятый POST с потерянным ответом повторяется даже после завершения job', async label => {
        const accepted = new Map<string, IBridgeJob>(); let lost = true;
        vi.mocked(bridgeApi.create).mockImplementation(async input => {
            if (!accepted.has(input.requestKey)) accepted.set(input.requestKey, {...job('job-' + (accepted.size + 1)), kind: input.kind});
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

    it.each(['project', 'device', 'binding', 'owner', 'root', 'instance'])('Смена %s и возврат не возвращают ключ прежнего контекста', async change => {
        vi.mocked(bridgeApi.create).mockRejectedValue(new Error('Нет ответа'));
        render(); click(); await flush();
        const alter = (changed: boolean) => {
            if (change === 'project') ui.projectId = changed ? 'project-b' : 'project-a';
            if (change === 'device') ui.bridge.device.id = changed ? 'device-b' : 'device-a';
            if (change === 'binding') ui.bridge.device.report.bindings[0].bindingId = (changed ? 'c' : 'a').repeat(64);
            if (change === 'owner') ui.owner = changed ? 'owner-b' : 'owner-a';
            if (change === 'root') ui.bridge.device.report.root = changed ? '/fixture/other' : '/fixture/root';
            if (change === 'instance') ui.bridge.device.report.bindings[0].instanceId = changed ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
        current.resolve(job('current', 'succeeded')); await flush(); render(); expect(ui.buttons.get(sync)!.disabled).toBe(false); expect(ui.bridge.reload).toHaveBeenCalledOnce();
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

    it('Принятый queued ACK блокирует повтор до терминального результата, даже при отказе чтения', async () => {
        const reload = deferred(); ui.bridge.reload.mockReturnValue(reload.promise as unknown as Promise<void>);
        const accepted = job('accepted'); vi.mocked(bridgeApi.create).mockResolvedValue(accepted);
        render(); click(); await flush(); render(); expect(ui.buttons.get(sync)!.disabled).toBe(true);
        reload.reject(new Error('Чтение недоступно')); await flush(); render(); expect(ui.errors.join()).toContain('Задание принято');
        ui.buttons.get(sync)!.onClick(); await flush(); expect(bridgeApi.create).toHaveBeenCalledOnce();
        ui.bridge.jobs = [{...accepted, state: 'succeeded'}]; render();
        click(); await flush();
        const keys = vi.mocked(bridgeApi.create).mock.calls.map(([input]) => input.requestKey);
        expect(keys[1]).not.toBe(keys[0]);
    });

    it('Повтор обработчика после ACK до render не создаёт вторую тяжёлую операцию', async () => {
        const reload = deferred(); ui.bridge.reload.mockReturnValue(reload.promise as unknown as Promise<void>);
        vi.mocked(bridgeApi.create).mockResolvedValue(job('accepted')); render();
        const action = ui.buttons.get(sync)!.onClick; action(); await flush(); action(); await flush();
        expect(bridgeApi.create).toHaveBeenCalledOnce();
    });

    it.each([sync, restore])('%s: потерянный ACK повторяет тот же ключ, принятый повтор блокирует оба направления', async label => {
        const accepted = {...job('accepted'), kind: label === sync ? 'sync-rag' : 'restore-rag'};
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян')).mockResolvedValue(accepted);
        render(); click(label); await flush(); render(); click(label); await flush(); render();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0].requestKey).toBe(vi.mocked(bridgeApi.create).mock.calls[0][0].requestKey);
        expect(ui.buttons.get(sync)!.disabled).toBe(true); expect(ui.buttons.get(restore)!.disabled).toBe(true);
        ui.buttons.get(sync)!.onClick(); ui.buttons.get(restore)!.onClick(); await flush();
        expect(bridgeApi.create).toHaveBeenCalledTimes(2);
    });

    it('Непроверенный терминальный снимок не снимает барьер принятого задания', async () => {
        const accepted = job('accepted'); vi.mocked(bridgeApi.create).mockResolvedValue(accepted);
        render(); click(); await flush(); ui.bridge.jobs = [{...accepted, state: 'succeeded'}];
        ui.bridge.jobsReady = false; ui.bridge.errors.jobs = 'Не удалось прочитать очередь'; render();
        expect(ui.buttons.get(sync)!.disabled).toBe(true);
        ui.bridge.jobsReady = true; ui.bridge.errors.jobs = ''; render(); expect(ui.buttons.get(sync)!.disabled).toBe(false);
    });

    it('Подтверждённый терминальный итог не воскресает как queued после отказа чтения', async () => {
        const accepted = job('accepted'); vi.mocked(bridgeApi.create).mockResolvedValue(accepted);
        render(); click(); await flush(); render();
        ui.bridge.jobs = [{...accepted, state: 'succeeded'}]; render(); render(); expect(ui.buttons.get(sync)!.disabled).toBe(false);
        ui.bridge.jobsReady = false; ui.bridge.errors.jobs = 'Очередь временно недоступна'; ui.bridge.jobs = []; render();
        expect(ui.buttons.has('Обновить состояние задания')).toBe(false);
        ui.bridge.jobsReady = true; ui.bridge.errors.jobs = ''; render(); expect(ui.buttons.get(sync)!.disabled).toBe(false);
    });

    it('Выпавший из последних ста записей итог сверяется тем же ключом, без новой операции', async () => {
        const accepted = job('accepted');
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(accepted).mockResolvedValue({...accepted, state: 'succeeded'});
        render(); click(); await flush(); render(); expect(ui.buttons.get(sync)!.disabled).toBe(true);
        ui.buttons.get('Обновить состояние задания')!.onClick(); await flush(); render();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toEqual(vi.mocked(bridgeApi.create).mock.calls[0][0]);
        expect(ui.buttons.get(sync)!.disabled).toBe(false);
    });

    it('Пустой список и чужой результат сверки не разрешают повтор тяжёлой операции', async () => {
        const accepted = job('accepted');
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(accepted).mockResolvedValue({...accepted, id: 'another', state: 'succeeded'});
        render(); click(); await flush(); render(); ui.buttons.get('Обновить состояние задания')!.onClick(); await flush(); render();
        expect(ui.buttons.get(sync)!.disabled).toBe(true); expect(ui.errors.join()).toContain('исходное задание');
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0].requestKey).toBe(vi.mocked(bridgeApi.create).mock.calls[0][0].requestKey);
    });

    it('Двойное обновление сверяет одно исходное задание; поздний итог другого проекта игнорируется', async () => {
        const accepted = job('accepted'), pending = deferred();
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(accepted).mockReturnValue(pending.promise);
        render(); click(); await flush(); render(); const refresh = ui.buttons.get('Обновить состояние задания')!.onClick;
        refresh(); refresh(); expect(bridgeApi.create).toHaveBeenCalledTimes(2);
        ui.projectId = 'project-b'; render(); render(); pending.resolve({...accepted, state: 'succeeded'}); await flush(); render();
        expect(ui.bridge.reload).toHaveBeenCalledOnce(); expect(ui.buttons.get(sync)!.disabled).toBe(false); expect(ui.errors).toEqual([]);
    });

    it('Поздний queued ответ сверки не затирает уже подтверждённый терминальный итог', async () => {
        const accepted = job('accepted'), pending = deferred();
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(accepted).mockReturnValue(pending.promise);
        render(); click(); await flush(); render(); ui.buttons.get('Обновить состояние задания')!.onClick();
        ui.bridge.jobs = [{...accepted, state: 'succeeded'}]; render(); render();
        ui.bridge.jobsReady = false; ui.bridge.jobs = []; render(); pending.resolve(accepted); await flush(); render();
        ui.bridge.jobsReady = true; render(); expect(ui.buttons.get(sync)!.disabled).toBe(false);
    });

    it('Отказ прав при сверке виден, а восстановленный доступ использует тот же ключ', async () => {
        const accepted = job('accepted'); vi.mocked(bridgeApi.create).mockResolvedValueOnce(accepted)
            .mockRejectedValueOnce(new Error('Доступ к исходному заданию запрещён')).mockResolvedValue({...accepted, state: 'failed'});
        render(); click(); await flush(); render(); ui.buttons.get('Обновить состояние задания')!.onClick(); await flush(); render();
        expect(ui.errors.join()).toContain('Доступ к исходному заданию запрещён'); expect(ui.buttons.get(sync)!.disabled).toBe(true);
        ui.buttons.get('Обновить состояние задания')!.onClick(); await flush(); render();
        expect(ui.buttons.get(sync)!.disabled).toBe(false);
        expect(new Set(vi.mocked(bridgeApi.create).mock.calls.map(([input]) => input.requestKey)).size).toBe(1);
    });

    it('Чужой ACK сохраняет неопределённый ключ и не выдаётся за принятое задание', async () => {
        const accepted = job('accepted');
        vi.mocked(bridgeApi.create).mockResolvedValueOnce({...accepted, bindingId: 'f'.repeat(64)}).mockResolvedValue(accepted);
        render(); click(); await flush(); render(); expect(ui.errors.join()).toContain('неполное подтверждение');
        click(); await flush(); render();
        expect(vi.mocked(bridgeApi.create).mock.calls[1][0].requestKey).toBe(vi.mocked(bridgeApi.create).mock.calls[0][0].requestKey);
        expect(ui.buttons.get(sync)!.disabled).toBe(true);
    });

    it('Поздний ACK первого проекта после A→B→A не возвращает старое задание', async () => {
        const pending = deferred(), accepted = job('old'); vi.mocked(bridgeApi.create).mockReturnValue(pending.promise);
        render(); click(); ui.projectId = 'project-b'; render(); ui.projectId = 'project-a'; render();
        pending.resolve(accepted); await flush(); render();
        expect(ui.bridge.reload).not.toHaveBeenCalled(); expect(ui.buttons.get(sync)!.disabled).toBe(false); expect(ui.errors).toEqual([]);
    });

    it('Отказ доступа к чтению очереди показывает причину и оставляет безопасное обновление', async () => {
        const accepted = job('accepted'); vi.mocked(bridgeApi.create).mockResolvedValue(accepted);
        render(); click(); await flush(); ui.bridge.jobsReady = false; ui.bridge.errors.jobs = 'Доступ к очереди запрещён'; render();
        expect(ui.warnings.join()).toContain('Доступ к очереди запрещён');
        expect(ui.buttons.get(sync)!.disabled).toBe(true); expect(ui.buttons.get('Обновить состояние задания')!.disabled).not.toBe(true);
        ui.buttons.get('Обновить состояние задания')!.onClick(); await flush(); expect(bridgeApi.create).toHaveBeenCalledOnce();
        ui.bridge.jobsReady = true; ui.bridge.errors.jobs = ''; ui.bridge.jobs = [{...accepted, state: 'failed'}]; render();
        expect(ui.buttons.get(sync)!.disabled).toBe(false);
    });

    it('Обработчик первого проекта не действует после A→B→A', async () => {
        vi.mocked(bridgeApi.create).mockResolvedValue(job('accepted')); render(); const old = ui.buttons.get(sync)!.onClick;
        ui.projectId = 'project-b'; render(); ui.projectId = 'project-a'; render(); old(); await flush();
        expect(bridgeApi.create).not.toHaveBeenCalled();
    });
});
