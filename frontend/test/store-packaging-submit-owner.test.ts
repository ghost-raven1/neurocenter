import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AxiosError} from 'axios';
import {useToolBuild} from '../src/modules/Store/packaging/useToolBuild';
import {BuildRequestUnresolvedError} from '../src/modules/Store/packaging/pendingBuild';
import {saveBuildCheckpoint} from '../src/modules/Store/packaging/buildRecovery';
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
const io=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),clear:vi.fn(),create:vi.fn(),get:vi.fn(),lookup:vi.fn(),resume:vi.fn(),readCancel:vi.fn(),saveCancel:vi.fn(),clearCancel:vi.fn(),cancel:vi.fn(),cancelRequest:vi.fn(),archive:vi.fn(),archives:vi.fn(),restore:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,useEffect:hooks.useEffect}));
vi.mock('react-router-dom',()=>({useLocation:()=>({pathname:'/store',search:'',hash:''})}));
vi.mock('../src/modules/Store/packaging/buildDraftStore',()=>({readStoredBuildRecovery:async(scope:string,checkpoint?:{jobId?:string;requestKey?:string})=>{
    const draft=await io.read(scope),cancellation=await io.readCancel(scope);
    const archivedCheckpoint=!draft&&!cancellation&&checkpoint&&[...archives.values()].some(record=>record.scope===scope&&(record.jobId===checkpoint.jobId||record.requestKey===checkpoint.requestKey));
    return {draft,cancellation,...(archivedCheckpoint?{archivedCheckpoint:true}:{})};
},saveStoredBuildDraft:io.save,clearStoredBuildDraft:io.clear,saveStoredBuildCancellation:io.saveCancel,clearStoredBuildCancellation:io.clearCancel,archiveStoredBuildCancellation:io.archive,listStoredBuildArchives:io.archives,restoreStoredBuildArchive:io.restore}));
vi.mock('../src/modules/Store/packaging/api',()=>({packagingApi:{create:io.create,get:io.get,lookup:io.lookup,cancel:io.cancel,cancelRequest:io.cancelRequest}}));
vi.mock('../src/modules/Store/packaging/pendingBuild',async original=>({...await original<typeof import('../src/modules/Store/packaging/pendingBuild')>(),resumePendingBuild:io.resume}));

