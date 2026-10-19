import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {message} from 'antd';
import bffApi from '../src/core/api/bff';
import type {IRagQuota} from '../src/core/api/interfaces';
import RagQuotaPanel from '../src/modules/Projects/features/RagQuota/RagQuotaPanel';
import {useRagQuota} from '../src/modules/Projects/features/RagQuota/useRagQuota';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; dependencies?: unknown[]; cleanup?: () => void}> = [];
    const effects: Array<() => void> = [];
    const writes: unknown[] = [];
    const same = (left?: unknown[], right?: unknown[]) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
    const memo = (factory: () => unknown, dependencies: unknown[]) => {
        const index = cursor++, previous = slots[index];
        if (!previous || !same(previous.dependencies, dependencies)) slots[index] = {value: factory(), dependencies};
        return slots[index].value;
    };
    return {
        writes,
        begin: () => { cursor = 0; },
        commit: () => { effects.splice(0).forEach(effect => effect()); },
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T) {
            const slot = slots[cursor++] ??= {value: initial};
            return [slot.value, (next: T | ((previous: T) => T)) => {
                slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next;
                writes.push(slot.value);
            }];
        },
        useRef<T>(initial: T) { return (slots[cursor++] ??= {value: {current: initial}}).value; },
        useMemo: memo,
        useCallback: (callback: unknown, dependencies: unknown[]) => memo(() => callback, dependencies),
        useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous && same(previous.dependencies, dependencies)) return;
            const slot = slots[index] = {dependencies};
            effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});
interface ButtonProps {children?: ReactNode; loading?: boolean; disabled?: boolean; onClick?: () => void;}
const ui = vi.hoisted(() => ({
    owner: 'admin', owners: new Map<string, () => () => boolean>(),
    buttons: new Map<string, ButtonProps>(), errors: [] as string[],
    submit: undefined as undefined | ((values: {limitMiB: number}) => void),
    change: undefined as undefined | (() => void), sectionRefresh: undefined as undefined | (() => void),
    form: {setFieldsValue: vi.fn(), values: {} as {limitMiB?: number}},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
    useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo, useCallback: hooks.useCallback, useEffect: hooks.useEffect,
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    if (!ui.owners.has(ui.owner)) { const owner = ui.owner; ui.owners.set(owner, () => () => owner === ui.owner); }
    return {scope: ui.owner, captureOwner: ui.owners.get(ui.owner)!};
}}));
vi.mock('../src/core/api/bff', () => ({default: {getRagQuota: vi.fn(), updateRagQuota: vi.fn()}}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: (_sections: unknown, callback: () => void) => { ui.sectionRefresh = callback; }}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {
        Alert: ({type, description}: {type?: string; description?: string}) => { if (type === 'error' && description) ui.errors.push(description); return null; },
        Button: (props: ButtonProps) => { ui.buttons.set(String(props.children), props); return null; },
        Card: ({children, extra}: {children?: ReactNode; extra?: ReactNode}) => createElement('div', null, extra, children),
        Col: content, Row: content, Space: content, Tag: content, InputNumber: () => null, Progress: () => null, Spin: () => null,
        Typography: {Text: content, Paragraph: content, Title: content}, message: {success: vi.fn()},
        Form: Object.assign(({children, onFinish, onValuesChange}: {children?: ReactNode; onFinish: typeof ui.submit; onValuesChange: typeof ui.change}) => {
            ui.submit = onFinish; ui.change = onValuesChange; return children;
        }, {Item: content, useForm: () => [ui.form]}),
    };
});

const MiB = 1024 ** 2;
const quota = (limitMiB = 1, revision = 2): IRagQuota => ({usedBytes: 1024, limitBytes: limitMiB * MiB,
    availableBytes: limitMiB * MiB - 1024, maximumBytes: 100 * MiB, revision});
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return {promise, resolve, reject};
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function render(project = 'prj-a') {
    hooks.begin(); ui.buttons.clear(); ui.errors = [];
    renderToStaticMarkup(createElement(RagQuotaPanel, {projectKey: project})); hooks.commit();
}
function renderHook(project = 'prj-a') {
    hooks.begin(); const value = useRagQuota(project); hooks.commit(); return value;
}
async function ready(project = 'prj-a') { render(project); await flush(); render(project); }
function edit(limitMiB: number) { ui.form.values = {limitMiB}; ui.change!(); }

beforeEach(() => {
    vi.resetAllMocks(); ui.owner = 'admin'; ui.owners.clear(); ui.form.values = {}; ui.submit = undefined; ui.change = undefined;
    hooks.writes.length = 0;
    ui.form.setFieldsValue.mockImplementation(values => { ui.form.values = {...ui.form.values, ...values}; });
    vi.mocked(bffApi.getRagQuota).mockImplementation(async project => project === 'prj-b' ? quota(8, 10) : quota());
    vi.mocked(bffApi.updateRagQuota).mockResolvedValue(quota(2, 3));
});
afterEach(() => hooks.dispose());

