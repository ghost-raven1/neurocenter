import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBDatabase,IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {clearSnapshotIntent,readSnapshotIntent,saveSnapshotIntent} from '../src/features/ProjectSnapshots/snapshotDraftStore';
import {clearRestoreIntent,readRestoreIntent,saveRestoreIntent} from '../src/modules/Maintenance/restore/restoreDraftStore';
import {clearUploadIntent,readUploadIntent,saveUploadIntent} from '../src/modules/Store/packaging/uploadDraftStore';

const scope='lifecycle@example.test',key='11111111-1111-4111-8111-111111111111';
const snapshot={projectId:'project-one',kind:'create' as const,input:{requestKey:key,deviceId:'22222222-2222-4222-8222-222222222222',expectedBindingId:'a'.repeat(64),expectedHeadId:null,expectedHeadRevision:0}};
const restore={kind:'preview' as const,input:{requestKey:key,checkpointId:'checkpoint-one',checkpointSha256:'a'.repeat(64),targetProject:'nc-restore-one'}};
const upload={requestKey:key,name:'source.zip',sha256:'a'.repeat(64),bytes:4096};
const stores=[
    {name:'snapshot',database:'neurocenter-project-snapshots',value:snapshot,read:()=>readSnapshotIntent(scope,snapshot.projectId),save:()=>saveSnapshotIntent(scope,snapshot),clear:()=>clearSnapshotIntent(scope,snapshot.projectId,key)},
    {name:'restore',database:'neurocenter-web-restore',value:restore,read:()=>readRestoreIntent(scope),save:()=>saveRestoreIntent(scope,restore),clear:()=>clearRestoreIntent(scope,key)},
    {name:'upload',database:'neurocenter-source-uploads',value:upload,read:()=>readUploadIntent(scope),save:()=>saveUploadIntent(scope,upload),clear:()=>clearUploadIntent(scope,key)},
];

beforeEach(()=>vi.stubGlobal('indexedDB',new IDBFactory()));
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

/** Controlled events cover transport timing; transaction rollback cases use the actual IDB emulator. */
function pendingDatabase(){
    const request={} as IDBRequest;
    const store={get:()=>request} as unknown as IDBObjectStore;
    const tx={objectStore:()=>store,abort:vi.fn()} as unknown as IDBTransaction;
    const db={transaction:vi.fn(()=>tx),close:vi.fn()} as unknown as IDBDatabase;
    const opening={result:db} as IDBOpenDBRequest;
    vi.stubGlobal('indexedDB',{open:()=>opening});
    return {opening,db,tx};
}
const event=new Event('test');