const queued:ToolBuild={id:'33333333-3333-4333-8333-333333333333',operationId:'operation',state:'QUEUED',percent:0,message:'Ожидание'};
const body=():Omit<ToolBuildRequest,'requestKey'>=>({name:'Точная версия',description:'Описание',kind:'mcp',source:{type:'files',entrypoint:'index.ts',files:[{path:'index.ts',content:'original bytes\n'}]}});
const unavailableMessage='Сервер занят. Проверьте сохранённый запрос и повторите с прежним UUID.';
const unavailable=()=>new AxiosError('Service Unavailable','ERR_BAD_RESPONSE',undefined,undefined,{status:503,data:{message:unavailableMessage}} as never);
type Record={scope:string;schemaVersion:1;request:ToolBuildRequest};
type Cancellation={schemaVersion:1;scope:string;target:'request'|'job';id:string};
const records=new Map<string,Record>(),cancellations=new Map<string,Cancellation>();let scope:string,current:ReturnType<typeof useToolBuild>;
const archives=new Map<string,{scope:string;requestKey:string;jobId:string;name:string;record?:Record;intent:Cancellation}>();
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let index=0;index<15;index++)await Promise.resolve();};
function render(commit=true){hooks.begin();current=useToolBuild(scope);if(commit)hooks.commit();return current;}
async function ready(){render();await flush();render();}
beforeEach(()=>{
    vi.useFakeTimers();vi.resetAllMocks();records.clear();cancellations.clear();archives.clear();scope='alice';
    const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});
    vi.stubGlobal('window',{history:{state:{},replaceState(state:unknown){this.state=state as object;}}});
    io.read.mockImplementation(async(scope:string)=>records.get(scope));
    io.save.mockImplementation(async(scope:string,request:ToolBuildRequest)=>{const record={scope,schemaVersion:1,request:JSON.parse(JSON.stringify(request))};records.set(scope,record as Record);return record;});
    io.clear.mockImplementation(async(scope:string,key?:string,cancel?:Cancellation)=>{const old=records.get(scope);if(old&&old.request.requestKey!==key)return false;const stored=cancellations.get(scope);if(stored&&stored.id!==cancel?.id)return false;records.delete(scope);cancellations.delete(scope);return true;});
    io.readCancel.mockImplementation(async(scope:string)=>cancellations.get(scope));
    io.saveCancel.mockImplementation(async(scope:string,target:Cancellation['target'],id:string)=>{const intent={schemaVersion:1 as const,scope,target,id};cancellations.set(scope,intent);return intent;});
    io.clearCancel.mockImplementation(async(scope:string)=>{cancellations.delete(scope);return true;});
    io.cancelRequest.mockImplementation(async(requestKey:string)=>({requestKey,state:'CANCELLED',build:null}));
    io.archives.mockImplementation(async(scope:string)=>[...archives.values()].filter(record=>record.scope===scope).map(({requestKey,jobId,name})=>({requestKey,jobId,name})));
    io.archive.mockImplementation(async(scope:string,key:string|undefined,intent:Cancellation,ack:{id:string;requestKey:string})=>{const record=records.get(scope);archives.set(scope+':'+ack.requestKey,{scope,requestKey:ack.requestKey,jobId:ack.id,name:record?.request.name??'Сборка инструмента',record,intent});records.delete(scope);cancellations.delete(scope);return true;});
    io.restore.mockImplementation(async(scope:string,key:string)=>{if(records.has(scope)||cancellations.has(scope))return false;const archived=archives.get(scope+':'+key)!;if(archived.record)records.set(scope,archived.record);cancellations.set(scope,archived.intent);return true;});
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
    it.each(['files','upload'] as const)('503 на create сохраняет exact %s/CAS; GET reconciliation и recheck не отправляют POST до ручного повтора',async source=>{
        const actual=await vi.importActual<typeof import('../src/modules/Store/packaging/pendingBuild')>('../src/modules/Store/packaging/pendingBuild');
        io.resume.mockImplementation(actual.resumePendingBuild);io.lookup.mockRejectedValue(unavailable());
        const original:Omit<ToolBuildRequest,'requestKey'>={...body(),source:source==='files'?body().source:{type:'upload',uploadId:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),bytes:100,entrypoint:'bin/server'},publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}};
        await ready();io.create.mockRejectedValueOnce(unavailable());await current.submit(original);render(false);expect(current.error).toBe(unavailableMessage);render();await flush();render();
        const exact=structuredClone(records.get(scope)!.request);
        expect(exact).toEqual({...original,requestKey:expect.any(String)});expect(io.create.mock.calls[0][0]).toEqual(exact);
        expect(current.draft?.request).toEqual(exact);expect(io.clear).not.toHaveBeenCalled();expect(current.canCancel).toBe(true);
        original.name='Изменённая форма';if(original.source.type==='files')original.source.files[0].content='changed';else if(original.source.type==='upload')original.source.uploadId='44444444-4444-4444-8444-444444444444';
        await vi.advanceTimersByTimeAsync(45_000);await flush();render();
        expect(current.unresolved).toBe(true);expect(io.create).toHaveBeenCalledOnce();expect(io.lookup.mock.calls.length).toBeGreaterThan(1);expect(io.lookup.mock.calls.every(call=>call[0]===exact.requestKey)).toBe(true);
        const reads=io.lookup.mock.calls.length;current.recheck();render();await flush();expect(io.lookup.mock.calls.length).toBeGreaterThan(reads);expect(io.create).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(45_000);await flush();render();expect(current.unresolved).toBe(true);expect(records.get(scope)!.request).toEqual(exact);
        await current.retrySaved();render();expect(io.create).toHaveBeenCalledTimes(2);expect(io.create.mock.calls[1][0]).toEqual(exact);expect(current.job?.state).toBe('QUEUED');
    });
    it('Другая учётная запись не получает сохранённые исходники',async()=>{
        records.set('alice',{scope:'alice',schemaVersion:1,request:{...body(),requestKey:'11111111-1111-4111-8111-111111111111'}});scope='bob';await ready();
        expect(current.draft).toBeUndefined();expect(io.resume).not.toHaveBeenCalled();expect(io.create).not.toHaveBeenCalled();
    });
    it('Конфликт цели новой версии оставляет источник; явная новая цель отправляется с новым UUID',async()=>{
        await ready();const original={...body(),publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}};
        io.create.mockRejectedValueOnce(new AxiosError('Карточка изменилась','ERR_BAD_REQUEST',undefined,undefined,{status:409} as never));await current.submit(original);render();
        expect(current.unresolved).toBe(false);expect(records.has('alice')).toBe(false);expect(original.source).toEqual(body().source);
        await current.submit({...original,publication:{...original.publication,expectedVersion:8,expectedSourceHash:'c'.repeat(64)}});
        expect(io.create).toHaveBeenCalledTimes(2);const [first,second]=io.create.mock.calls.map(call=>call[0] as ToolBuildRequest);
        expect(second.requestKey).not.toBe(first.requestKey);expect(second.source).toEqual(first.source);expect(first.publication?.expectedVersion).toBe(7);expect(second.publication?.expectedVersion).toBe(8);
    });
    it('Неизвестный ACK новой версии повторяет exact CAS и прежний UUID после reload',async()=>{
        await ready();const original={...body(),targets:['darwin-arm64'],publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}};io.create.mockRejectedValueOnce(Error('Lost ACK'));await current.submit(original);const record=records.get('alice')!;
        const bytes=JSON.stringify(record.request);original.targets.push('linux-x64-glibc');
        hooks.dispose();io.resume.mockRejectedValue(new BuildRequestUnresolvedError());await ready();await flush();render();await current.retrySaved();
        expect(current.draft?.request.targets).toEqual(['darwin-arm64']);expect(JSON.stringify(io.create.mock.lastCall?.[0])).toBe(bytes);
        expect(io.create.mock.lastCall?.[0]).toEqual(record.request);expect(io.create.mock.calls[1][0].publication).toEqual(original.publication);expect(io.create.mock.calls[1][0].requestKey).toBe(record.request.requestKey);
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

describe('Отмена durable запроса упаковщика',()=>{
    it('До commit исходников отмена ждёт его; затем commit отмены предшествует DELETE и POST не запускается',async()=>{
        await ready();const storing=deferred<Record>();io.save.mockReturnValue(storing.promise);
        const sending=current.submit(body());render();const first=current.cancel(),second=current.cancel();await flush();
        expect(io.create).not.toHaveBeenCalled();expect(io.cancelRequest).not.toHaveBeenCalled();
        const request=io.save.mock.calls[0][1] as ToolBuildRequest;storing.resolve({scope,schemaVersion:1,request});
        await Promise.all([sending,first,second]);render();
        expect(io.saveCancel).toHaveBeenCalledOnce();expect(io.cancelRequest).toHaveBeenCalledExactlyOnceWith(request.requestKey,expect.any(AbortSignal));
        expect(cancellations.get(scope)?.id).toBe(request.requestKey);expect(current.cancelled).toBe(true);expect(current.active).toBe(false);expect(io.create).not.toHaveBeenCalled();
    });
    it('Отказ commit отмены не делает DELETE и сохраняет исходники для восстановления',async()=>{
        await ready();await current.submit(body());render();io.saveCancel.mockRejectedValue(new Error('Disk full'));
        await current.cancel();render();expect(io.cancelRequest).not.toHaveBeenCalled();expect(records.get(scope)).toBeDefined();expect(current.recoveryBlocked).toBe(true);expect(current.error).toContain('Disk full');
    });
    it('Lost POST ACK + lost DELETE ACK переживают reload и повторяют только DELETE прежнего requestKey',async()=>{
        await ready();io.create.mockRejectedValueOnce(new Error('Lost POST ACK'));await current.submit(body());render();
        const request=records.get(scope)!.request;io.cancelRequest.mockRejectedValueOnce(new Error('Lost DELETE ACK'));
        await current.cancel();render();expect(current.cancelPending).toBe(true);expect(cancellations.get(scope)?.id).toBe(request.requestKey);
        hooks.dispose();io.resume.mockClear();await ready();await flush();render();
        expect(io.cancelRequest.mock.calls.map(call=>call[0])).toEqual([request.requestKey,request.requestKey]);
        expect(io.create).toHaveBeenCalledOnce();expect(io.resume).not.toHaveBeenCalled();expect(current.cancelled).toBe(true);expect(current.draft?.request).toEqual(request);
    });
    it('503 на DELETE переживает reload с exact upload/CAS и повторяет только прежнюю отмену',async()=>{
        const original:Omit<ToolBuildRequest,'requestKey'>={...body(),source:{type:'upload',uploadId:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),bytes:100,entrypoint:'bin/server'},publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}};
        await ready();io.create.mockRejectedValueOnce(unavailable());await current.submit(original);render();const exact=structuredClone(records.get(scope)!.request);
        expect(exact).toEqual({...original,requestKey:expect.any(String)});expect(io.create.mock.calls[0][0]).toEqual(exact);
        io.cancelRequest.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable());await current.cancel();render();
        const intent=structuredClone(cancellations.get(scope));expect(current.error).toBe(unavailableMessage);expect(current.cancelPending).toBe(true);expect(current.cancelled).toBe(false);expect(current.canDetach).toBe(false);expect(await current.reset()).toBe(false);
        hooks.dispose();io.resume.mockClear();io.lookup.mockClear();await ready();await flush();render();
        expect(io.cancelRequest.mock.calls.map(call=>call[0])).toEqual([exact.requestKey,exact.requestKey]);expect(cancellations.get(scope)).toEqual(intent);expect(current.draft?.request).toEqual(exact);
        expect(current.cancelPending).toBe(true);expect(current.cancelled).toBe(false);expect(current.canDetach).toBe(false);expect(io.resume).not.toHaveBeenCalled();expect(io.lookup).not.toHaveBeenCalled();expect(io.create).toHaveBeenCalledOnce();
        await current.retrySaved();expect(io.create).toHaveBeenCalledOnce();await current.retryCancel();render();
        expect(io.cancelRequest.mock.calls.map(call=>call[0])).toEqual([exact.requestKey,exact.requestKey,exact.requestKey]);expect(current.cancelled).toBe(true);expect(current.draft?.request).toEqual(exact);expect(io.clear).not.toHaveBeenCalled();
    });
    it('403 на DELETE сохраняет intent и повтор отмены не вызывает POST или lookup',async()=>{
        await ready();await current.submit(body());render();io.cancelRequest.mockRejectedValueOnce(new AxiosError('No access','ERR_BAD_REQUEST',undefined,undefined,{status:403} as never));
        await current.cancel();render();const request=records.get(scope)!.request;
        expect(current.cancelPending).toBe(true);expect(cancellations.get(scope)?.id).toBe(request.requestKey);
        await current.retrySaved();expect(io.create).toHaveBeenCalledOnce();
        await current.retryCancel();render();expect(io.cancelRequest).toHaveBeenCalledTimes(2);expect(current.cancelled).toBe(true);
    });
    it.each(['success','400'] as const)('Поздний POST %s не отменяет подтверждённую отмену и не удаляет точное тело',async outcome=>{
        await ready();const response=deferred<ToolBuild>();io.create.mockReturnValueOnce(response.promise);const sending=current.submit(body());await flush();render();
        const request=records.get(scope)!.request;await current.cancel();render();expect(current.cancelled).toBe(true);
        if(outcome==='success')response.resolve(queued);else response.reject(new AxiosError('Invalid source','ERR_BAD_REQUEST',undefined,undefined,{status:400} as never));
        await sending;render();expect(current.cancelled).toBe(true);expect(current.active).toBe(false);expect(current.draft?.request).toEqual(request);expect(io.clear).not.toHaveBeenCalled();
    });
    it('Подтверждённая отмена позволяет вернуть форму до завершения зависшего POST; старый ACK не удерживает новую сборку',async()=>{
        await ready();const response=deferred<ToolBuild>();io.create.mockReturnValueOnce(response.promise);const sending=current.submit(body());await flush();render();
        const oldKey=records.get(scope)!.request.requestKey;await current.cancel();render();expect(await current.reset()).toBe(true);render();
        await current.submit({...body(),name:'Новая сборка'});render();const fresh=records.get(scope)!.request;
        expect(fresh.requestKey).not.toBe(oldKey);expect(current.job?.id).toBe(queued.id);
        response.resolve({...queued,id:'44444444-4444-4444-8444-444444444444'});await sending;render();
        expect(current.job?.id).toBe(queued.id);expect(current.draft?.request).toEqual(fresh);expect(current.submitting).toBe(false);
    });
    it('CANCELLING не выдаётся за CANCELLED; завершение worker подтверждается polling перед возвратом к форме',async()=>{
        await ready();await current.submit(body());render();io.cancelRequest.mockResolvedValueOnce({requestKey:records.get(scope)!.request.requestKey,state:'CANCELLING',build:{...queued,state:'CANCELLING'}});
        await current.cancel();render();expect(current.cancelled).toBe(false);expect(current.active).toBe(true);expect(await current.reset()).toBe(false);
        io.get.mockResolvedValue({...queued,state:'CANCELLED'});await vi.advanceTimersByTimeAsync(1000);render();
        expect(current.cancelled).toBe(true);expect(current.active).toBe(false);expect(await current.reset()).toBe(true);expect(cancellations.has(scope)).toBe(false);
    });
    it('FAILED после fence сохраняет exact источник/CAS и разрешает только ручной новый UUID после reset',async()=>{
        await ready();const original={...body(),publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}};
        const fence='2026-10-23T00:00:00Z',reason='Не удалось дождаться освобождения каталога. Публикация откачена; повторите сборку.';
        io.create.mockImplementation(async(request:ToolBuildRequest)=>({...queued,id:request.requestKey,requestKey:request.requestKey,state:'RUNNING',percent:95,publicationStartedAt:fence}));
        await current.submit(original);render();const exact=records.get(scope)!.request;
        expect(current.active).toBe(true);expect(current.canCancel).toBe(false);expect(await current.reset()).toBe(false);
        io.get.mockResolvedValueOnce({...current.job!,state:'FAILED',message:'Публикация остановлена',error:reason});
        await vi.advanceTimersByTimeAsync(1000);render();
        expect(current.job).toMatchObject({state:'FAILED',publicationStartedAt:fence,error:reason});expect(current.active).toBe(false);expect(current.draft?.request).toEqual(exact);expect(records.get(scope)!.request).toEqual(exact);expect(io.create).toHaveBeenCalledOnce();
        expect(await current.reset()).toBe(true);render();expect(current.job).toBeUndefined();expect(current.draft).toBeUndefined();expect(io.create).toHaveBeenCalledOnce();
        await current.submit(original);render();const next=io.create.mock.calls[1][0] as ToolBuildRequest;
        expect(next.requestKey).not.toBe(exact.requestKey);expect(next).toEqual({...exact,requestKey:next.requestKey});expect(next.source).toEqual(original.source);expect(next.publication).toEqual(original.publication);
    });
    it('Граница публикации отклоняет отмену честно и продолжает получать итог',async()=>{
        await ready();await current.submit(body());render();const publishing={...queued,state:'RUNNING' as const,publicationStartedAt:'2026-10-23T00:00:00Z'};
        io.cancelRequest.mockResolvedValueOnce({requestKey:records.get(scope)!.request.requestKey,state:'RUNNING',build:publishing});
        await current.cancel();render();expect(current.job?.publicationStartedAt).toBe(publishing.publicationStartedAt);expect(current.cancelPending).toBe(false);expect(current.cancelled).toBe(false);expect(current.canCancel).toBe(false);expect(current.error).toContain('Публикация уже началась');
        io.get.mockResolvedValue({...publishing,state:'SUCCEEDED'});await vi.advanceTimersByTimeAsync(1000);render();expect(current.job?.state).toBe('SUCCEEDED');expect(io.create).toHaveBeenCalledOnce();
    });
    it('Поздний DELETE после A → B → A не меняет восстановленную новую сборку',async()=>{
        await ready();await current.submit(body());render();const response=deferred<{requestKey:string;state:string;build:ToolBuild|null}>();io.cancelRequest.mockReturnValueOnce(response.promise);const cancelling=current.cancel();await flush();
        const old=records.get('alice')!.request.requestKey;cancellations.delete('alice');records.delete('alice');saveBuildCheckpoint('alice','job');saveBuildCheckpoint('alice','request');scope='bob';await ready();scope='alice';await ready();
        await current.submit({...body(),name:'Новое поколение'});render();const fresh=records.get(scope)!.request;
        response.resolve({requestKey:old,state:'CANCELLED',build:null});await cancelling;render();
        expect(current.cancelled).toBe(false);expect(current.draft?.request).toEqual(fresh);expect(current.job?.state).toBe('QUEUED');expect(current.error).toBe('');
    });
    it('Recovery без draft использует DELETE jobUUID и сохраняет отмену после потери ответа',async()=>{
        await ready();await current.submit(body());render();const id=current.job!.id;hooks.dispose();records.clear();io.read.mockResolvedValueOnce(undefined);io.get.mockResolvedValue(queued);await ready();await vi.advanceTimersByTimeAsync(1000);render();
        io.cancel.mockRejectedValueOnce(new Error('Lost ACK'));await current.cancel();render();expect(io.cancel).toHaveBeenCalledExactlyOnceWith(id,expect.any(AbortSignal));expect(cancellations.get(scope)).toMatchObject({target:'job',id});expect(current.cancelPending).toBe(true);
        io.cancel.mockResolvedValue({...queued,state:'CANCELLED'});await current.retryCancel();render();expect(current.cancelled).toBe(true);expect(io.cancelRequest).not.toHaveBeenCalled();
    });
});

