import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AxiosError} from 'axios';
import {useToolBuild} from '../src/modules/Store/packaging/useToolBuild';
import {BuildRequestUnresolvedError} from '../src/modules/Store/packaging/pendingBuild';
import type {ToolBuild,ToolBuildRequest} from '../src/modules/Store/packaging/types';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial?:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useCallback<T>(value:T,deps:unknown[]){const index=cursor++,previous=slots[index];if(!previous||!same(previous.deps,deps))slots[index]={value,deps};return slots[index].value;},
        useEffect(effect:()=>void|(()=>void),deps?:unknown[]){const index=cursor++,previous=slots[index];if(previous&&deps&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const io=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),clear:vi.fn(),create:vi.fn(),get:vi.fn(),lookup:vi.fn(),resume:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,useEffect:hooks.useEffect}));
vi.mock('react-router-dom',()=>({useLocation:()=>({pathname:'/store',search:'',hash:''})}));
vi.mock('../src/modules/Store/packaging/buildDraftStore',()=>({readStoredBuildDraft:io.read,saveStoredBuildDraft:io.save,clearStoredBuildDraft:io.clear}));
vi.mock('../src/modules/Store/packaging/api',()=>({packagingApi:{create:io.create,get:io.get,lookup:io.lookup}}));
vi.mock('../src/modules/Store/packaging/pendingBuild',async original=>({...await original<typeof import('../src/modules/Store/packaging/pendingBuild')>(),resumePendingBuild:io.resume}));

const queued:ToolBuild={id:'33333333-3333-4333-8333-333333333333',operationId:'operation',state:'QUEUED',percent:0,message:'Ожидание'};
const body=():Omit<ToolBuildRequest,'requestKey'>=>({name:'Точная версия',description:'Описание',kind:'mcp',source:{type:'files',entrypoint:'index.ts',files:[{path:'index.ts',content:'original bytes\n'}]}});
type Record={scope:string;schemaVersion:1;request:ToolBuildRequest};
const records=new Map<string,Record>();let scope:string,current:ReturnType<typeof useToolBuild>;
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let index=0;index<15;index++)await Promise.resolve();};
function render(){hooks.begin();current=useToolBuild(scope);hooks.commit();return current;}
async function ready(){render();await flush();render();}
beforeEach(()=>{
    vi.useFakeTimers();vi.resetAllMocks();records.clear();scope='alice';
    const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});
    vi.stubGlobal('window',{history:{state:{},replaceState(state:unknown){this.state=state as object;}}});
    io.read.mockImplementation(async(scope:string)=>records.get(scope));
    io.save.mockImplementation(async(scope:string,request:ToolBuildRequest)=>{const record={scope,schemaVersion:1,request:JSON.parse(JSON.stringify(request))};records.set(scope,record as Record);return record;});
    io.clear.mockImplementation(async(scope:string,key?:string)=>{const old=records.get(scope);if(old&&old.request.requestKey!==key)return false;records.delete(scope);return true;});
    io.create.mockResolvedValue(queued);io.resume.mockImplementation(()=>new Promise(()=>{}));
});
afterEach(()=>{hooks.dispose();vi.useRealTimers();vi.unstubAllGlobals();});

