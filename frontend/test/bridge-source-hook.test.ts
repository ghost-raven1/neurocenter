import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBridgeSource } from '../src/features/McpBridge/useBridgeSource';
import { useBridgeSourceImport } from '../src/features/McpBridge/useBridgeSourceImport';
import type { IBridgeSource } from '../src/features/McpBridge/bridgeSource';
import type { IAssetImport } from '../src/features/AssetSources/types';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;dependencies?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a?:unknown[],b?:unknown[])=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
    const useMemo=(factory:()=>unknown,dependencies:unknown[])=>{const index=cursor++,previous=slots[index];if(!previous||!same(previous.dependencies,dependencies))slots[index]={value:factory(),dependencies};return slots[index].value;};
    return {begin:()=>{cursor=0;},commit:()=>{effects.splice(0).forEach(effect=>effect());},dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return [slot.value,(next:T|((previous:T)=>T))=>{slot.value=typeof next==='function'?(next as (previous:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial?:T){return (slots[cursor++]??={value:{current:initial}}).value;},useCallback:(callback:unknown,dependencies:unknown[])=>useMemo(()=>callback,dependencies),
        useEffect(effect:()=>void|(()=>void),dependencies:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.dependencies,dependencies))return;const slot=slots[index]={dependencies};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const fixture=vi.hoisted(()=>({scope:'admin',owners:new Map<string,()=>()=>boolean>(),get:vi.fn(),check:vi.fn(),save:vi.fn(),job:vi.fn(),import:vi.fn()}));
vi.mock('react',()=>({useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useEffect,useCallback:hooks.useCallback}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    if(!fixture.owners.has(fixture.scope)){const scope=fixture.scope;fixture.owners.set(scope,()=>()=>fixture.scope===scope);}
    return {scope:fixture.scope,captureOwner:fixture.owners.get(fixture.scope)!};
}}));
vi.mock('../src/features/McpBridge/bridgeSource',async original=>({...await original<typeof import('../src/features/McpBridge/bridgeSource')>(),bridgeSourceApi:{get:fixture.get,check:fixture.check,save:fixture.save,job:fixture.job,import:fixture.import}}));
const source:IBridgeSource={url:'https://github.com/owner/assets',revision:1,checkedAt:'2026-10-21T03:00:00Z',available:{assetId:'bridge',version:'0.9.5',buildId:'b'.repeat(64),repositoryCommit:'c'.repeat(40),targets:['darwin-arm64']}};
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
function render(){hooks.begin();const result=useBridgeSource();hooks.commit();return result;}
function renderBoth(){hooks.begin();const sourceView=useBridgeSource();const imports=useBridgeSourceImport(()=>{void sourceView.reload();});hooks.commit();return {source:sourceView,imports};}
beforeEach(()=>{vi.resetAllMocks();fixture.scope='admin';fixture.owners.clear();fixture.get.mockResolvedValue(source);fixture.check.mockResolvedValue(source);fixture.save.mockResolvedValue(source);});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();});