describe('Ресурсы и durable граница отмены',()=>{
    it('DELETE не начинается до commit cancel-intent; двойной click не обходит незавершённый commit',async()=>{
        await ready();await current.submit(body());render();const pending=deferred<Cancellation>();io.saveCancel.mockReturnValueOnce(pending.promise);
        const first=current.cancel(),second=current.cancel();await flush();expect(io.cancelRequest).not.toHaveBeenCalled();expect(io.saveCancel).toHaveBeenCalledOnce();
        const [scope,target,id]=io.saveCancel.mock.calls[0] as [string,Cancellation['target'],string];pending.resolve({schemaVersion:1,scope,target,id});await Promise.all([first,second]);
        expect(io.cancelRequest).toHaveBeenCalledExactlyOnceWith(id,expect.any(AbortSignal));
    });
    it.each(['unmount','owner'] as const)('Закрывает локальное ожидание DELETE при %s, сохраняя intent для следующего replay',async change=>{
        await ready();await current.submit(body());render();const response=deferred<{requestKey:string;state:string;build:ToolBuild|null}>();io.cancelRequest.mockReturnValueOnce(response.promise);
        const running=current.cancel();await flush();const signal=io.cancelRequest.mock.calls[0][1] as AbortSignal,intent=cancellations.get('alice')!;
        if(change==='unmount')hooks.dispose();else {scope='bob';await ready();}
        expect(signal.aborted).toBe(true);expect(cancellations.get('alice')).toEqual(intent);
        response.resolve({requestKey:intent.id,state:'CANCELLED',build:null});await running;
        if(change==='owner'){render();expect(current.cancelled).toBe(false);expect(current.draft).toBeUndefined();}
    });
});