describe('POST упаковки принадлежит durable запросу и владельцу',()=>{
    it('Не отправляет POST до commit исходников, двойной клик не создаёт второй запрос',async()=>{
        await ready();const commit=deferred<Record>();io.save.mockReturnValue(commit.promise);
        const first=current.submit(body()),second=current.submit(body());await flush();expect(io.save).toHaveBeenCalledOnce();expect(io.create).not.toHaveBeenCalled();
        const saved=io.save.mock.calls[0];commit.resolve({scope:saved[0],schemaVersion:1,request:saved[1]});await Promise.all([first,second]);
        expect(io.create).toHaveBeenCalledOnce();expect(io.create.mock.calls[0][0]).toEqual(saved[1]);
    });
    it('Отказ хранилища запрещает POST',async()=>{
        await ready();io.save.mockRejectedValue(new Error('QuotaExceededError'));await current.submit(body());render();
        expect(io.create).not.toHaveBeenCalled();expect(current.error).toContain('QuotaExceededError');
    });
    it('Смена пользователя во время commit не отправляет чужой POST; возврат ABA тоже не оживляет callback',async()=>{
        await ready();const commit=deferred<Record>();io.save.mockReturnValue(commit.promise);const sent=current.submit(body());
        scope='bob';await ready();scope='alice';await ready();const saved=io.save.mock.calls[0];commit.resolve({scope:'alice',schemaVersion:1,request:saved[1]});await sent;
        expect(io.create).not.toHaveBeenCalled();
    });
    it('Поздний ответ POST не меняет новый профиль',async()=>{
        await ready();const response=deferred<ToolBuild>();io.create.mockReturnValue(response.promise);const sent=current.submit(body());await flush();
        scope='bob';await ready();response.resolve(queued);await sent;render();expect(current.job).toBeUndefined();expect(current.draft).toBeUndefined();
    });
    it('Reload делает только lookup; ручной повтор использует исходные файлы и прежний UUID',async()=>{
        await ready();io.create.mockRejectedValue(new Error('Lost ACK'));const original=body();await current.submit(original);const record=records.get('alice')!;
        original.source.type==='files'&&(original.source.files[0].content='edited form');hooks.dispose();io.resume.mockRejectedValue(new BuildRequestUnresolvedError());await ready();await flush();render();
        expect(io.resume.mock.calls[0][0]).toBe(record.request.requestKey);expect(io.create).toHaveBeenCalledOnce();expect(current.unresolved).toBe(true);
        await current.submit({...body(),name:'Another form'});expect(io.create).toHaveBeenCalledOnce();
        io.create.mockResolvedValue(queued);await current.retrySaved();
        expect(io.create).toHaveBeenCalledTimes(2);expect(io.create.mock.calls[1][0]).toEqual(record.request);expect(io.create.mock.calls[1][0].source.files[0].content).toBe('original bytes\n');
    });
    it('Другая учётная запись не получает сохранённые исходники',async()=>{
        records.set('alice',{scope:'alice',schemaVersion:1,request:{...body(),requestKey:'11111111-1111-4111-8111-111111111111'}});scope='bob';await ready();
        expect(current.draft).toBeUndefined();expect(io.resume).not.toHaveBeenCalled();expect(io.create).not.toHaveBeenCalled();
    });
    it('Явный первый HTTP400 допускает исправление формы с новым UUID',async()=>{
        await ready();io.create.mockRejectedValueOnce(new AxiosError('Invalid source','ERR_BAD_REQUEST',undefined,undefined,{status:400} as never));
        await current.submit(body());render();expect(records.has('alice')).toBe(false);expect(current.unresolved).toBe(false);
        await current.submit({...body(),name:'Исправлено'});expect(io.create).toHaveBeenCalledTimes(2);
        expect(io.create.mock.calls[1][0].requestKey).not.toBe(io.create.mock.calls[0][0].requestKey);
    });
    it('Отказ чтения сохранённого плана блокирует новый POST до повторного восстановления',async()=>{
        io.read.mockRejectedValue(new Error('Storage denied'));await ready();await current.submit(body());expect(io.create).not.toHaveBeenCalled();expect(current.recoveryBlocked).toBe(true);
        io.read.mockResolvedValue(undefined);current.retryRecovery();await ready();expect(current.recoveryBlocked).toBe(false);await current.submit(body());expect(io.create).toHaveBeenCalledOnce();
    });
    it('Reset CAS conflict preserves the other-tab request and recovers its exact UUID before another POST',async()=>{
        await ready();io.create.mockResolvedValue({...queued,state:'SUCCEEDED',percent:100});await current.submit(body());render();
        const fresh:Record={scope,schemaVersion:1,request:{...body(),name:'Другая вкладка',requestKey:'22222222-2222-4222-8222-222222222222'}};records.set(scope,fresh);
        expect(await current.reset()).toBe(false);render();expect(current.recoveryBlocked).toBe(true);expect(records.get(scope)).toEqual(fresh);
        await current.submit({...body(),name:'Не отправлять'});expect(io.create).toHaveBeenCalledOnce();
        current.retryRecovery();await ready();expect(current.recoveryBlocked).toBe(false);expect(current.draft).toEqual(fresh);expect(io.resume).toHaveBeenCalledWith(fresh.request.requestKey,expect.any(Function),expect.any(AbortSignal),expect.any(Function));expect(io.create).toHaveBeenCalledOnce();
    });
    it('Fresh HTTP400 cleanup CAS conflict cannot discard the newer durable request or POST a replacement form',async()=>{
        await ready();const response=deferred<ToolBuild>();io.create.mockReturnValue(response.promise);const sending=current.submit(body());await flush();
        const fresh:Record={scope,schemaVersion:1,request:{...body(),requestKey:'22222222-2222-4222-8222-222222222222'}};records.set(scope,fresh);
        response.reject(new AxiosError('Invalid source','ERR_BAD_REQUEST',undefined,undefined,{status:400} as never));await sending;render();
        expect(current.recoveryBlocked).toBe(true);expect(records.get(scope)).toEqual(fresh);await current.submit(body());expect(io.create).toHaveBeenCalledOnce();
        current.retryRecovery();await ready();expect(current.draft).toEqual(fresh);expect(current.recoveryBlocked).toBe(false);expect(io.resume.mock.lastCall?.[0]).toBe(fresh.request.requestKey);expect(io.create).toHaveBeenCalledOnce();
    });
    it.each(['reset','http400'] as const)('A late %s CAS conflict cannot block or overwrite a fresh owner after A → B → A',async action=>{
        await ready();const clearing=deferred<boolean>();io.clear.mockReturnValue(clearing.promise);
        let completing:Promise<unknown>;
        if(action==='reset'){io.create.mockResolvedValue({...queued,state:'SUCCEEDED',percent:100});await current.submit(body());render();completing=current.reset();}
        else {io.create.mockRejectedValueOnce(new AxiosError('Invalid source','ERR_BAD_REQUEST',undefined,undefined,{status:400} as never));completing=current.submit(body());}
        await flush();expect(io.clear).toHaveBeenCalledOnce();
        const fresh:Record={scope:'alice',schemaVersion:1,request:{...body(),requestKey:'22222222-2222-4222-8222-222222222222'}};records.set('alice',fresh);
        scope='bob';await ready();scope='alice';await ready();clearing.resolve(false);await completing;render();
        expect(current.recoveryBlocked).toBe(false);expect(current.draft).toEqual(fresh);expect(current.error).toBe('');expect(records.get('alice')).toEqual(fresh);expect(io.create).toHaveBeenCalledOnce();
    });
    it('A completed checkpoint without a local draft still CAS-checks a newer request from another tab before reset',async()=>{
        await ready();const completed={...queued,state:'SUCCEEDED' as const,percent:100};io.create.mockResolvedValue(completed);await current.submit(body());render();
        hooks.dispose();io.read.mockResolvedValueOnce(undefined);io.get.mockResolvedValue(completed);await ready();await vi.advanceTimersByTimeAsync(1000);render();
        expect(current.job?.state).toBe('SUCCEEDED');expect(current.draft).toBeUndefined();
        const fresh:Record={scope,schemaVersion:1,request:{...body(),requestKey:'22222222-2222-4222-8222-222222222222'}};records.set(scope,fresh);
        expect(await current.reset()).toBe(false);render();expect(current.recoveryBlocked).toBe(true);expect(records.get(scope)).toEqual(fresh);expect(io.clear).toHaveBeenLastCalledWith(scope,undefined);
        current.retryRecovery();await ready();expect(current.draft).toEqual(fresh);expect(io.resume.mock.lastCall?.[0]).toBe(fresh.request.requestKey);expect(io.create).toHaveBeenCalledOnce();
    });
});
