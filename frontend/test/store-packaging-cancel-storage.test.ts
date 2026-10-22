import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {clearStoredBuildCancellation,clearStoredBuildDraft,readStoredBuildCancellation,readStoredBuildDraft,readStoredBuildRecovery,saveStoredBuildCancellation,saveStoredBuildDraft} from '../src/modules/Store/packaging/buildDraftStore';
import type {ToolBuildRequest} from '../src/modules/Store/packaging/types';

const key='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const body=(requestKey=key):ToolBuildRequest=>({requestKey,kind:'mcp',name:'Ручное имя',description:'Сохранённое описание',source:{type:'files',entrypoint:'index.ts',files:[{path:'index.ts',content:'original bytes\n'}]}});
beforeEach(()=>vi.stubGlobal('indexedDB',new IDBFactory()));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

async function legacyDatabase(){
    const database=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open('neurocenter-tool-builds',1);open.onupgradeneeded=()=>open.result.createObjectStore('requests',{keyPath:'scope'});open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    const tx=database.transaction('requests','readwrite');tx.objectStore('requests').put({schemaVersion:1,scope:'alice',requestJSON:JSON.stringify(body())});
    await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});database.close();
}

describe('Durable intent отмены упаковщика',()=>{
    it('Обновление IndexedDB v1→v2 сохраняет точный запрос и добавляет отмену без пересоздания исходников',async()=>{
        await legacyDatabase();const previous=await readStoredBuildDraft('alice');expect(previous?.request).toEqual(body());
        const intent=await saveStoredBuildCancellation('alice','request',key);
        expect(await readStoredBuildRecovery('alice')).toEqual({draft:previous,cancellation:intent});
        expect(await readStoredBuildRecovery('bob')).toEqual({draft:undefined,cancellation:undefined});
    });
    it('Подтверждённая отмена без известного job сохраняется после закрытия соединения',async()=>{
        const intent=await saveStoredBuildCancellation('alice','request',key);
        expect(await readStoredBuildCancellation('alice')).toEqual(intent);expect(await readStoredBuildDraft('alice')).toBeUndefined();
        await expect(saveStoredBuildDraft('alice',body(other))).rejects.toThrow('подтвердите отмену');
        expect(await clearStoredBuildDraft('alice',undefined,intent)).toBe(true);expect(await readStoredBuildRecovery('alice')).toEqual({draft:undefined,cancellation:undefined});
    });
    it('Отмена не меняет точные bytes и CAS закрывает отмену чужого запроса из другой вкладки',async()=>{
        await saveStoredBuildDraft('alice',body());
        await expect(saveStoredBuildCancellation('alice','request',other)).rejects.toThrow('другой вкладке');
        expect(await readStoredBuildCancellation('alice')).toBeUndefined();expect((await readStoredBuildDraft('alice'))?.request).toEqual(body());
        const intent=await saveStoredBuildCancellation('alice','request',key);expect(await saveStoredBuildCancellation('alice','request',key)).toEqual(intent);
        await expect(saveStoredBuildCancellation('alice','job',other,key)).rejects.toThrow('другой вкладке');
        expect((await readStoredBuildDraft('alice'))?.request).toEqual(body());
    });
    it('Отмена по jobUUID с известным draft проверяет исходный requestKey',async()=>{
        await saveStoredBuildDraft('alice',body());
        await expect(saveStoredBuildCancellation('alice','job',other)).rejects.toThrow('другой вкладке');
        const intent=await saveStoredBuildCancellation('alice','job',other,key);expect(await readStoredBuildCancellation('alice')).toEqual(intent);
    });
    it('Сброс или поздний HTTP400 не стирает неизвестную отмену до её подтверждения',async()=>{
        await saveStoredBuildDraft('alice',body());const intent=await saveStoredBuildCancellation('alice','request',key);
        expect(await clearStoredBuildDraft('alice',key)).toBe(false);expect(await readStoredBuildCancellation('alice')).toEqual(intent);
        expect(await clearStoredBuildDraft('alice',key,intent)).toBe(true);expect(await readStoredBuildDraft('alice')).toBeUndefined();expect(await readStoredBuildCancellation('alice')).toBeUndefined();
    });
    it('Поздняя очистка отмены A не удаляет сохранённую отмену B',async()=>{
        const previous=await saveStoredBuildCancellation('alice','request',key);expect(await clearStoredBuildCancellation('alice',previous)).toBe(true);
        const fresh=await saveStoredBuildCancellation('alice','request',other);expect(await clearStoredBuildCancellation('alice',previous)).toBe(false);
        expect(await clearStoredBuildDraft('alice',undefined,previous)).toBe(false);expect(await readStoredBuildCancellation('alice')).toEqual(fresh);
    });
    it('Новый request и отмена другого UUID не могут одновременно захватить scope из двух вкладок',async()=>{
        const results=await Promise.allSettled([saveStoredBuildCancellation('alice','request',key),saveStoredBuildDraft('alice',body(other))]);
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
        const restored=await readStoredBuildRecovery('alice');expect(!!restored.draft).not.toBe(!!restored.cancellation);
        expect(restored.draft?.request.requestKey??restored.cancellation?.id).toBe(results[0].status==='fulfilled'?key:other);
    });
    it('Успешный put отмены с abort транзакции не выдаётся за commit и не портит исходники',async()=>{
        await saveStoredBuildDraft('alice',body());const original=IDBObjectStore.prototype.put;
        const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){const request=original.apply(this,args);if(this.name==='cancellations')request.addEventListener('success',()=>this.transaction.abort());return request;});
        await expect(saveStoredBuildCancellation('alice','request',key)).rejects.toThrow();spy.mockRestore();
        expect(await readStoredBuildCancellation('alice')).toBeUndefined();expect((await readStoredBuildDraft('alice'))?.request).toEqual(body());
    });
    it('Один атомарный reset не оставляет прежний intent после удаления исходников',async()=>{
        await saveStoredBuildDraft('alice',body());const intent=await saveStoredBuildCancellation('alice','request',key);const original=IDBObjectStore.prototype.delete;
        const spy=vi.spyOn(IDBObjectStore.prototype,'delete').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['delete']>){const request=original.apply(this,args);if(this.name==='requests')request.addEventListener('success',()=>this.transaction.abort());return request;});
        await expect(clearStoredBuildDraft('alice',key,intent)).rejects.toThrow();spy.mockRestore();
        expect(await readStoredBuildRecovery('alice')).toEqual({draft:{schemaVersion:1,scope:'alice',request:body()},cancellation:intent});
    });
    it.each(['../job','',other.replace(/^./,'z')])('Некорректный target UUID %s отклоняется до доступа к БД',async id=>{
        const open=vi.spyOn(indexedDB,'open');await expect(saveStoredBuildCancellation('alice','request',id)).rejects.toThrow();expect(open).not.toHaveBeenCalled();
    });
});