describe('Устаревшие действия и позднее чтение не перехватывают новую сборку',()=>{
    it('Старый onCancel после A → B → A не отменяет новую сборку A из актуального ref',async()=>{
        await ready();await current.submit(body());render();const old=current;
        scope='bob';await ready();records.delete('alice');saveBuildCheckpoint('alice','job');saveBuildCheckpoint('alice','request');scope='alice';await ready();
        await current.submit({...body(),name:'Новая карточка A'});render();const fresh=records.get(scope)!.request;
        await old.cancel();expect(io.cancelRequest).not.toHaveBeenCalled();expect(io.saveCancel).not.toHaveBeenCalled();expect(records.get(scope)?.request).toEqual(fresh);
    });
    it('Старые submit/reset не действуют на текущий scope до passive cleanup',async()=>{
        await ready();const old=current;scope='bob';render(false);await old.submit(body());expect(await old.reset()).toBe(false);
        expect(io.save).not.toHaveBeenCalled();expect(io.clear).not.toHaveBeenCalled();hooks.commit();await flush();
    });
    it('Поздний GET RUNNING после подтверждения и reset не оживляет старую сборку до passive cleanup',async()=>{
        await ready();await current.submit(body());render();const poll=deferred<ToolBuild>();io.get.mockReturnValueOnce(poll.promise);
        await vi.advanceTimersByTimeAsync(1000);expect(io.get).toHaveBeenCalledOnce();
        await current.cancel();render(false);expect(current.cancelled).toBe(true);expect(await current.reset()).toBe(true);
        poll.resolve({...queued,state:'RUNNING'});await flush();render();
        expect(current.job).toBeUndefined();expect(current.active).toBe(false);expect(current.cancelled).toBe(false);expect(records.has(scope)).toBe(false);
    });
});

