import type {RestoreIntent} from './types';
const database='neurocenter-web-restore',storeName='intents';
interface Record {scope:string;intent:RestoreIntent}
const failure=()=>new Error('Хранилище подтверждения недоступно. Запрос не отправлен. Разрешите хранение данных сайта и повторите.');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validRestoreIntent(value:unknown):value is RestoreIntent{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const raw=value as RestoreIntent;
 if(Object.keys(raw).sort().join(',')!=='input,kind'||!raw.input||typeof raw.input!=='object'||Array.isArray(raw.input)||!uuid(raw.input.requestKey))return false;
 const input=raw.input;
 return raw.kind==='preview'?Object.keys(input).sort().join(',')==='checkpointId,checkpointSha256,requestKey,targetProject'&&typeof raw.input.checkpointId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(raw.input.checkpointId)&&sha(raw.input.checkpointSha256)&&typeof raw.input.targetProject==='string'&&/^[a-z0-9][a-z0-9_-]{2,62}$/.test(raw.input.targetProject)
 :raw.kind==='restore'&&Object.keys(input).sort().join(',')==='confirmation,digest,previewId,requestKey'&&uuid(raw.input.previewId)&&sha(raw.input.digest)&&typeof raw.input.confirmation==='string'&&/^RESTORE [a-z0-9][a-z0-9_-]{2,62}$/.test(raw.input.confirmation);
}
function decode(value:unknown,scope:string):RestoreIntent|undefined{
 if(value===undefined)return;const row=value as Record;if(!row||row.scope!==scope||!validRestoreIntent(row.intent))throw new Error('Сохранённое подтверждение повреждено. Сначала проверьте историю запросов с администратором.');return row.intent;
}
async function transaction<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void,fail:(error:Error)=>void)=>void):Promise<T>{
 return new Promise((resolve,reject)=>{
  let db:IDBDatabase|undefined,tx:IDBTransaction|undefined,settled=false,value:T,cause:Error|undefined;
  const close=()=>{settled=true;clearTimeout(timer);db?.close();},fail=(error:Error)=>{cause=error;try{tx?.abort();}catch{}if(!settled){close();reject(error);}};
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
export function readRestoreIntent(scope:string){return transaction<RestoreIntent|undefined>('readonly',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{done(decode(request.result,scope));}catch(error){fail(error as Error);}};});}
/** Read+compare+write выполняются одной IDB транзакцией, в том числе между двумя вкладками. */
export function saveRestoreIntent(scope:string,intent:RestoreIntent,expectedKey?:string){
 if(!scope||!validRestoreIntent(intent))return Promise.reject(new Error('Некорректное подтверждение восстановления.'));
 return transaction<RestoreIntent>('readwrite',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{const old=decode(request.result,scope);if(old&&JSON.stringify(old)!==JSON.stringify(intent)&&old.input.requestKey!==expectedKey)throw new Error('В другой вкладке уже сохранён запрос восстановления. Обновите его состояние.');store.put({scope,intent:structuredClone(intent)} satisfies Record);done(structuredClone(intent));}catch(error){fail(error as Error);}};});
}
export function clearRestoreIntent(scope:string,key:string){return transaction<boolean>('readwrite',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{const old=decode(request.result,scope);if(old&&old.input.requestKey!==key){done(false);return;}store.delete(scope);done(true);}catch(error){fail(error as Error);}};});}
