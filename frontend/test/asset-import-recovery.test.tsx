// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useAssetImports} from '../src/features/AssetSources/useAssetImports';
import {AssetImportRecovery} from '../src/features/AssetSources/AssetImportRecovery';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys, type IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import {availableSourceAssetIds} from '../src/features/AssetSources/archiveUpload';
import type {IAssetImport, ISourceAsset} from '../src/features/AssetSources/types';

const io = vi.hoisted(() => ({scope: 'admin-a', enabled: true, get: vi.fn(), post: vi.fn(), complete: vi.fn(), selection: vi.fn()}));
vi.mock('../src/core/api', () => ({baseApi: {get: io.get, post: io.post}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', async () => {
    const {useLayoutEffect, useMemo} = await import('react');
    const {createAuthRequestOwner} = await import('../src/features/UserBlock/authRequestOwner');
    return {useAuthRequestOwner: () => {
        const scope = io.scope, owner = useMemo(() => createAuthRequestOwner(scope, () => io.scope), [scope]);
        useLayoutEffect(() => {owner.activate(); return () => owner.dispose();}, [owner]);
        return {scope, captureOwner: owner.captureOwner};
    }};
});

const commit = 'a'.repeat(40), requestKey = '11111111-1111-4111-8111-111111111111';
const job: IAssetImport = {id: '22222222-2222-4222-8222-222222222222', state: 'SUCCEEDED', message: 'Готово', planDigest: 'b'.repeat(64), items: []};
const rejected = (status: number) => ({isAxiosError: true, response: {status, data: {message: 'Запрос отклонён'}}});
const key = () => 'asset-import:' + encodeURIComponent(io.scope);
let root: Root, container: HTMLDivElement, current: ReturnType<typeof useAssetImports>;
function Host() {
    current = useAssetImports(io.complete);
    const policy = {
        flags: Object.fromEntries(featureFlagKeys.map(key => [key, io.enabled])),
        configured: Object.fromEntries(featureFlagKeys.map(key => [key, io.enabled])),
        blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []])),
    } as IEvaluatedFeatureFlags;
    return <FeatureAvailabilityContext.Provider value={{data: policy, loading: false, error: null, refresh: async () => undefined}}>
        <button disabled={current.blocked} onClick={() => void current.start(['old'], commit)}>Добавить</button>
        <AssetImportRecovery imports={current} onChangeSelection={io.selection}/>
    </FeatureAvailabilityContext.Provider>;
}
const render = () => act(async () => {root.render(createElement(Host));});
const run = (action: () => unknown) => act(async () => {await action();});
const saved = () => JSON.parse(localStorage.getItem(key()) ?? 'null');
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent === name);
const click = (name: string) => run(() => {expect(button(name)).toBeDefined(); button(name)!.click();});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
async function reload() {await act(async () => root.unmount()); root = createRoot(container); await render();}