describe('Продолжение после подтверждённой незавершённой отмены',()=>{
    it('CANCELLING ACK освобождает путь к новой сборке, сохраняя старую для отдельного восстановления',async()=>{
        await ready();await current.submit(body());render();const request=records.get(scope)!.request;
        io.cancelRequest.mockResolvedValueOnce({requestKey:request.requestKey,state:'CANCELLING',build:{...queued,requestKey:request.requestKey,publicationStartedAt:null,state:'CANCELLING',message:'Ожидаем подтверждение остановки прежнего сборщика. Можно запустить другую сборку.'}});
        await current.cancel();render();expect(current.canDetach).toBe(true);expect(current.cancelled).toBe(false);
        expect(await current.detach()).toBe(true);await ready();expect(current.active).toBe(false);expect(current.archived).toHaveLength(1);
        await current.submit({...body(),name:'Следующая сборка'});render();expect(io.create).toHaveBeenCalledTimes(2);expect(io.create.mock.calls[1][0].requestKey).not.toBe(request.requestKey);
    });
});

async function acknowledgedCancellation(){
    await ready();await current.submit(body());render();const request=records.get(scope)!.request;
    io.cancelRequest.mockResolvedValueOnce({requestKey:request.requestKey,state:'CANCELLING',build:{...queued,requestKey:request.requestKey,publicationStartedAt:null,state:'CANCELLING'}});
    await current.cancel();render();return request;
}
describe('Архивированная отмена остаётся отдельным восстанавливаемым запросом',()=>{
    it('Reload после detach читает историю, не вызывает старый DELETE автоматически; ручное открытие replay только прежний DELETE',async()=>{
        const request=await acknowledgedCancellation();expect(await current.detach()).toBe(true);await ready();hooks.dispose();io.cancelRequest.mockClear();io.resume.mockClear();await ready();
        expect(current.archived).toHaveLength(1);expect(current.draft).toBeUndefined();expect(io.cancelRequest).not.toHaveBeenCalled();expect(io.resume).not.toHaveBeenCalled();
        await current.restoreArchived(request.requestKey);await ready();await flush();render();
        expect(io.restore).toHaveBeenCalledExactlyOnceWith(scope,request.requestKey);expect(io.cancelRequest).toHaveBeenCalledExactlyOnceWith(request.requestKey,expect.any(AbortSignal));
        expect(current.draft?.request).toEqual(request);expect(current.cancelled).toBe(true);expect(io.create).toHaveBeenCalledOnce();expect(current.archived).toHaveLength(1);
    });
    it('Reload активной B сохраняет архив A и запрещает восстановить A поверх B',async()=>{
        const request=await acknowledgedCancellation();await current.detach();await ready();await current.submit({...body(),name:'Запрос B'});render();const second=records.get(scope)!.request;
        hooks.dispose();io.cancelRequest.mockClear();await ready();expect(current.draft?.request).toEqual(second);expect(current.archived[0].requestKey).toBe(request.requestKey);
        expect(current.canRestoreArchived).toBe(false);await current.restoreArchived(request.requestKey);expect(io.restore).not.toHaveBeenCalled();expect(io.cancelRequest).not.toHaveBeenCalled();expect(io.create).toHaveBeenCalledTimes(2);
    });
    it('GET CANCELLING после неизвестного DELETE не разрешает detach',async()=>{
        await ready();await current.submit(body());render();const request=records.get(scope)!.request;
        io.cancelRequest.mockRejectedValueOnce(new Error('Lost DELETE ACK'));await current.cancel();render();
        io.get.mockResolvedValue({...queued,requestKey:request.requestKey,publicationStartedAt:null,state:'CANCELLING'});await vi.advanceTimersByTimeAsync(1000);render();
        expect(current.job?.state).toBe('CANCELLING');expect(current.canDetach).toBe(false);expect(await current.detach()).toBe(false);expect(io.archive).not.toHaveBeenCalled();
    });
    it.each([401,403])('Свежий polling %s отзывает право detach до нового подтверждённого DELETE',async status=>{
        await acknowledgedCancellation();expect(current.canDetach).toBe(true);io.get.mockRejectedValueOnce(new AxiosError('Access changed','ERR_BAD_REQUEST',undefined,undefined,{status} as never));
        await vi.advanceTimersByTimeAsync(1000);render();expect(current.canDetach).toBe(false);expect(await current.detach()).toBe(false);expect(io.archive).not.toHaveBeenCalled();
    });
    it('Повтор DELETE с lost ACK отзывает ранее подтверждённый detach, сохраняя request+intent',async()=>{
        const request=await acknowledgedCancellation();io.cancelRequest.mockRejectedValueOnce(new Error('Lost retry ACK'));await current.retryCancel();render();
        expect(current.canDetach).toBe(false);expect(await current.detach()).toBe(false);expect(records.get(scope)?.request).toEqual(request);expect(cancellations.get(scope)?.id).toBe(request.requestKey);
    });
    it('Неудачная архивация не останавливает polling и не теряет точные исходники',async()=>{
        const request=await acknowledgedCancellation();io.archive.mockRejectedValueOnce(new Error('Disk full'));expect(await current.detach()).toBe(false);render();
        expect(current.error).toContain('Disk full');expect(current.active).toBe(true);expect(current.canDetach).toBe(true);expect(records.get(scope)?.request).toEqual(request);
        io.get.mockResolvedValue({...queued,requestKey:request.requestKey,state:'CANCELLED'});await vi.advanceTimersByTimeAsync(1000);render();expect(current.cancelled).toBe(true);expect(current.active).toBe(false);expect(cancellations.get(scope)?.id).toBe(request.requestKey);
    });
    it('Двойной detach ждёт один commit; stale cancel после него не восстанавливает прежнюю форму',async()=>{
        await acknowledgedCancellation();const old=current,pending=deferred<boolean>();io.archive.mockReturnValueOnce(pending.promise);
        const first=current.detach(),second=current.detach();expect(io.archive).toHaveBeenCalledOnce();pending.resolve(true);await Promise.all([first,second]);await ready();
        io.cancelRequest.mockClear();await old.cancel();await old.retryCancel();expect(io.cancelRequest).not.toHaveBeenCalled();expect(current.job).toBeUndefined();
    });
    it('Поздний archive commit владельца A не очищает активный запрос B',async()=>{
        await acknowledgedCancellation();const pending=deferred<boolean>();io.archive.mockReturnValueOnce(pending.promise);const archiving=current.detach();
        scope='bob';await ready();await current.submit({...body(),name:'Bob B'});render();const bob=records.get(scope)!.request;
        pending.resolve(true);expect(await archiving).toBe(false);render();expect(current.draft?.request).toEqual(bob);expect(current.job?.state).toBe('QUEUED');expect(current.archiving).toBe(false);
    });
    it('Cross-tab CAS отказ архивации сохраняет другую текущую форму и требует восстановления',async()=>{
        await acknowledgedCancellation();const other={scope,schemaVersion:1 as const,request:{...body(),requestKey:'22222222-2222-4222-8222-222222222222'}};records.set(scope,other);io.archive.mockResolvedValueOnce(false);
        expect(await current.detach()).toBe(false);render();expect(current.recoveryBlocked).toBe(true);expect(records.get(scope)).toEqual(other);expect(io.create).toHaveBeenCalledOnce();
    });
    it('Сбой загрузки архивов не блокирует новую форму и не превращается в POST старого запроса',async()=>{
        io.archives.mockRejectedValueOnce(new Error('Archive unavailable'));await ready();expect(current.archiveError).toContain('Archive unavailable');expect(current.recoveryBlocked).toBe(false);
        await current.submit(body());expect(io.create).toHaveBeenCalledOnce();
    });
});

