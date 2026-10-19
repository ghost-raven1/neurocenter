import { describe, expect, it, vi } from 'vitest';
import type { IBridgeJob } from '../src/features/McpBridge/api';
import { createRagUiLaunchController, type IRagUiLaunchState } from '../src/features/McpBridge/ragUi/ragUiLaunchController';
import { ragUiRequest } from '../src/features/McpBridge/ragUi/ragUiState';
import { ragUiFixture } from './ragUiFixture';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (failure: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function harness() {
    const fixture = ragUiFixture(), draft = ragUiRequest(fixture.item, fixture.binding);
    const state = { scope: 'owner:folder', owner: true, writes: [] as IRagUiLaunchState[] };
    const create = vi.fn(async () => fixture.job()), reload = vi.fn(async () => undefined);
    let key = 0;
    const controller = createRagUiLaunchController({ getScope: () => state.scope, captureOwner: () => () => state.owner,
        create, reload, newKey: () => `request-${++key}`, onChange: next => state.writes.push(next) });
    controller.activate();
    return { ...fixture, draft, state, create, reload, controller, last: () => state.writes.at(-1)! };
}

describe('Запуск окна OpenCodeRAG принадлежит исходной сессии и папке', () => {
    it('Двойное нажатие отправляет одно задание, ответ сразу освобождает кнопку без ожидания reload', async () => {
        const h = harness(), post = deferred<IBridgeJob>(), refresh = deferred<void>();
        h.create.mockReturnValue(post.promise); h.reload.mockReturnValue(refresh.promise);
        const first = h.controller.submit(h.draft); await h.controller.submit(h.draft);
        expect(h.create).toHaveBeenCalledOnce(); expect(h.last().busy).toBe(true); expect(h.last().submitted).toBeUndefined();
        post.resolve(h.job()); await first;
        expect(h.last()).toMatchObject({ busy: false, error: '', submitted: { id: 'job-one', state: 'queued' } });
        expect(h.reload).toHaveBeenCalledOnce(); refresh.resolve();
    });
    it('После неизвестного исхода POST повторяет тот же ключ без второго запроса окна', async () => {
        const h = harness(); h.create.mockRejectedValueOnce(new Error('Связь оборвалась'));
        await h.controller.submit(h.draft);
        expect(h.last().error).toContain('Связь оборвалась'); expect(h.last().submitted).toBeUndefined();
        await h.controller.submit(h.draft);
        expect(h.create.mock.calls.map(([input]) => input.requestKey)).toEqual(['request-1', 'request-1']);
        expect(h.last().error).toBe(''); expect(h.last().submitted?.id).toBe('job-one');
    });
    it('После подтверждённого отказа моста повтор получает новый ключ', async () => {
        const h = harness(); h.create.mockResolvedValueOnce(h.job({ state: 'failed', message: 'Нет браузера' }));
        await h.controller.submit(h.draft); await h.controller.submit(h.draft);
        expect(h.create.mock.calls.map(([input]) => input.requestKey)).toEqual(['request-1', 'request-2']);
    });
    it.each(['expectedManifest', 'expectedInstanceId', 'bindingId', 'assetId'] as const)('Несовпадение %s не подтверждает запуск и сохраняет ключ повторной проверки', async field => {
        const h = harness(); h.create.mockResolvedValueOnce(h.job({ [field]: 'другая-установка' }));
        await h.controller.submit(h.draft);
        expect(h.last().error).toContain('выбранной установки'); expect(h.last().submitted).toBeUndefined(); expect(h.reload).not.toHaveBeenCalled();
        await h.controller.submit(h.draft);
        expect(h.create.mock.calls.map(([input]) => input.requestKey)).toEqual(['request-1', 'request-1']);
    });
    it.each(['success', 'failure'] as const)('Поздний %s после отзыва роли не меняет экран и не запускает reload', async outcome => {
        const h = harness(), post = deferred<IBridgeJob>(); h.create.mockReturnValue(post.promise);
        const pending = h.controller.submit(h.draft), writes = h.state.writes.length; h.state.owner = false;
        if (outcome === 'success') post.resolve(h.job()); else post.reject(new Error('Отказ'));
        await pending; expect(h.state.writes).toHaveLength(writes); expect(h.reload).not.toHaveBeenCalled();
    });
    it.each(['folder', 'unmount'] as const)('Смена %s скрывает результат предыдущего запроса', async change => {
        const h = harness(), post = deferred<IBridgeJob>(); h.create.mockReturnValue(post.promise);
        const pending = h.controller.submit(h.draft);
        if (change === 'folder') h.state.scope = 'owner:other-folder'; else h.controller.dispose();
        const writes = h.state.writes.length; post.resolve(h.job()); await pending;
        expect(h.state.writes).toHaveLength(writes); expect(h.reload).not.toHaveBeenCalled();
    });
    it('StrictMode setup → cleanup → setup сохраняет новую блокировку и ключ при позднем первом ответе', async () => {
        const h = harness(), old = deferred<IBridgeJob>(), fresh = deferred<IBridgeJob>();
        h.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        const first = h.controller.submit(h.draft); h.controller.dispose(); h.controller.activate();
        const second = h.controller.submit(h.draft);
        old.resolve(h.job()); await first;
        expect(h.last()).toMatchObject({ busy: true, error: '' }); expect(h.last().submitted).toBeUndefined();
        await h.controller.submit(h.draft); expect(h.create).toHaveBeenCalledTimes(2);
        fresh.reject(new Error('Неизвестен итог')); await second;
        await h.controller.submit(h.draft);
        expect(h.create.mock.calls.map(([input]) => input.requestKey)).toEqual(['request-1', 'request-1', 'request-1']);
        expect(h.last().busy).toBe(false); expect(h.last().submitted?.id).toBe('job-one');
    });
    it('Ошибка перечитывания не теряет принятое задание и предлагает обновление', async () => {
        const h = harness(); h.reload.mockRejectedValue(new Error('Нет связи'));
        await h.controller.submit(h.draft); await Promise.resolve();
        expect(h.last()).toMatchObject({ busy: false, submitted: { id: 'job-one' } });
        expect(h.last().error).toContain('Задание принято');
    });
});
