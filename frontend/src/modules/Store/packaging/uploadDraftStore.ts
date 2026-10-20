import {sourceUploadLimit,type SourceUploadIntent} from './uploadTypes';
const database='neurocenter-source-uploads',storeName='intents';
interface Record {scope:string;intent:SourceUploadIntent}
const failure=()=>new Error('Хранилище загрузки недоступно. Файл ещё не отправлен. Разрешите хранение данных сайта и повторите.');
function valid(value:unknown):value is SourceUploadIntent{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const raw=value as SourceUploadIntent;
 return Object.keys(raw).every(key=>['requestKey','name','sha256','bytes'].includes(key))&&typeof raw.requestKey==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw.requestKey)&&typeof raw.name==='string'&&!!raw.name&&raw.name.length<=240&&!/[\\/\x00-\x1f\x7f]/.test(raw.name)&&typeof raw.sha256==='string'&&/^[a-f0-9]{64}$/.test(raw.sha256)&&Number.isSafeInteger(raw.bytes)&&raw.bytes>0&&raw.bytes<=sourceUploadLimit;
}
function decode(value:unknown,scope:string):SourceUploadIntent|undefined{
 if(value===undefined)return;const row=value as Record;if(!row||row.scope!==scope||!valid(row.intent))throw new Error('Сохранённый запрос загрузки повреждён. Проверьте его состояние перед новой попыткой.');return row.intent;
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
export function readUploadIntent(scope:string){return transaction<SourceUploadIntent|undefined>('readonly',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{done(decode(request.result,scope));}catch(error){fail(error as Error);}};});}
/** CAS prevents two tabs from changing the source bytes under the same upload UUID. */
export function saveUploadIntent(scope:string,intent:SourceUploadIntent){
 if(!scope||!valid(intent))return Promise.reject(new Error('Некорректный запрос загрузки.'));
 return transaction<SourceUploadIntent>('readwrite',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{const old=decode(request.result,scope);if(old&&JSON.stringify(old)!==JSON.stringify(intent))throw new Error('Уже сохранена другая загрузка. Сначала отмените или завершите её.');store.put({scope,intent:structuredClone(intent)} satisfies Record);done(structuredClone(intent));}catch(error){fail(error as Error);}};});
}
export function clearUploadIntent(scope:string,key?:string){return transaction<boolean>('readwrite',(store,done,fail)=>{const request=store.get(scope);request.onsuccess=()=>{try{const old=decode(request.result,scope);if(old&&old.requestKey!==key){done(false);return;}store.delete(scope);done(true);}catch(error){fail(error as Error);}};});}