describe('Архив является авторитетным после crash между IDBcommit и очисткой navigation',()=>{
    it.each(['job','request'] as const)('Reload со старым %s checkpoint A оставляет архив и допускает новый UUID B без повторного API A',async kind=>{
        const request=await acknowledgedCancellation();await current.detach();await ready();
        const before=structuredClone(archives.get(scope+':'+request.requestKey));
        saveBuildCheckpoint(scope,kind,kind==='job'?queued.id:request.requestKey);hooks.dispose();io.get.mockClear();io.resume.mockClear();io.cancelRequest.mockClear();
        io.get.mockResolvedValue({...queued,requestKey:request.requestKey,publicationStartedAt:null,state:'CANCELLING'});io.resume.mockResolvedValue({...queued,requestKey:request.requestKey,state:'CANCELLING'});
        await ready();await vi.advanceTimersByTimeAsync(1000);render();
        expect(current.active).toBe(false);expect(current.job).toBeUndefined();expect(current.draft).toBeUndefined();expect(current.archived).toHaveLength(1);
        expect(io.get).not.toHaveBeenCalled();expect(io.resume).not.toHaveBeenCalled();expect(io.cancelRequest).not.toHaveBeenCalled();
        await current.submit({...body(),name:'Новый B после crash'});expect(io.create).toHaveBeenCalledTimes(2);expect(io.create.mock.calls[1][0].requestKey).not.toBe(request.requestKey);
        expect(archives.get(scope+':'+request.requestKey)).toEqual(before);
    });
    it('Current B имеет приоритет над старым A checkpoint и не теряет архивные bytes A',async()=>{
        const request=await acknowledgedCancellation();await current.detach();await ready();await current.submit({...body(),name:'Текущий B'});render();const second=records.get(scope)!.request;
        saveBuildCheckpoint(scope,'job',queued.id);hooks.dispose();io.cancelRequest.mockClear();io.get.mockClear();io.resume.mockClear();await ready();
        expect(current.draft?.request).toEqual(second);expect(current.archived[0].requestKey).toBe(request.requestKey);expect(io.cancelRequest).not.toHaveBeenCalled();expect(io.resume.mock.lastCall?.[0]).toBe(second.requestKey);
    });
});

describe('Checkpoint не запускает транспорт раньше авторитетного IDB recovery',()=>{
    it('Медленный readonly admission старого A не начинает GET/lookup до ответа архива',async()=>{
        await acknowledgedCancellation();await current.detach();await ready();saveBuildCheckpoint(scope,'job',queued.id);hooks.dispose();io.get.mockClear();io.resume.mockClear();
        const reading=deferred<Record|undefined>();io.read.mockReturnValueOnce(reading.promise);await ready();await vi.advanceTimersByTimeAsync(1500);render();
        expect(current.recovering).toBe(true);expect(io.get).not.toHaveBeenCalled();expect(io.resume).not.toHaveBeenCalled();
        reading.resolve(undefined);await flush();render();expect(current.recovering).toBe(false);expect(current.active).toBe(false);expect(io.get).not.toHaveBeenCalled();
    });
});
