import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';
import { useModelHosting } from '../src/features/ModelCatalog/useModelHosting';
import type { ICatalogModel, IModelHosting } from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({ current: true, stateIndex: 0, writes: [] as unknown[], effects: [] as Array<() => void | (() => void)>,
    initial: new Map<number, unknown>(), hook: null as ReturnType<typeof useModelHosting> | null }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => {
        const index = ui.stateIndex++;
        return [ui.initial.has(index) ? ui.initial.get(index) : initial, (value: unknown) => { ui.writes.push(value); }];
    },
    useEffect: (effect: () => void | (() => void)) => { ui.effects.push(effect); },
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => ui.current }) }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: { hosting: vi.fn(), operate: vi.fn() } }));
const model = { id: 'model-a', revision: 1 } as ICatalogModel;
const busy = { state: 'busy', message: 'Загружаем', checkedAt: null, operation: { state: 'running' } } as IModelHosting;
const ready = { state: 'ready', message: 'Проверка пройдена', checkedAt: '2026-10-19T01:00:00Z' } as IModelHosting;
function Probe() { ui.hook = useModelHosting(model); return null; }
const render = () => renderToStaticMarkup(createElement(Probe));
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function deferred() {
    let resolve!: (value: IModelHosting) => void, reject!: (value: unknown) => void;
    const promise = new Promise<IModelHosting>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.clearAllMocks(); ui.current = true; ui.stateIndex = 0; ui.writes = []; ui.effects = []; ui.initial.clear(); ui.hook = null;
    vi.mocked(modelCatalogApi.hosting).mockResolvedValue(ready);
});
afterEach(() => vi.useRealTimers());

describe('Операции хостинга принадлежат исходной сессии', () => {
    it('Повтор setup после cleanup в StrictMode не теряет проверку при незавершённом запросе', async () => {
        render();
        const first = deferred(), second = deferred();
        vi.mocked(modelCatalogApi.hosting).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const cleanup = ui.effects[0]();
        expect(modelCatalogApi.hosting).toHaveBeenCalledOnce();
        cleanup?.();
        const cleanupAgain = ui.effects[0]();
        expect(modelCatalogApi.hosting).toHaveBeenCalledOnce();
        first.resolve(ready); await flush();
        expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(2);
        expect(ui.writes).not.toContain(ready);
        const current = { ...ready, message: 'Актуальная проверка' };
        second.resolve(current); await flush();
        expect(ui.writes).toContain(current);
        expect(ui.writes.at(-1)).toBe(false);
        cleanupAgain?.();
    });
    it('Очередь проверки не запускает чтение после потери владельца', async () => {
        render(); const pending = deferred(); vi.mocked(modelCatalogApi.hosting).mockReturnValue(pending.promise);
        const cleanup = ui.effects[0](); cleanup?.(); const cleanupAgain = ui.effects[0]();
        const before = ui.writes.length; ui.current = false; pending.resolve(ready); await flush();
        expect(modelCatalogApi.hosting).toHaveBeenCalledOnce(); expect(ui.writes).toHaveLength(before);
        cleanupAgain?.();
    });
    it('Cleanup удаляет отложенное чтение без запроса после закрытия карточки', async () => {
        render(); const pending = deferred(); vi.mocked(modelCatalogApi.hosting).mockReturnValue(pending.promise);
        const cleanup = ui.effects[0](); await ui.hook!.refresh(); const before = ui.writes.length;
        cleanup?.(); pending.resolve(ready); await flush();
        expect(modelCatalogApi.hosting).toHaveBeenCalledOnce(); expect(ui.writes).toHaveLength(before);
    });
    it.each(['success', 'failure'] as const)('Поздний %s не обновляет карточку другого владельца', async outcome => {
        render();
        const pending = deferred(); vi.mocked(modelCatalogApi.operate).mockReturnValue(pending.promise);
        const first = ui.hook!.operate('start');
        await ui.hook!.operate('start');
        expect(modelCatalogApi.operate).toHaveBeenCalledOnce();
        const before = ui.writes.length; ui.current = false;
        if (outcome === 'success') pending.resolve(busy); else pending.reject(new Error('Отказ'));
        await first;
        expect(ui.writes).toHaveLength(before);
    });
    it('Ошибка чтения не останавливает обновления выполняющейся операции', async () => {
        vi.useFakeTimers(); ui.initial.set(0, busy); render();
        vi.mocked(modelCatalogApi.hosting).mockRejectedValueOnce(new Error('Нет связи')).mockResolvedValue(ready);
        const cleanups = ui.effects.map(effect => effect());
        await flush();
        expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(2);
        expect(ui.writes).toContain(ready);
        cleanups.forEach(cleanup => cleanup?.());
        await vi.advanceTimersByTimeAsync(4000);
        expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(2);
    });
    it('Повторный опрос не запускает параллельные медленные запросы', async () => {
        vi.useFakeTimers(); ui.initial.set(0, busy); render();
        const pending = deferred(); vi.mocked(modelCatalogApi.hosting).mockReturnValue(pending.promise);
        const cleanups = ui.effects.map(effect => effect());
        await vi.advanceTimersByTimeAsync(6000);
        expect(modelCatalogApi.hosting).toHaveBeenCalledOnce();
        pending.resolve(ready); await flush();
        cleanups.forEach(cleanup => cleanup?.());
    });
});
