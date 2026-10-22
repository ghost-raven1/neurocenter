import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';
import {useBridgeInstaller} from '../src/features/McpBridge/useBridgeInstaller';

const hooks=vi.hoisted(()=>{
    let cursor=0,writes=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),writes:()=>writes,
        dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;writes=0;},
        useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(next:T|((previous:T)=>T))=>{writes++;slot.value=typeof next==='function'?(next as (previous:T)=>T)(slot.value as T):next;}];},
        useEffect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,previous=slots[index];if(previous?.deps?.length===deps.length&&deps.every((value,position)=>Object.is(value,previous.deps?.[position])))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});}
    };
});
const owner=vi.hoisted(()=>({scope:'admin',epoch:0,captures:new Map<number,()=>()=>boolean>()}));
vi.mock('react',()=>({useState:hooks.useState,useEffect:hooks.useEffect}));
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    if(!owner.captures.has(owner.epoch)){const epoch=owner.epoch;owner.captures.set(epoch,()=>()=>owner.epoch===epoch);}
    return{scope:owner.scope,captureOwner:owner.captures.get(owner.epoch)!};
}}));
const supply={version:'0.9.18',buildId:'b'.repeat(64),targets:['darwin-arm64']};
const config={origin:'https://gateway.test',devSupply:supply};
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
function render(enabled=true){hooks.begin();const result=useBridgeInstaller(enabled);hooks.commit();return result;}
function changeOwner(scope:string){owner.scope=scope;owner.epoch++;}
beforeEach(()=>{vi.resetAllMocks();owner.scope='admin';owner.epoch=0;owner.captures.clear();vi.mocked(api.get).mockResolvedValue({data:config});});
afterEach(()=>hooks.dispose());

describe('Локальная поставка и владение runtime-конфигурацией',()=>{
    it('Получает dev-поставку только из Gateway без обращения к каталогу ассетов',async()=>{
        render();await flush();expect(render()).toMatchObject({...config,loading:false,error:''});
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/bridge/config',{signal:expect.any(AbortSignal),timeout:10000});
    });
    it('Production origin-only остаётся рабочим без выдуманной dev-поставки',async()=>{
        vi.mocked(api.get).mockResolvedValue({data:{origin:config.origin}});render();await flush();expect(render()).toMatchObject({origin:config.origin,loading:false,error:''});expect(render()).not.toHaveProperty('devSupply');
    });
    it('Отключение прерывает ожидавший запрос и скрывает ранее загруженную конфигурацию',async()=>{
        render(false);expect(api.get).not.toHaveBeenCalled();render();await flush();expect(render().origin).toBe(config.origin);
        const pending=deferred<{data:typeof config}>();vi.mocked(api.get).mockReturnValueOnce(pending.promise);render().reload();render();const signal=vi.mocked(api.get).mock.calls[1][1]!.signal as AbortSignal;
        expect(render(false).origin).toBeUndefined();expect(signal.aborted).toBe(true);pending.resolve({data:config});await flush();expect(render(false).origin).toBeUndefined();
    });
    it('Повторное включение не показывает готовую сборку прошлого входа до нового GET',async()=>{
        render();await flush();expect(render()).toMatchObject(config);render(false);
        const pending=deferred<{data:typeof config}>();vi.mocked(api.get).mockReturnValueOnce(pending.promise);
        const reopened=render();expect(reopened.origin).toBeUndefined();expect(reopened.devSupply).toBeUndefined();
        const next={...config,devSupply:{...supply,buildId:'f'.repeat(64)}};pending.resolve({data:next});await flush();expect(render()).toMatchObject(next);
    });
    it('Malformed dev после успешного чтения убирает старый origin/dev и позволяет явный повтор',async()=>{
        render();await flush();vi.mocked(api.get).mockResolvedValueOnce({data:{...config,devSupply:{...supply,targets:[]}}});render().reload();expect(render().origin).toBeUndefined();await flush();
        expect(render()).toMatchObject({loading:false});expect(render().origin).toBeUndefined();expect(render().error).not.toBe('');expect(render()).not.toHaveProperty('devSupply');
        render().reload();render();await flush();expect(render()).toMatchObject({...config,error:''});
    });
    it('Повторная загрузка отменяет прежний запрос; поздний ответ не возвращает старый origin/build',async()=>{
        const old=deferred<{data:typeof config}>();vi.mocked(api.get).mockReturnValueOnce(old.promise);render();const signal=vi.mocked(api.get).mock.calls[0][1]!.signal as AbortSignal;
        const next={origin:'https://next-gateway.test',devSupply:{...supply,buildId:'c'.repeat(64)}};vi.mocked(api.get).mockResolvedValue({data:next});render().reload();render();await flush();expect(signal.aborted).toBe(true);
        old.resolve({data:config});await flush();expect(render()).toMatchObject(next);
    });
    it('Явный reload убирает готовую сборку A до получения новой сборки B того же origin и версии',async()=>{
        render();await flush();expect(render()).toMatchObject(config);const pending=deferred<{data:typeof config}>();vi.mocked(api.get).mockReturnValueOnce(pending.promise);
        render().reload();expect(render().origin).toBeUndefined();expect(render().devSupply).toBeUndefined();const next={...config,devSupply:{...supply,buildId:'e'.repeat(64)}};pending.resolve({data:next});await flush();expect(render()).toMatchObject(next);
    });
    it.each(['success','failure'] as const)('Изменившийся actor отвергает поздний %s ещё до следующего render',async outcome=>{
        const old=deferred<{data:typeof config}>();vi.mocked(api.get).mockReturnValueOnce(old.promise);render();changeOwner('developer');const writes=hooks.writes();
        if(outcome==='success')old.resolve({data:config});else old.reject(Error('old actor failure'));await flush();expect(hooks.writes()).toBe(writes);expect(render().origin).toBeUndefined();await flush();expect(render()).toMatchObject(config);
    });
    it('Возврат к прежней роли не оживляет её старый ожидавший запрос',async()=>{
        const old=deferred<{data:typeof config}>();vi.mocked(api.get).mockReturnValueOnce(old.promise);render();changeOwner('developer');render();await flush();changeOwner('admin');
        const next={...config,devSupply:{...supply,buildId:'d'.repeat(64)}};vi.mocked(api.get).mockResolvedValue({data:next});expect(render().origin).toBeUndefined();await flush();old.resolve({data:config});await flush();expect(render()).toMatchObject(next);
    });
    it('Закрытие прерывает запрос; поздний отказ не пишет состояние и не делает fallback GET',async()=>{
        const pending=deferred<{data:typeof config}>();vi.mocked(api.get).mockReturnValueOnce(pending.promise);render();const signal=vi.mocked(api.get).mock.calls[0][1]!.signal as AbortSignal;hooks.dispose();
        expect(signal.aborted).toBe(true);pending.reject(Error('closed'));await flush();expect(hooks.writes()).toBe(0);expect(api.get).toHaveBeenCalledOnce();
    });
});
