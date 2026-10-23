import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useBridgeSourceDraft} from '../src/modules/Settings/useBridgeSourceDraft';
import type {IBridgeSource} from '../src/features/McpBridge/bridgeSource';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    return {begin: () => { cursor = 0; }, commit: () => effects.splice(0).forEach(run => run()),
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T) { const slot = slots[cursor++] ??= {value: initial}; return [slot.value, (next: T | ((previous: T) => T)) => { slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next; }]; },
        useRef<T>(initial?: T) { return (slots[cursor++] ??= {value: {current: initial}}).value; },
        useCallback<T>(callback: T, deps: unknown[]) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = {value: callback, deps}; return slots[index].value; },
        useEffect(effect: () => void | (() => void), deps: unknown[]) { const index = cursor++, old = slots[index]; if (old && same(old.deps, deps)) return; const slot = slots[index] = {deps}; effects.push(() => { old?.cleanup?.(); slot.cleanup = effect() || undefined; }); },
    };
});
const io = vi.hoisted(() => ({scope: 'admin', owners: new Map<string, () => () => boolean>(), get: vi.fn(), save: vi.fn(), check: vi.fn()}));
vi.mock('react', () => ({useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useCallback: hooks.useCallback}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    if (!io.owners.has(io.scope)) { const scope = io.scope; io.owners.set(scope, () => () => io.scope === scope); }
    return {scope: io.scope, captureOwner: io.owners.get(io.scope)!};
}}));
vi.mock('../src/features/McpBridge/bridgeSource', async original => ({...await original<typeof import('../src/features/McpBridge/bridgeSource')>(), bridgeSourceApi: {get: io.get, save: io.save, check: io.check}}));
const initial: IBridgeSource = {url: 'https://github.com/owner/assets', revision: 1};
const mine = 'https://github.com/my-company/assets', theirs = 'https://github.com/other-admin/assets';
const flush = async () => { for (let index = 0; index < 18; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function render() { hooks.begin(); const view = useBridgeSourceDraft(); hooks.commit(); return view; }
async function open() { render(); await flush(); render(); return render(); }
beforeEach(() => { vi.resetAllMocks(); io.scope = 'admin'; io.owners.clear(); io.get.mockResolvedValue(initial); io.save.mockResolvedValue({...initial, url: mine, revision: 2}); io.check.mockResolvedValue(initial); });
afterEach(() => hooks.dispose());

describe('Настройка источника сохраняет адрес и требует решения при CAS', () => {
    it('Открывает сохранённый URL без проверки внешнего GitHub', async () => {
        expect(await open()).toMatchObject({url: initial.url, changed: false, stale: false, blocked: false});
        expect(io.get).toHaveBeenCalledOnce(); expect(io.check).not.toHaveBeenCalled(); expect(io.save).not.toHaveBeenCalled();
    });
    it('Не стирает введённый URL после отказа сохранения и разрешает повтор с прежней ревизией', async () => {
        (await open()).change(mine); io.save.mockRejectedValue(new Error('Сеть недоступна'));
        await render().saveDraft(); await flush();
        expect(render()).toMatchObject({url: mine, error: 'Сеть недоступна', changed: true, stale: false});
        expect(io.save).toHaveBeenCalledWith(mine, 1, expect.any(AbortSignal));
        await render().saveDraft(); expect(io.save).toHaveBeenCalledTimes(2); expect(io.save.mock.calls[1][1]).toBe(1);
    });
    it('409 читает актуальный источник, сохраняет мой URL и не перезаписывает чужую ревизию повтором', async () => {
        (await open()).change(mine); io.get.mockResolvedValue({url: theirs, revision: 4}); io.save.mockRejectedValue({response: {status: 409, data: {message: 'Источник изменён'}}});
        await render().saveDraft(); await flush();
        expect(render()).toMatchObject({url: mine, stale: true, data: {url: theirs, revision: 4}});
        await render().saveDraft(); expect(io.save).toHaveBeenCalledOnce();
        render().keepDraft(); expect(render()).toMatchObject({url: mine, stale: false, changed: true});
        await render().saveDraft(); expect(io.save.mock.calls[1].slice(0, 2)).toEqual([mine, 4]);
    });
    it('Явное принятие актуального адреса меняет только поле, без PUT и импорта', async () => {
        (await open()).change(mine); io.get.mockResolvedValue({url: theirs, revision: 4});
        await render().reload(); render(); expect(render()).toMatchObject({url: mine, stale: true});
        render().acceptCurrent(); expect(render()).toMatchObject({url: theirs, stale: false, changed: false}); expect(io.save).not.toHaveBeenCalled();
    });
    it('Потерянный ACK с уже сохранённым адресом не делает второй PUT автоматически', async () => {
        (await open()).change(mine); io.get.mockResolvedValue({url: mine, revision: 2}); io.save.mockRejectedValue(new Error('Ответ потерян'));
        await render().saveDraft(); await flush(); expect(render()).toMatchObject({url: mine, stale: true, error: 'Ответ потерян'});
        await render().saveDraft(); expect(io.save).toHaveBeenCalledOnce(); render().acceptCurrent();
        expect(render()).toMatchObject({url: mine, changed: false, stale: false}); expect(io.check).not.toHaveBeenCalled();
    });
    it('Успешный save использует серверный URL и ревизию, не обещает импорт новой версии', async () => {
        (await open()).change(' ' + mine + ' '); io.save.mockResolvedValue({url: mine, revision: 8});
        await render().saveDraft(); render(); expect(render()).toMatchObject({url: mine, changed: false, stale: false, data: {revision: 8}});
        expect(io.check).not.toHaveBeenCalled();
    });
    it('Обновление снимка подхватывает новый URL только если пользователь ещё не правил поле', async () => {
        await open(); io.get.mockResolvedValue({url: theirs, revision: 3}); await render().reload(); render();
        expect(render()).toMatchObject({url: theirs, changed: false, stale: false});
        render().change(mine); io.get.mockResolvedValue({url: initial.url, revision: 4}); await render().reload(); render();
        expect(render()).toMatchObject({url: mine, changed: true, stale: true});
    });
    it('Во время сохранения блокирует изменение поля и повторное сохранение', async () => {
        (await open()).change(mine); const pending = deferred<IBridgeSource>(); io.save.mockReturnValue(pending.promise);
        const saving = render().saveDraft(); render().change(theirs); await render().saveDraft();
        expect(render()).toMatchObject({url: mine, blocked: true}); expect(io.save).toHaveBeenCalledOnce();
        pending.resolve({url: mine, revision: 2}); await saving; render(); expect(render().url).toBe(mine);
    });
    it('Закрытие формы прерывает сохранение и не делает восстановительный запрос после позднего отказа', async () => {
        (await open()).change(mine); const pending = deferred<IBridgeSource>(); io.save.mockReturnValue(pending.promise);
        const saving = render().saveDraft(), signal = io.save.mock.calls[0][2] as AbortSignal;
        hooks.dispose(); expect(signal.aborted).toBe(true); pending.reject(new Error('Поздний отказ')); await saving;
        expect(io.get).toHaveBeenCalledOnce();
    });
});