describe('Проверка источника при входе на шаг компьютера',()=>{
    it('Читает настройки и один раз проверяет опись без force; повторный render не ходит в GitHub',async()=>{
        render();await flush();expect(render().data).toEqual(source);expect(fixture.get).toHaveBeenCalledOnce();expect(fixture.check).toHaveBeenCalledExactlyOnceWith(1,expect.any(AbortSignal),false);render();await flush();expect(fixture.check).toHaveBeenCalledOnce();
    });
    it('Повторные нажатия во время запроса не запускают вторую проверку',async()=>{
        const pending=deferred<IBridgeSource>();fixture.check.mockReturnValue(pending.promise);render();await flush();await render().check();await render().check();expect(fixture.check).toHaveBeenCalledOnce();pending.resolve(source);await flush();expect(render().loading).toBe(false);
    });
    it('Явная проверка сначала получает актуальную revision и передаёт force',async()=>{
        render();await flush();fixture.get.mockResolvedValue({...source,revision:4});fixture.check.mockResolvedValue({...source,revision:4});await render().check();expect(fixture.check).toHaveBeenLastCalledWith(4,expect.any(AbortSignal),true);expect(render().data?.revision).toBe(4);
    });
    it('Сетевой отказ оставляет явно сохранённый снимок с ошибкой, доступен повтор',async()=>{
        fixture.check.mockRejectedValueOnce(new Error('GitHub недоступен'));fixture.get.mockResolvedValueOnce(source).mockResolvedValueOnce({...source,error:'Сохранённая проверка не обновлена'}).mockResolvedValue(source);
        render();await flush();expect(render()).toMatchObject({error:'GitHub недоступен',loading:false,data:{available:source.available,error:'Сохранённая проверка не обновлена'}});
        await render().check();expect(render().error).toBe('');expect(render().data).toEqual(source);
    });
    it('Поздний ответ прежней роли не начинает check и не заменяет новую конфигурацию',async()=>{
        const old=deferred<IBridgeSource>();fixture.get.mockReturnValueOnce(old.promise).mockResolvedValue({...source,url:'https://github.com/new/assets',revision:5});fixture.check.mockResolvedValue({...source,url:'https://github.com/new/assets',revision:5});
        render();fixture.scope='developer';expect(render().data).toBeUndefined();await flush();old.resolve(source);await flush();expect(fixture.check).toHaveBeenCalledOnce();expect(fixture.check).toHaveBeenCalledWith(5,expect.any(AbortSignal),false);expect(render().data?.revision).toBe(5);
    });
    it('Закрытие шага прерывает запрос и не запускает восстановительный GET после позднего отказа',async()=>{
        const pending=deferred<IBridgeSource>();fixture.check.mockReturnValue(pending.promise);render();await flush();const signal=fixture.check.mock.calls[0][1] as AbortSignal;hooks.dispose();expect(signal.aborted).toBe(true);pending.reject(new Error('Поздний отказ'));await flush();expect(fixture.get).toHaveBeenCalledOnce();
    });
    it('Сохранение использует CAS и после успеха скрывает опись прежнего источника',async()=>{
        render();await flush();const next={url:'https://github.com/new/assets',revision:2};fixture.save.mockResolvedValue(next);expect(await render().save(next.url)).toBe(true);expect(fixture.save).toHaveBeenCalledExactlyOnceWith(next.url,1,expect.any(AbortSignal));expect(render().data).toEqual(next);expect(fixture.check).toHaveBeenCalledOnce();
    });
    it('Потерянный ответ сохранения перечитывает сервер и не восстанавливает прежнюю опись',async()=>{
        render();await flush();fixture.save.mockRejectedValue(new Error('Ответ потерян'));fixture.get.mockResolvedValue({url:'https://github.com/new/assets',revision:2});expect(await render().save('https://github.com/new/assets')).toBe(false);expect(render().data?.revision).toBe(2);expect(render().data?.available).toBeUndefined();expect(render().error).toBe('Ответ потерян');
    });
    it('Завершение импорта ждёт проверки описи, затем перечитывает готовую поставку',async()=>{
        const pending=deferred<IBridgeSource>();fixture.check.mockReturnValue(pending.promise);render();await flush();const signal=fixture.check.mock.calls[0][1] as AbortSignal;
        const imported={...source,imported:source.available};fixture.get.mockResolvedValue(imported);await render().reload();expect(signal.aborted).toBe(false);expect(fixture.get).toHaveBeenCalledOnce();
        pending.resolve(source);await flush();expect(render().data?.imported).toEqual(source.available);expect(render().loading).toBe(false);expect(fixture.check).toHaveBeenCalledOnce();expect(fixture.get).toHaveBeenCalledTimes(2);
    });
    it('Отложенный GET готовой поставки не скрывает ошибку проверки источника',async()=>{
        const pending=deferred<IBridgeSource>();fixture.check.mockReturnValue(pending.promise);render();await flush();await render().reload();pending.reject(new Error('Нет связи с источником'));await flush();
        expect(fixture.get).toHaveBeenCalledTimes(3);expect(render().error).toBe('Нет связи с источником');
    });
    it('Явная проверка во время GET не теряется и выполняется после перечитывания',async()=>{
        render();await flush();const pending=deferred<IBridgeSource>();fixture.get.mockReturnValueOnce(pending.promise).mockResolvedValue({...source,revision:4});fixture.check.mockResolvedValue({...source,revision:4});
        const reload=render().reload();await render().check();expect(fixture.check).toHaveBeenCalledOnce();pending.resolve(source);await reload;await flush();expect(fixture.check).toHaveBeenLastCalledWith(4,expect.any(AbortSignal),true);expect(render().data?.revision).toBe(4);
    });
});

describe('Совместное восстановление импорта и автоматическая проверка версий',()=>{
    it.each(['before-get','during-check'] as const)('Сохранённый terminal result не отменяет auto-check: %s',async timing=>{
        const intent={expectedRevision:1,commit:'c'.repeat(40),assetId:'bridge',requestKey:'00000000-0000-4000-8000-000000000000',jobId:'00000000-0000-4000-8000-000000000001'};
        vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify(intent),setItem:vi.fn(),removeItem:vi.fn()});
        const initial=deferred<IBridgeSource>(),checking=deferred<IBridgeSource>(),restoring=deferred<IAssetImport>();
        const stale={...source,checkedAt:'2026-10-21T02:00:00Z'},fresh={...source,checkedAt:'2026-10-21T03:00:00Z',imported:source.available};
        fixture.get.mockReturnValueOnce(initial.promise).mockResolvedValue(fresh);fixture.check.mockReturnValue(checking.promise);fixture.job.mockReturnValue(restoring.promise);
        renderBoth();const firstSignal=fixture.get.mock.calls[0][0] as AbortSignal;
        const restored:IAssetImport={id:intent.jobId,state:'SUCCEEDED',message:'Готово',planDigest:'d'.repeat(64),items:[]};
        if(timing==='before-get'){restoring.resolve(restored);await flush();expect(fixture.check).not.toHaveBeenCalled();}
        initial.resolve(stale);await flush();expect(fixture.check).toHaveBeenCalledExactlyOnceWith(1,expect.any(AbortSignal),false);
        if(timing==='during-check'){restoring.resolve(restored);await flush();}
        expect(firstSignal.aborted).toBe(false);checking.resolve({...stale,checkedAt:fresh.checkedAt});await flush();
        const view=renderBoth();expect(view.source.data?.checkedAt).toBe(fresh.checkedAt);expect(view.source.data?.imported).toEqual(source.available);expect(view.source.loading).toBe(false);
        expect(fixture.get).toHaveBeenCalledTimes(2);expect(fixture.check).toHaveBeenCalledOnce();expect(fixture.job).toHaveBeenCalledOnce();expect(fixture.import).not.toHaveBeenCalled();
    });
});