describe.each(stores)('$name durable intent lifecycle',adapter=>{
    it('Refuses damaged stored confirmation and preserves it instead of replacing an unknown request',async()=>{
        await adapter.read();
        const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(adapter.database,1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        const damaged={scope,intent:{unexpected:'unknown request'}};
        const stored=async(write=false)=>new Promise<unknown>((resolve,reject)=>{
            const transaction=database.transaction('intents',write?'readwrite':'readonly'),store=transaction.objectStore('intents');
            const request=write?store.put(damaged):store.get(scope);let value:unknown;
            request.onsuccess=()=>{value=request.result;};transaction.oncomplete=()=>resolve(value);transaction.onabort=()=>reject(transaction.error);
        });
        try{await stored(true);await expect(adapter.read()).rejects.toThrow(/поврежд[её]н/);await expect(adapter.save()).rejects.toThrow(/поврежд[её]н/);expect(await stored()).toEqual(damaged);}
        finally{database.close();}
    });

    it('Rejects denied browser storage before creating a transaction',async()=>{
        const open=vi.fn(()=>{throw new DOMException('Denied','SecurityError');});vi.stubGlobal('indexedDB',{open});
        await expect(adapter.save()).rejects.toThrow('Хранилище');expect(open).toHaveBeenCalledOnce();
    });

    it.each(['blocked','deadline'] as const)('Bounds %s opening and closes a late handle without executing a transaction',async mode=>{
        vi.useFakeTimers();const {opening,db}=pendingDatabase();const result=adapter.save().catch(cause=>cause);
        if(mode==='blocked')opening.onblocked?.(event as IDBVersionChangeEvent);else await vi.advanceTimersByTimeAsync(5000);
        expect(await result).toBeInstanceOf(Error);opening.onsuccess?.(event);
        expect(db.close).toHaveBeenCalledOnce();expect(db.transaction).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });

    it('Rejects a failed open and ignores subsequent timeout and late success',async()=>{
        vi.useFakeTimers();const {opening,db}=pendingDatabase();const result=adapter.read().catch(cause=>cause);
        opening.onerror?.(event);expect(await result).toBeInstanceOf(Error);await vi.advanceTimersByTimeAsync(5000);opening.onsuccess?.(event);
        expect(db.close).toHaveBeenCalledOnce();expect(db.transaction).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });

    it('Closes the handle if transaction creation throws',async()=>{
        vi.useFakeTimers();const {opening,db}=pendingDatabase();vi.mocked(db.transaction).mockImplementation(()=>{throw new DOMException('Closing','InvalidStateError');});
        const result=adapter.save().catch(cause=>cause);opening.onsuccess?.(event);
        expect(await result).toBeInstanceOf(Error);expect(db.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });

    it('Aborts a stalled transaction once, closes it, and clears the deadline',async()=>{
        vi.useFakeTimers();const {opening,db,tx}=pendingDatabase();const result=adapter.save().catch(cause=>cause);opening.onsuccess?.(event);
        await vi.advanceTimersByTimeAsync(5000);expect(await result).toBeInstanceOf(Error);
        expect(tx.abort).toHaveBeenCalledOnce();expect(db.close).toHaveBeenCalledOnce();tx.onabort?.(event);
        expect(db.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });

    it('Waits for the abort event after a transaction error',async()=>{
        vi.useFakeTimers();const {opening,db,tx}=pendingDatabase();let settled=false;
        const result=adapter.read().then(()=>{settled=true;},cause=>{settled=true;return cause;});opening.onsuccess?.(event);tx.onerror?.(event);
        await Promise.resolve();expect(settled).toBe(false);expect(db.close).not.toHaveBeenCalled();tx.onabort?.(event);
        expect(await result).toBeInstanceOf(Error);expect(db.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });

    it('Releases the connection on version change while waiting for transaction completion',async()=>{
        vi.useFakeTimers();const {opening,db,tx}=pendingDatabase();let settled=false;
        const result=adapter.read().finally(()=>{settled=true;});opening.onsuccess?.(event);db.onversionchange?.(event as IDBVersionChangeEvent);
        await Promise.resolve();expect(settled).toBe(false);expect(db.close).toHaveBeenCalledOnce();tx.oncomplete?.(event);await result;
        expect(vi.getTimerCount()).toBe(0);expect(tx.abort).not.toHaveBeenCalled();
    });

    it('An acknowledged put followed by transaction abort leaves no durable confirmation',async()=>{
        const put=IDBObjectStore.prototype.put;
        const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
            const request=put.apply(this,args);request.addEventListener('success',()=>this.transaction.abort());return request;
        });
        await expect(adapter.save()).rejects.toThrow('Хранилище');spy.mockRestore();expect(await adapter.read()).toBeUndefined();
    });

    it('An acknowledged delete followed by abort preserves the exact pending confirmation',async()=>{
        await adapter.save();const remove=IDBObjectStore.prototype.delete;
        const spy=vi.spyOn(IDBObjectStore.prototype,'delete').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['delete']>){
            const request=remove.apply(this,args);request.addEventListener('success',()=>this.transaction.abort());return request;
        });
        await expect(adapter.clear()).rejects.toThrow('Хранилище');spy.mockRestore();expect(await adapter.read()).toEqual(adapter.value);
    });

    it('Quota failure does not replace or partially write a confirmation',async()=>{
        const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('Disk full','QuotaExceededError');});
        await expect(adapter.save()).rejects.toThrow('Disk full');spy.mockRestore();expect(await adapter.read()).toBeUndefined();
    });

    it('Uses strict durability for mutations and readonly transactions for recovery',async()=>{
        const transaction=vi.spyOn(IDBDatabase.prototype,'transaction');await adapter.save();await adapter.read();await adapter.clear();
        const calls=transaction.mock.calls.filter(([,mode])=>mode==='readwrite'||mode==='readonly');
        expect(calls.map(([,mode,options])=>({mode,durability:options?.durability}))).toEqual([
            {mode:'readwrite',durability:'strict'},{mode:'readonly',durability:undefined},{mode:'readwrite',durability:'strict'},
        ]);
    });
});
