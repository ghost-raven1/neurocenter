import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeApi, type IBridgeJob, type IBridgeJobDraft } from '../src/features/McpBridge/api';
import { useLocalJob } from '../src/features/McpBridge/useLocalJob';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{ value?: unknown; dependencies?: unknown[]; cleanup?: () => void }> = [];
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

vi.mock('react', () => ({useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect}));
vi.mock('../src/features/McpBridge/api', () => ({bridgeApi: {create: vi.fn()}}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return {promise, resolve, reject};
}

const input: IBridgeJobDraft = {
    kind: 'prepare-bind-project', deviceId: 'device', projectId: 'project', folderName: 'Мой проект', bindingMode: 'new',
};
const job: IBridgeJob = {
    id: 'check-folder', deviceId: input.deviceId, projectId: input.projectId!, kind: input.kind,
    state: 'queued', message: 'Ожидает мост', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z',
};

function setup(reload = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
    const bridge = {jobs: [] as IBridgeJob[], reload} as unknown as Parameters<typeof useLocalJob>[0];
    const render = () => {
        hooks.begin();
        const operation = useLocalJob(bridge);
        hooks.commit();
        return operation;
    };
    return {bridge, render};
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(bridgeApi.create).mockResolvedValue(job); });
afterEach(() => { hooks.dispose(); vi.restoreAllMocks(); });

describe('Отправка локального задания не ждёт фонового чтения списков', () => {
    it('Отказ генерации ключа показывает причину и освобождает действие для повторной отправки', async () => {
        vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => { throw new TypeError('crypto.randomUUID unavailable'); });
        const {render} = setup();
        await expect(render().submit(input)).resolves.toBeUndefined();
        expect(render()).toMatchObject({busy: false});
        expect(render().error).toMatch(/Не удалось подготовить запрос к мосту/);
        expect(render().error).not.toContain('crypto');
        expect(bridgeApi.create).not.toHaveBeenCalled();
        expect(await render().submit(input)).toBe(job);
        expect(render()).toMatchObject({busy: false, error: '', job});
        expect(bridgeApi.create).toHaveBeenCalledOnce();
    });

    it('Возвращает созданное задание и снимает занятость, пока перечитывание ещё ожидает ответ', async () => {
        const refresh = deferred<void>();
        const reload = vi.fn(() => refresh.promise);
        const {render} = setup(reload);
        let received: IBridgeJob | undefined;
        void render().submit(input).then(result => { received = result; });
        try {
            await vi.waitFor(() => expect(received).toBe(job));
            expect(reload).toHaveBeenCalledOnce();
            expect(render()).toMatchObject({busy: false, job});
        } finally { refresh.resolve(); }
    });

    it('Ошибка перечитывания не отменяет успешную отправку и не удерживает блокировку', async () => {
        const refresh = deferred<void>();
        const {render} = setup(vi.fn(() => refresh.promise));
        const submitted = render().submit(input);
        await vi.waitFor(() => expect(bridgeApi.create).toHaveBeenCalledOnce());
        refresh.reject(new Error('Не удалось перечитать установки'));
        expect(await submitted).toBe(job);
        expect(render()).toMatchObject({busy: false, job});
    });

    it('Двойное нажатие до ответа сервера создаёт только одно задание', async () => {
        const response = deferred<IBridgeJob>();
        vi.mocked(bridgeApi.create).mockReturnValue(response.promise);
        const {render} = setup();
        const first = render().submit(input);
        expect(render().busy).toBe(true);
        expect(await render().submit(input)).toBeUndefined();
        expect(bridgeApi.create).toHaveBeenCalledOnce();
        response.resolve(job);
        expect(await first).toBe(job);
        expect(render().busy).toBe(false);
    });

    it('После сетевого сбоя повторяет прежний ключ, после подтверждённого создания выдаёт новый', async () => {
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Соединение прервано'));
        const {render} = setup();
        expect(await render().submit(input)).toBeUndefined();
        expect(render()).toMatchObject({busy: false, error: 'Соединение прервано'});
        expect(await render().submit(input)).toBe(job);
        expect(await render().submit(input)).toBe(job);
        const keys = vi.mocked(bridgeApi.create).mock.calls.map(([request]) => request.requestKey);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[1]);
    });

    it('Принятый POST сохраняет результат, а свежая очередь обновляет его состояние', async () => {
        const {bridge, render} = setup();
        expect(await render().submit(input)).toBe(job);
        expect(render().job).toBe(job);
        const completed = {...job, state: 'succeeded', message: 'Папка проверена'};
        bridge.jobs = [completed];
        expect(render().job).toBe(completed);
    });
});