describe('Изменение квоты принадлежит странице проекта и её владельцу', () => {
    it.each(['unmount', 'role'] as const)('Позднее сохранение после %s не уведомляет и не перечитывает старый проект', async change => {
        await ready(); const response = deferred<IRagQuota>(); vi.mocked(bffApi.updateRagQuota).mockReturnValue(response.promise);
        edit(2); ui.submit!({limitMiB: 2}); vi.mocked(bffApi.getRagQuota).mockClear();
        if (change === 'unmount') hooks.dispose(); else ui.owner = 'observer';
        response.resolve(quota(2, 3)); await flush();
        expect(message.success).not.toHaveBeenCalled(); expect(bffApi.getRagQuota).not.toHaveBeenCalled();
    });

    it('Смена проекта допускает новый PATCH, а старое завершение не снимает его занятость', async () => {
        await ready(); const old = deferred<IRagQuota>(), fresh = deferred<IRagQuota>();
        vi.mocked(bffApi.updateRagQuota).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        edit(2); ui.submit!({limitMiB: 2}); await ready('prj-b');
        expect(ui.form.values.limitMiB).toBe(8);
        edit(9); ui.submit!({limitMiB: 9});
        expect(bffApi.updateRagQuota).toHaveBeenLastCalledWith('prj-b', {limitBytes: 9 * MiB, expectedRevision: 10});
        old.resolve(quota(2, 3)); await flush(); render('prj-b');
        expect(ui.buttons.get('Сохранить лимит')!.loading).toBe(true); expect(message.success).not.toHaveBeenCalled();
        fresh.resolve(quota(9, 11)); await flush(); render('prj-b');
        expect(ui.buttons.get('Сохранить лимит')!.loading).toBe(false); expect(message.success).toHaveBeenCalledOnce();
    });

    it('Поздний отказ прежней роли не меняет ошибку новой формы, текущий запрос можно повторить', async () => {
        await ready(); const response = deferred<IRagQuota>(); vi.mocked(bffApi.updateRagQuota).mockReturnValueOnce(response.promise);
        edit(2); ui.submit!({limitMiB: 2}); ui.owner = 'another-admin'; await ready();
        response.reject(new Error('Отказ прежней роли')); await flush(); render();
        expect(ui.errors).toEqual([]); edit(2); ui.submit!({limitMiB: 2}); await flush();
        expect(bffApi.updateRagQuota).toHaveBeenCalledTimes(2); expect(message.success).toHaveBeenCalledOnce();
    });

    it('Старые review, refresh и accept после cleanup не отправляют запросы и не меняют состояние', async () => {
        await ready(); const review = ui.buttons.get('Обновить сведения')!.onClick!;
        hooks.dispose(); vi.mocked(bffApi.getRagQuota).mockClear(); review(); await flush();
        expect(bffApi.getRagQuota).not.toHaveBeenCalled();
        hooks.dispose(); const stale = renderHook(); await flush(); renderHook(); hooks.dispose();
        vi.mocked(bffApi.getRagQuota).mockClear(); const before = hooks.writes.length;
        stale.accept(quota(2, 3)); await stale.refresh();
        expect(hooks.writes).toHaveLength(before); expect(bffApi.getRagQuota).not.toHaveBeenCalled();
    });

    it.each(['project', 'role'] as const)('Поздний GET не меняет текущую квоту после смены %s', async change => {
        const old = deferred<IRagQuota>(); vi.mocked(bffApi.getRagQuota).mockReturnValueOnce(old.promise);
        const stale = renderHook(), project = change === 'project' ? 'prj-b' : 'prj-a';
        if (change === 'role') ui.owner = 'another-admin';
        renderHook(project); await flush();
        old.resolve(quota(99, 99)); await flush();
        const expected = project === 'prj-b' ? quota(8, 10) : quota();
        expect(renderHook(project).quota).toEqual(expected);
        const count = vi.mocked(bffApi.getRagQuota).mock.calls.length;
        await stale.refresh(); stale.accept(quota(99, 99));
        expect(bffApi.getRagQuota).toHaveBeenCalledTimes(count); expect(renderHook(project).quota).toEqual(expected);
    });

    it('Текущая вкладка может повторить чтение после сетевого отказа', async () => {
        vi.mocked(bffApi.getRagQuota).mockRejectedValueOnce(new Error('Сервер временно недоступен'));
        const current = renderHook(); await flush();
        expect(renderHook()).toMatchObject({quota: null, loading: false, error: 'Сервер временно недоступен'});
        await current.refresh();
        expect(renderHook()).toMatchObject({quota: quota(), loading: false, error: ''});
    });

    it('Фоновое чтение сохраняет черновик и CAS; явный review разрешает повтор после конфликта', async () => {
        await ready(); edit(2);
        vi.mocked(bffApi.getRagQuota).mockResolvedValue(quota(3, 4)); ui.sectionRefresh!(); await flush(); render();
        expect(ui.form.values.limitMiB).toBe(2);
        vi.mocked(bffApi.updateRagQuota).mockRejectedValueOnce(new Error('Лимит изменён другим администратором'));
        ui.submit!({limitMiB: 2}); await flush(); render();
        expect(bffApi.updateRagQuota).toHaveBeenLastCalledWith('prj-a', {limitBytes: 2 * MiB, expectedRevision: 2});
        expect(ui.errors.join()).toContain('другим администратором');
        ui.buttons.get('Обновить сведения')!.onClick!(); await flush(); render();
        expect(ui.form.values.limitMiB).toBe(2); expect(ui.errors).toEqual([]);
        vi.mocked(bffApi.updateRagQuota).mockResolvedValueOnce(quota(2, 5)); ui.submit!({limitMiB: 2}); await flush();
        expect(bffApi.updateRagQuota).toHaveBeenLastCalledWith('prj-a', {limitBytes: 2 * MiB, expectedRevision: 4});
        expect(message.success).toHaveBeenCalledOnce();
    });
});
