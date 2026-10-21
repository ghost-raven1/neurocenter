import type {SnapshotIntent} from './types';
const database='neurocenter-project-snapshots',storeName='intents';
interface StoredIntent {scope:string;intent:SnapshotIntent}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,expected:string[])=>Object.keys(value).sort().join(',')===[...expected].sort().join(',');
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const revision=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const head=(value:Record<string,unknown>)=>(value.expectedHeadId===null||uuid(value.expectedHeadId))&&revision(value.expectedHeadRevision);
/** Reject damaged durable data before it can become a network mutation. */
export function validSnapshotIntent(value:unknown):value is SnapshotIntent{
    if(!object(value)||typeof value.projectId!=='string'||!value.projectId.trim()||value.projectId.length>200||!object(value.input)||!uuid(value.input.requestKey))return false;
    const input=value.input;
    if(value.kind==='create')return keys(value,['projectId','kind','input'])&&keys(input,['requestKey','deviceId','expectedBindingId','expectedHeadId','expectedHeadRevision'])&&uuid(input.deviceId)&&sha(input.expectedBindingId)&&head(input);
    if(value.kind==='release')return keys(value,['projectId','kind','input'])&&keys(input,['requestKey','snapshotId','expectedProfileId','expectedProfileRevision',...(input.moveHead===undefined?[]:['moveHead'])])&&uuid(input.snapshotId)
        &&(input.expectedProfileId===null||uuid(input.expectedProfileId))&&revision(input.expectedProfileRevision)
        &&(input.moveHead===undefined||object(input.moveHead)&&keys(input.moveHead,['expectedHeadId','expectedHeadRevision'])&&head(input.moveHead));
    if(!keys(value,['projectId','kind','snapshotId','input'])||!uuid(value.snapshotId))return false;
    if(value.kind==='activate'||value.kind==='rollback')return keys(input,['requestKey','expectedHeadId','expectedHeadRevision'])&&head(input);
    if(value.kind==='cancel')return keys(input,['requestKey']);
    return value.kind==='delete'&&keys(input,['requestKey','expectedManifest','gracePeriodHours'])&&(input.expectedManifest===null||sha(input.expectedManifest))&&Number.isInteger(input.gracePeriodHours)&&Number(input.gracePeriodHours)>=1&&Number(input.gracePeriodHours)<=720;
}
export const snapshotDraftScope=(email:string,projectId:string)=>JSON.stringify([email.trim().toLowerCase(),projectId]);
const failure=()=>new Error('Хранилище подтверждения недоступно. Запрос не отправлен. Разрешите хранение данных сайта и повторите.');
function decode(value:unknown,scope:string,projectId:string):SnapshotIntent|undefined{
    if(value===undefined)return;
    if(!object(value)||value.scope!==scope||!validSnapshotIntent(value.intent)||value.intent.projectId!==projectId)throw new Error('Сохранённый запрос снимка повреждён. Проверьте историю запросов с администратором.');
    return value.intent;
}
function transaction<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void,fail:(cause:Error)=>void)=>void):Promise<T>{
    return new Promise((resolve,reject)=>{
        let db:IDBDatabase|undefined,tx:IDBTransaction|undefined,settled=false,value:T,cause:Error|undefined;
        const close=()=>{settled=true;clearTimeout(timer);db?.close();};
        const fail=(error:Error)=>{cause=error;try{tx?.abort();}catch{}if(!settled){close();reject(error);}};
        const timer=setTimeout(()=>fail(failure()),5000);let request:IDBOpenDBRequest;
        try{request=indexedDB.open(database,1);}catch{fail(failure());return;}
        request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(storeName))request.result.createObjectStore(storeName,{keyPath:'scope'});};
        request.onerror=()=>fail(failure());request.onblocked=()=>fail(failure());
        request.onsuccess=()=>{
            if(settled){request.result.close();return;}db=request.result;db.onversionchange=()=>db?.close();
            try{tx=db.transaction(storeName,mode,mode==='readwrite'?{durability:'strict'}:undefined);tx.oncomplete=()=>{close();resolve(value);};tx.onabort=()=>{if(!settled){close();reject(cause??failure());}};tx.onerror=()=>{cause??=failure();};work(tx.objectStore(storeName),next=>{value=next;},fail);}catch{fail(failure());}
        };
    });
}
export function readSnapshotIntent(scope:string,projectId:string){return transaction<SnapshotIntent|undefined>('readonly',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{done(decode(request.result,scope,projectId));}catch(cause){fail(cause as Error);}};});}
/** A single readwrite transaction serializes competing tabs; no new intent replaces a pending one. */
export function saveSnapshotIntent(scope:string,intent:SnapshotIntent){
    if(!scope||!validSnapshotIntent(intent))return Promise.reject(new Error('Некорректное подтверждение снимка.'));
    return transaction<SnapshotIntent>('readwrite',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{
        const old=decode(request.result,scope,intent.projectId);
        if(old&&JSON.stringify(old)!==JSON.stringify(intent))throw new Error('В другой вкладке уже сохранён запрос снимка. Обновите его состояние.');
        store.put({scope,intent:structuredClone(intent)} satisfies StoredIntent);done(structuredClone(intent));
    }catch(cause){fail(cause as Error);}};});
}
export function clearSnapshotIntent(scope:string,projectId:string,requestKey:string){return transaction<boolean>('readwrite',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{
    const old=decode(request.result,scope,projectId);if(old&&old.input.requestKey!==requestKey){done(false);return;}store.delete(scope);done(true);
}catch(cause){fail(cause as Error);}};});}