beforeEach(async () => {
    vi.clearAllMocks(); io.scope = 'admin-a'; io.enabled = true; localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    io.get.mockRejectedValue(rejected(404)); io.post.mockResolvedValue({data: job});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); await render();
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('Восстановление импорта ассетов без потери неизвестного результата', () => {
    it.each([400, 403, 409])('Явный отказ первой попытки HTTP %s позволяет изменить выбор', async status => {
        io.post.mockRejectedValueOnce(rejected(status)); await run(() => current.start(['old'], commit));
        expect(current.error).toContain('Запрос отклонён');
        expect(current.canReset).toBe(true);
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('Импорт не создан.');
        await click('Изменить выбор');
        expect(io.selection).toHaveBeenCalledWith(['old']);
        expect(container.querySelector('button')!.disabled).toBe(false); expect(saved()).toBeNull();
        await run(() => current.start(['new'], commit));
        expect(io.post.mock.calls[1][1].ids).toEqual(['new']);
        expect(io.post.mock.calls[1][1].requestKey).not.toBe(io.post.mock.calls[0][1].requestKey);
    });

    it('Reload сохраняет подтверждённый отказ без автоматического POST', async () => {
        io.post.mockRejectedValueOnce(rejected(409)); await run(() => current.start(['old'], commit));
        await reload(); expect(current.canReset).toBe(true); expect(io.post).toHaveBeenCalledTimes(1);
        await click('Изменить выбор'); expect(saved()).toBeNull(); expect(current.blocked).toBe(false);
        expect(io.selection).toHaveBeenCalledWith(['old']);
    });

    it.each([400, 403, 409])('Потеря ACK остаётся неопределённой после HTTP %s, GET404 и reload', async status => {
        io.post.mockRejectedValueOnce(new Error('ACK lost')).mockRejectedValueOnce(rejected(status));
        await run(() => current.start(['old'], commit)); const original = saved();
        await run(() => current.repeat()); await reload();
        expect(io.get).toHaveBeenCalledWith('/api/asset-imports/by-request/' + original.requestKey);
        expect(current.canReset).toBe(false); expect(current.blocked).toBe(true);
        expect(button('Изменить выбор')).toBeUndefined(); expect(button('Проверить состояние')?.disabled).toBe(false);
        await run(() => current.clear()); expect(saved()?.requestKey).toBe(original.requestKey);
        await run(() => current.start(['new'], 'c'.repeat(40)));
        expect(io.post.mock.calls[2][1]).toEqual(io.post.mock.calls[0][1]);
    });

    it('Старый сохранённый intent без признака отказа считается неопределённым', async () => {
        localStorage.setItem(key(), JSON.stringify({requestKey, commit, ids: ['old']}));
        await reload(); expect(io.post).not.toHaveBeenCalled(); expect(current.canReset).toBe(false);
        await run(() => current.clear()); expect(saved()?.requestKey).toBe(requestKey);
    });

    it('Прежний завершённый job не скрывает неопределённый результат следующего POST', async () => {
        await run(() => current.start(['first'], commit));
        expect(current.job?.id).toBe(job.id);
        io.post.mockRejectedValueOnce(new Error('Second ACK lost')); await run(() => current.start(['second'], commit));
        expect(current.job).toBeUndefined(); expect(current.blocked).toBe(true); expect(current.canReset).toBe(false);
    });

    it('Поздняя попытка прежнего владельца не снимает блокировку текущего запроса', async () => {
        const old = deferred<{data: IAssetImport}>(), next = deferred<{data: IAssetImport}>();
        io.post.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        let oldRequest!: Promise<void>, nextRequest!: Promise<void>;
        await run(() => {oldRequest = current.start(['old'], commit);});
        io.scope = 'admin-b'; await render();
        await run(() => {nextRequest = current.start(['new'], commit);});
        await run(async () => {old.resolve({data: job}); await oldRequest;});
        expect(current.busy).toBe(true); expect(current.job).toBeUndefined(); expect(saved()?.ids).toEqual(['new']);
        await run(() => current.repeat()); expect(io.post).toHaveBeenCalledTimes(2);
        await run(async () => {next.resolve({data: job}); await nextRequest;}); expect(current.job?.id).toBe(job.id);
    });

    it('Проверка после GET404 сохраняет ключ, а найденный job восстанавливается без POST', async () => {
        io.post.mockRejectedValueOnce(new Error('ACK lost')); await click('Добавить'); const original = saved();
        await click('Проверить состояние');
        expect(current.canReset).toBe(false); expect(saved()).toEqual(original);
        io.get.mockResolvedValueOnce({data: job}); await click('Проверить состояние');
        expect(io.post).toHaveBeenCalledTimes(1); expect(current.job?.id).toBe(job.id);
        expect(saved()?.requestKey).toBe(original.requestKey); expect(io.complete).toHaveBeenCalledTimes(1);
        expect(button('Изменить выбор')).toBeUndefined();
        await run(() => current.clear()); expect(current.blocked).toBe(false);
    });

    it('Повтор после подтверждённого отказа снимает marker до POST, reload не разрешает новый выбор', async () => {
        io.post.mockRejectedValueOnce(rejected(409)); await click('Добавить'); const original = saved();
        const pending = deferred<{data: IAssetImport}>(); io.post.mockReturnValueOnce(pending.promise);
        let repeat!: Promise<void>;
        await run(() => {repeat = current.repeat();});
        expect(saved()?.rejected).toBeUndefined(); expect(current.busy).toBe(true);
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('Ждём подтверждения импорта…');
        expect(button('Проверить состояние')?.disabled).toBe(true); expect(button('Повторить запрос')?.disabled).toBe(true);
        await reload(); expect(current.canReset).toBe(false); expect(current.blocked).toBe(true);
        expect(saved()?.requestKey).toBe(original.requestKey); expect(io.post).toHaveBeenCalledTimes(2);
        await run(async () => {pending.resolve({data: job}); await repeat;});
        expect(current.job).toBeUndefined(); expect(current.canReset).toBe(false);
    });

    it('Не отправляет повтор, если запись unknown перед POST недоступна', async () => {
        io.post.mockRejectedValueOnce(rejected(409)); await click('Добавить'); const previous = saved();
        const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new DOMException('Quota exceeded', 'QuotaExceededError');});
        io.post.mockRejectedValueOnce(new Error('ACK lost')); await click('Повторить запрос');
        expect(io.post).toHaveBeenCalledTimes(1); expect(saved()).toEqual(previous); expect(current.canReset).toBe(true);
        expect(current.error).toContain('Запрос не отправлен');
        write.mockRestore(); await reload(); expect(current.canReset).toBe(true); expect(current.intent?.ids).toEqual(['old']);
        await click('Повторить запрос'); expect(io.post).toHaveBeenCalledTimes(2); expect(current.canReset).toBe(false);
    });

    it('Старый обработчик сброса не стирает новый неопределённый запрос', async () => {
        io.post.mockRejectedValueOnce(rejected(400)); await click('Добавить'); const oldClear = current.clear;
        io.post.mockRejectedValueOnce(new Error('ACK lost')); await click('Повторить запрос'); const original = saved();
        await run(oldClear); expect(saved()).toEqual(original); expect(current.blocked).toBe(true);
        expect(button('Изменить выбор')).toBeUndefined();
        io.post.mockRejectedValueOnce(rejected(409)); await click('Повторить запрос'); await reload();
        expect(current.canReset).toBe(false); expect(saved()?.requestKey).toBe(original.requestKey);
    });

    it('Выключение флага блокирует POST, но сохраняет GET восстановления и безопасный сброс', async () => {
        io.post.mockRejectedValueOnce(rejected(403)); await click('Добавить'); io.enabled = false; await render();
        expect(button('Повторить запрос')?.disabled).toBe(true); expect(button('Изменить выбор')?.disabled).toBe(false);
        await click('Изменить выбор'); expect(current.blocked).toBe(false);
        io.enabled = true; await render(); io.post.mockRejectedValueOnce(new Error('ACK lost')); await click('Добавить');
        io.enabled = false; await render();
        expect(button('Повторить запрос')?.disabled).toBe(true); await click('Проверить состояние');
        expect(io.get).toHaveBeenCalledTimes(1); expect(io.post).toHaveBeenCalledTimes(2);
    });

    it('Смена пользователя скрывает отказ, старые действия не меняют intent нового владельца', async () => {
        io.post.mockRejectedValueOnce(rejected(409)); await click('Добавить'); const previous = saved(), old = current;
        io.scope = 'admin-b'; await render(); expect(current.intent).toBeUndefined(); expect(current.error).toBe('');
        io.post.mockRejectedValueOnce(rejected(400)); await click('Добавить'); const next = saved();
        await run(() => old.clear()); await run(() => old.repeat());
        expect(saved()).toEqual(next); expect(io.post).toHaveBeenCalledTimes(2);
        io.scope = 'admin-a'; await render(); expect(saved()).toEqual(previous); expect(current.canReset).toBe(true);
        expect(button('Изменить выбор')).toBeDefined(); expect(io.post).toHaveBeenCalledTimes(2);
    });

    it('Поздняя GET-проверка прежнего владельца не заменяет текущий импорт', async () => {
        const pending = deferred<{data: IAssetImport}>(); io.get.mockReturnValueOnce(pending.promise);
        localStorage.setItem(key(), JSON.stringify({requestKey, commit, ids: ['old']})); await reload();
        expect(current.busy).toBe(true);
        io.scope = 'admin-b'; await render(); io.post.mockRejectedValueOnce(rejected(409)); await click('Добавить');
        const next = saved(); await run(() => {pending.resolve({data: job});});
        expect(current.job).toBeUndefined(); expect(saved()).toEqual(next); expect(current.canReset).toBe(true);
    });

    it('Возврат к прежнему пользователю не принимает ACK прежней сессии', async () => {
        const pending = deferred<{data: IAssetImport}>(); io.post.mockReturnValueOnce(pending.promise);
        let request!: Promise<void>;
        await run(() => {request = current.start(['old'], commit);}); const original = saved();
        io.scope = 'admin-b'; await render(); io.scope = 'admin-a'; await render();
        expect(current.blocked).toBe(true); expect(current.busy).toBe(false);
        await run(async () => {pending.resolve({data: job}); await request;});
        expect(current.job).toBeUndefined(); expect(current.canReset).toBe(false); expect(saved()).toEqual(original);
        expect(io.complete).not.toHaveBeenCalled();
    });

    it('Первый POST также ждёт сохранения запроса, при отказе остаётся доступен повтор выбора', async () => {
        const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new Error('storage denied');});
        await click('Добавить'); expect(io.post).not.toHaveBeenCalled(); expect(current.blocked).toBe(false);
        expect(current.error).toContain('Запрос не отправлен');
        write.mockRestore(); await click('Добавить'); expect(io.post).toHaveBeenCalledTimes(1);
    });

    it.each([false, 'true', 'rejected'])('Некорректный marker %s не превращает старый запрос в подтверждённый отказ', async rejected => {
        localStorage.setItem(key(), JSON.stringify({requestKey, commit, ids: ['old'], rejected})); await reload();
        expect(current.canReset).toBe(false); await run(() => current.clear()); expect(saved()?.requestKey).toBe(requestKey);
    });

    it('Возвращённый выбор исключает исчезнувшие, неполные и недоступные карточки', () => {
        const asset = (id: string, changes: Partial<ISourceAsset> = {}): ISourceAsset => ({id, kind: 'skill', name: id, version: '1', sha256: 'a'.repeat(64), license: 'MIT', dependencies: [], ...changes});
        const imported = {id: 'stored', version: 1, originVersion: '1', updateAvailable: true};
        const assets = [asset('ready'), asset('no-files', {supply: {ready: false, missingBytes: 1, missingFiles: 1}}),
            asset('archived', {imported: {...imported, archived: true}}), asset('unavailable', {imported: {...imported, unavailable: true}})];
        expect(availableSourceAssetIds(assets, ['missing', 'ready', 'no-files', 'archived', 'unavailable'])).toEqual(['ready']);
    });
});
