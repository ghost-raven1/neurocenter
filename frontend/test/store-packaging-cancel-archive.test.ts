import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {archiveStoredBuildCancellation,clearStoredBuildDraft,listStoredBuildArchives,readStoredBuildRecovery,restoreStoredBuildArchive,saveStoredBuildCancellation,saveStoredBuildDraft} from '../src/modules/Store/packaging/buildDraftStore';
import type {ToolBuildRequest} from '../src/modules/Store/packaging/types';
const key='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',job='33333333-3333-4333-8333-333333333333';
const request=(requestKey=key):ToolBuildRequest=>({requestKey,kind:'mcp',name:'Ручное имя',description:'Точное описание',source:{type:'files',entrypoint:'index.ts',files:[{path:'index.ts',content:'original bytes\n'}]}});
const ack={id:job,requestKey:key,state:'CANCELLING' as const};
beforeEach(()=>vi.stubGlobal('indexedDB',new IDBFactory()));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function active(){await saveStoredBuildDraft('alice',request());return saveStoredBuildCancellation('alice','request',key);}
async function archived(){const intent=await active();expect(await archiveStoredBuildCancellation('alice',key,intent,ack)).toBe(true);return intent;}

describe('Архив незавершённой подтверждённой отмены',()=>{
    it('Архив и восстановление сохраняют UUID и CAS новой версии без обновления цели',async()=>{
        const value={...request(),publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}};
        await saveStoredBuildDraft('alice',value);const intent=await saveStoredBuildCancellation('alice','request',key);
        expect(await archiveStoredBuildCancellation('alice',key,intent,ack)).toBe(true);expect(await restoreStoredBuildArchive('alice',key)).toBe(true);
        expect((await readStoredBuildRecovery('alice')).draft?.request).toEqual(value);
    });
    it('Архивирует точные исходники, intent и ACK; освобождает текущую форму без ложного CANCELLED',async()=>{
        const intent=await archived();expect(await readStoredBuildRecovery('alice')).toEqual({draft:undefined,cancellation:undefined});
        expect(await listStoredBuildArchives('alice')).toEqual([{requestKey:key,jobId:job,name:'Ручное имя'}]);expect(await listStoredBuildArchives('bob')).toEqual([]);
        await saveStoredBuildDraft('alice',request(other));expect((await readStoredBuildRecovery('alice')).draft?.request.requestKey).toBe(other);
        expect(await restoreStoredBuildArchive('alice',key)).toBe(false);expect((await readStoredBuildRecovery('alice')).draft?.request.requestKey).toBe(other);
        expect(await clearStoredBuildDraft('alice',other)).toBe(true);expect(await restoreStoredBuildArchive('alice',key)).toBe(true);
        expect(await readStoredBuildRecovery('alice')).toEqual({draft:{schemaVersion:1,scope:'alice',request:request()},cancellation:intent});
        expect(await listStoredBuildArchives('alice')).toHaveLength(1);
    });
    it('Reload при активной B не восстанавливает архив A сам по себе',async()=>{
        await archived();await saveStoredBuildDraft('alice',request(other));
        expect((await readStoredBuildRecovery('alice')).draft?.request).toEqual(request(other));expect(await listStoredBuildArchives('alice')).toHaveLength(1);
        expect(await restoreStoredBuildArchive('alice',key)).toBe(false);expect((await readStoredBuildRecovery('alice')).draft?.request).toEqual(request(other));
    });
    it('Другой пользователь не открывает сохранённые исходники и отмену A',async()=>{
        await archived();await expect(restoreStoredBuildArchive('bob',key)).rejects.toThrow('не найден');expect(await readStoredBuildRecovery('bob')).toEqual({draft:undefined,cancellation:undefined});
    });
    it.each(['wrong-key','wrong-ack','missing-intent'] as const)('CAS %s не освобождает чужую текущую форму',async change=>{
        const intent=await active();const expected=change==='wrong-key'?other:key;
        if(change==='missing-intent'){expect(await clearStoredBuildDraft('alice',key,intent)).toBe(true);await saveStoredBuildDraft('alice',request());}
        if(change==='wrong-ack')await expect(archiveStoredBuildCancellation('alice',key,intent,{...ack,requestKey:other})).rejects.toThrow('не подтвердил');
        else expect(await archiveStoredBuildCancellation('alice',expected,intent,ack)).toBe(false);
        expect((await readStoredBuildRecovery('alice')).draft?.request).toEqual(request());expect(await listStoredBuildArchives('alice')).toEqual([]);
    });
    it('Quota failure при записи архива оставляет текущие исходники+intent атомарно',async()=>{
        const intent=await active(),original=IDBObjectStore.prototype.put;
        const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){if(this.name==='archivedRequests')throw new DOMException('Disk full','QuotaExceededError');return original.apply(this,args);});
        await expect(archiveStoredBuildCancellation('alice',key,intent,ack)).rejects.toThrow('Disk full');spy.mockRestore();
        expect(await readStoredBuildRecovery('alice')).toEqual({draft:{schemaVersion:1,scope:'alice',request:request()},cancellation:intent});expect(await listStoredBuildArchives('alice')).toEqual([]);
    });
    it('Abort после удаления текущего slot откатывает и архив, и оба текущих store',async()=>{
        const intent=await active(),original=IDBObjectStore.prototype.delete;
        const spy=vi.spyOn(IDBObjectStore.prototype,'delete').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['delete']>){const result=original.apply(this,args);if(this.name==='cancellations')result.addEventListener('success',()=>this.transaction.abort());return result;});
        await expect(archiveStoredBuildCancellation('alice',key,intent,ack)).rejects.toThrow();spy.mockRestore();
        expect((await readStoredBuildRecovery('alice')).cancellation).toEqual(intent);expect((await readStoredBuildRecovery('alice')).draft?.request).toEqual(request());expect(await listStoredBuildArchives('alice')).toEqual([]);
    });
    it('Две вкладки restoreA/createB фиксируют ровно один текущий intent без перезаписи',async()=>{
        await archived();const results=await Promise.allSettled([restoreStoredBuildArchive('alice',key),saveStoredBuildDraft('alice',request(other))]);
        const restored=results[0].status==='fulfilled'&&results[0].value===true,created=results[1].status==='fulfilled';expect(Number(restored)+Number(created)).toBe(1);
        expect((await readStoredBuildRecovery('alice')).draft?.request.requestKey).toBe(restored?key:other);expect(await listStoredBuildArchives('alice')).toHaveLength(1);
    });
    it('Повторное открытие/архивирование той же отмены сохраняет неизменный архив',async()=>{
        const intent=await archived();expect(await restoreStoredBuildArchive('alice',key)).toBe(true);expect(await archiveStoredBuildCancellation('alice',key,intent,ack)).toBe(true);
        expect(await listStoredBuildArchives('alice')).toHaveLength(1);expect(await restoreStoredBuildArchive('alice',key)).toBe(true);expect((await readStoredBuildRecovery('alice')).draft?.request).toEqual(request());
    });
    it('Восстановление job-only отмены сохраняет UUID даже без исходников текущего устройства',async()=>{
        const intent=await saveStoredBuildCancellation('alice','job',job);expect(await archiveStoredBuildCancellation('alice',undefined,intent,ack)).toBe(true);
        expect(await restoreStoredBuildArchive('alice',key)).toBe(true);expect(await readStoredBuildRecovery('alice')).toEqual({draft:undefined,cancellation:intent});
    });
    it('Upgrade v2→v3 сохраняет незавершённый exact-request и cancel-intent',async()=>{
        const database=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open('neurocenter-tool-builds',2);open.onupgradeneeded=()=>{open.result.createObjectStore('requests',{keyPath:'scope'});open.result.createObjectStore('cancellations',{keyPath:'scope'});};open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
        const intent={schemaVersion:1,scope:'alice',target:'request',id:key},tx=database.transaction(['requests','cancellations'],'readwrite');
        tx.objectStore('requests').put({scope:'alice',schemaVersion:1,requestJSON:JSON.stringify(request())});tx.objectStore('cancellations').put(intent);
        await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});database.close();
        expect(await readStoredBuildRecovery('alice')).toEqual({draft:{schemaVersion:1,scope:'alice',request:request()},cancellation:intent});expect(await listStoredBuildArchives('alice')).toEqual([]);
    });
});

