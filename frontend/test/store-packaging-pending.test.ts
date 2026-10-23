import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptBuildProgress, buildSubmissionRequest, BuildRequestUnresolvedError, readPendingBuild, resumePendingBuild, savePendingBuild } from '../src/modules/Store/packaging/pendingBuild';
import type { ToolBuild } from '../src/modules/Store/packaging/types';

const key = '77fbc358-c183-4af8-b784-55d0aff94a1a'; // gitleaks:allow — тестовый UUID идемпотентного запроса, не ключ доступа.
const queued: ToolBuild = { id: 'build', operationId: 'op', state: 'QUEUED', percent: 0, message: 'Ожидание' };
const missing = { isAxiosError: true, response: { status: 404 } };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Восстановление неизвестного ответа на упаковку', () => {
    it('Перезагрузка сохраняет pending UUID, когда localStorage запрещён браузером', () => {
        const denied = () => { throw new DOMException('Storage запрещён', 'SecurityError'); };
        const history = { state: { key: 'router' }, replaceState(next: { key: string }) { this.state = next; } };
        vi.stubGlobal('window', { history });
        vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
        savePendingBuild('alice', key);
        vi.stubGlobal('window', { history: { state: structuredClone(history.state) } });
        expect(readPendingBuild('alice')).toBe(key);
    });
    it('Сохраняет только UUID запроса в области текущего пользователя', () => {
        const values = new Map<string, string>();
        vi.stubGlobal('localStorage', { setItem: (name: string, value: string) => values.set(name, value), getItem: (name: string) => values.get(name), removeItem: (name: string) => values.delete(name) });
        savePendingBuild('alice', key);
        expect([...values.values()]).toEqual([key]);
        expect([...values.values()][0].length).toBe(36);
        expect(readPendingBuild('bob')).toBeUndefined();
        expect(readPendingBuild('alice')).toBe(key);
        savePendingBuild('alice');
        expect(readPendingBuild('alice')).toBeUndefined();
    });
    it.each([404,503])('После временной %s находит исходную сборку через GET и не создаёт новую', async status => {
        vi.useFakeTimers();
        const lookup = vi.fn().mockRejectedValueOnce({isAxiosError:true,response:{status}}).mockResolvedValueOnce(queued);
        const create = vi.fn();
        const result = resumePendingBuild(key, lookup, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(2000);
        expect(await result).toEqual(queued);
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(lookup).toHaveBeenCalledWith(key, expect.any(AbortSignal));
        expect(create).not.toHaveBeenCalled();
    });
    it.each([404,503])('%s через 45 секунд сохраняет UUID и оставляет исход неопределённым', async status => {
        vi.useFakeTimers();
        const values=new Map<string,string>();
        vi.stubGlobal('localStorage',{getItem:(name:string)=>values.get(name),setItem:(name:string,value:string)=>values.set(name,value),removeItem:(name:string)=>values.delete(name)});
        savePendingBuild('alice',key);
        const lookup=vi.fn().mockRejectedValue({isAxiosError:true,response:{status}});
        const result = resumePendingBuild(key, lookup, new AbortController().signal).catch(error => error);
        await vi.advanceTimersByTimeAsync(46_000);
        expect(await result).toBeInstanceOf(BuildRequestUnresolvedError);
        expect(readPendingBuild('alice')).toBe(key);expect(lookup.mock.calls.every(call=>call[0]===key)).toBe(true);
    });
    it('Неопределённый ответ разрешает прежний UUID только для точного восстановленного запроса', () => {
        const first = buildSubmissionRequest('исходная форма');
        expect(buildSubmissionRequest('исходная форма', first)).toBe(first);
        expect(buildSubmissionRequest('исходная форма', first, first.key)).toBe(first);
        expect(() => buildSubmissionRequest('изменённая форма', first, first.key)).toThrow('Нельзя изменить');
        expect(() => buildSubmissionRequest('после reload без исходников', undefined, key)).toThrow('Нельзя изменить');
        expect(buildSubmissionRequest('новое явное задание', first).key).not.toBe(first.key);
    });
    it('Сбой сети не превращается в новый POST или ложную окончательную 404', async () => {
        vi.useFakeTimers();
        const lookup = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(queued);
        const retry = vi.fn();
        const result = resumePendingBuild(key, lookup, new AbortController().signal, retry);
        await vi.advanceTimersByTimeAsync(2000);
        expect(await result).toEqual(queued);
        expect(retry).toHaveBeenCalledTimes(1);
    });
    it('Смена владельца прекращает ожидание и игнорирует поздний результат', async () => {
        const controller = new AbortController();
        let resolve!: (job: ToolBuild) => void;
        const lookup = vi.fn(() => new Promise<ToolBuild>(done => { resolve = done; }));
        const result = resumePendingBuild(key, lookup, controller.signal).catch(error => error);
        controller.abort(); resolve(queued);
        expect((await result).name).toBe('AbortError');
        expect(lookup).toHaveBeenCalledTimes(1);
    });
    it('Зависший lookup ограничен общим deadline, сохраняет UUID и позволяет повторную проверку', async () => {
        vi.useFakeTimers();
        const values = new Map<string, string>();
        vi.stubGlobal('localStorage', { setItem: (name: string, value: string) => values.set(name, value), getItem: (name: string) => values.get(name), removeItem: (name: string) => values.delete(name) });
        savePendingBuild('alice', key);
        let late!: (job: ToolBuild) => void;
        const lookup = vi.fn((_key: string, _signal?: AbortSignal) => new Promise<ToolBuild>(resolve => { late = resolve; }));
        const recovered = resumePendingBuild(key, lookup, new AbortController().signal).catch(error => error);
        await vi.advanceTimersByTimeAsync(45_000);
        expect(await recovered).toBeInstanceOf(BuildRequestUnresolvedError);
        expect(lookup.mock.calls[0][1]?.aborted).toBe(true);
        expect(readPendingBuild('alice')).toBe(key);
        late(queued);
        expect(await recovered).toBeInstanceOf(BuildRequestUnresolvedError);
        expect(await resumePendingBuild(key, async () => queued, new AbortController().signal)).toEqual(queued);
    });
    it('Отмена владельцем прекращает даже lookup, который не обрабатывает AbortSignal', async () => {
        const controller = new AbortController();
        const lookup = vi.fn((_key: string, _signal?: AbortSignal) => new Promise<ToolBuild>(() => {}));
        const result = resumePendingBuild(key, lookup, controller.signal).catch(error => error);
        controller.abort();
        expect((await result).name).toBe('AbortError');
        expect(lookup.mock.calls[0][1]?.aborted).toBe(true);
    });
    it('Старый ответ POST не откатывает терминальное состояние и процент', () => {
        const running = { ...queued, state: 'RUNNING' as const, percent: 65 };
        expect(acceptBuildProgress(running, queued)).toEqual(running);
        expect(acceptBuildProgress(running, { ...running, percent: 20 }).percent).toBe(65);
        const completed = { ...queued, state: 'SUCCEEDED' as const, percent: 100, result: { catalogId: 'catalog', name: 'Инструмент', version: 1 } };
        expect(acceptBuildProgress(completed, queued)).toEqual(completed);
    });
});

describe('Монотонное завершение и отмена упаковщика',()=>{
    it('Поздние RUNNING/QUEUED не откатывают CANCELLING; поздний failure не отменяет CANCELLED',()=>{
        const cancelling={...queued,state:'CANCELLING' as const,percent:60};
        expect(acceptBuildProgress(cancelling,{...queued,state:'RUNNING',percent:80})).toEqual(cancelling);
        expect(acceptBuildProgress(cancelling,queued)).toEqual(cancelling);
        const cancelled={...cancelling,state:'CANCELLED' as const,message:'Отменено'};
        expect(acceptBuildProgress(cancelling,cancelled)).toEqual(cancelled);
        expect(acceptBuildProgress(cancelled,{...queued,state:'FAILED',error:'Late child error'})).toEqual(cancelled);
    });
    it('Поздний снимок без fence не делает публикацию снова отменяемой',()=>{
        const publishing={...queued,state:'RUNNING' as const,publicationStartedAt:'2026-10-23T00:00:00Z',percent:90};
        expect(acceptBuildProgress(publishing,{...publishing,publicationStartedAt:null,percent:70})).toMatchObject({publicationStartedAt:publishing.publicationStartedAt,percent:90});
    });
});