describe('Атомарная сверка navigation checkpoints с IDB архивом',()=>{
    it.each([{jobId:job},{requestKey:key}])('После committed archive пустой current игнорирует checkpoint %j без потери исходников',async checkpoint=>{
        const intent=await archived();expect(await readStoredBuildRecovery('alice',checkpoint)).toEqual({draft:undefined,cancellation:undefined,archivedCheckpoint:true});
        expect(await restoreStoredBuildArchive('alice',key)).toBe(true);expect(await readStoredBuildRecovery('alice',checkpoint)).toEqual({draft:{schemaVersion:1,scope:'alice',request:request()},cancellation:intent});
    });
    it('Другой текущий B имеет приоритет над старым архивным navigation A',async()=>{
        await archived();await saveStoredBuildDraft('alice',request(other));
        expect(await readStoredBuildRecovery('alice',{jobId:job,requestKey:key})).toEqual({draft:{schemaVersion:1,scope:'alice',request:request(other)},cancellation:undefined});
        expect(await readStoredBuildRecovery('bob',{jobId:job,requestKey:key})).toEqual({draft:undefined,cancellation:undefined});
    });
});

describe('Повторная отмена из старой вкладки сохраняет неизменяемый exact archive',()=>{
    it.each(['request','job'] as const)('No-draft reattach %s того же job/key не заменяет сохранённые исходники fallback записью',async target=>{
        const originalIntent=await archived();const fallback=await saveStoredBuildCancellation('alice',target,target==='job'?job:key);
        expect(await archiveStoredBuildCancellation('alice',undefined,fallback,ack)).toBe(true);
        expect(await restoreStoredBuildArchive('alice',key)).toBe(true);expect(await readStoredBuildRecovery('alice')).toEqual({draft:{schemaVersion:1,scope:'alice',request:request()},cancellation:originalIntent});
        expect(await listStoredBuildArchives('alice')).toEqual([{requestKey:key,jobId:job,name:'Ручное имя'}]);
    });
    it('No-draft reattach другого job под прежним request UUID не освобождает slot и не меняет архив',async()=>{
        await archived();const intent=await saveStoredBuildCancellation('alice','request',key);
        await expect(archiveStoredBuildCancellation('alice',undefined,intent,{...ack,id:other})).rejects.toThrow('другие исходники');
        expect((await readStoredBuildRecovery('alice')).cancellation).toEqual(intent);expect(await listStoredBuildArchives('alice')).toEqual([{requestKey:key,jobId:job,name:'Ручное имя'}]);
    });
});
