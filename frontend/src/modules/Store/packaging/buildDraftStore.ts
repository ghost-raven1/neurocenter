import type {ToolBuildRequest} from './types';

export interface StoredBuildDraft {schemaVersion:1;scope:string;request:ToolBuildRequest}
interface DraftRecord {scope:string;schemaVersion:1;requestJSON:string}
const databaseName='neurocenter-tool-builds';
const storeName='requests';
const maximumBytes=32*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const storageError=()=>new Error('Хранилище запросов упаковки недоступно. Разрешите хранение данных сайта и повторите.');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fields=(value:Record<string,unknown>,allowed:string[]):boolean=>Object.keys(value).every(key=>allowed.includes(key));
const text=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();

/** Повреждённая запись не должна попасть в форму с вызовами trim/map или в повторный POST. */
function validSource(value:unknown):boolean {
    if(!object(value))return false;
    if(value.type==='upload')return fields(value,['type','uploadId','sha256','bytes','entrypoint'])&&typeof value.uploadId==='string'&&uuid.test(value.uploadId)
        &&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&Number.isSafeInteger(value.bytes)&&Number(value.bytes)>0&&Number(value.bytes)<=256*1024**2&&text(value.entrypoint);
    if(value.type==='npm')return fields(value,['type','specifier','entrypoint'])&&text(value.specifier)
        &&(value.entrypoint===undefined||text(value.entrypoint));
    if(value.type==='files')return fields(value,['type','files','entrypoint','args'])&&text(value.entrypoint)
        &&Array.isArray(value.files)&&value.files.length>0&&value.files.every(file=>object(file)&&fields(file,['path','content','encoding'])&&text(file.path)&&typeof file.content==='string'&&(file.encoding===undefined||file.encoding==='base64'))
        &&(value.args===undefined||Array.isArray(value.args)&&value.args.every(arg=>typeof arg==='string'));
    if(value.type!=='repository'||!fields(value,['type','url','ref','subdirectory','entrypoint','release'])
        ||!text(value.url)||typeof value.ref!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.ref)
        ||!text(value.entrypoint)||(value.subdirectory!==undefined&&!text(value.subdirectory)))return false;
    if(value.release===undefined)return true;
    const release=value.release;
    return object(release)&&fields(release,['tag','asset','id','assetId','sha256'])&&text(release.tag)&&text(release.asset)
        &&Number.isSafeInteger(release.id)&&Number(release.id)>0&&Number.isSafeInteger(release.assetId)&&Number(release.assetId)>0
        &&typeof release.sha256==='string'&&/^[a-f0-9]{64}$/.test(release.sha256);
}

/** Восстановление не доверяет изменяемым данным браузера больше, чем новой форме. */
function requestJSON(request:ToolBuildRequest):string {
    if(!request||Object.keys(request).some(key=>!['requestKey','kind','name','description','source'].includes(key))
        ||!uuid.test(request.requestKey)||!['mcp','plugin','skill'].includes(request.kind)||typeof request.name!=='string'||typeof request.description!=='string'
        ||!validSource(request.source))throw new Error('Сохранённый запрос упаковки повреждён. Проверьте операции перед новой сборкой.');
    if(request.kind==='skill'&&(request.source.type!=='files'&&request.source.type!=='repository'
        ||!/(?:^|\/)SKILL\.md$/.test(request.source.entrypoint)||request.source.entrypoint.split('/').some(part=>!part||part==='.'||part==='..'||/[\\\x00-\x1f\x7f]/.test(part))||'release'in request.source&&request.source.release!==undefined
        ||'args'in request.source&&request.source.args!==undefined))throw new Error('Скилл восстанавливается из SKILL.md и ресурсов, без команды запуска.');
    const bytes=JSON.stringify(request);
    if(new TextEncoder().encode(bytes).length>maximumBytes)throw new Error('Исходники упаковки превышают лимит локального восстановления.');
    return bytes;
}
function decode(value:unknown,scope:string):StoredBuildDraft|undefined {
    if(value===undefined)return undefined;
    const record=value as DraftRecord;
    if(!record||record.schemaVersion!==1||record.scope!==scope||typeof record.requestJSON!=='string'||new TextEncoder().encode(record.requestJSON).length>maximumBytes)throw new Error('Сохранённый запрос упаковки повреждён. Проверьте операции перед новой сборкой.');
    const request=JSON.parse(record.requestJSON) as ToolBuildRequest;requestJSON(request);
    return {schemaVersion:1,scope,request};
}

/** Каждый вызов закрывает соединение; blocked/open timeout не оставляет поздний активный handle. */
async function open():Promise<IDBDatabase> {
    return new Promise((resolve,reject)=>{
        let settled=false,request:IDBOpenDBRequest;
        const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);reject(storageError());};
        const timer=setTimeout(fail,5000);
        try{request=indexedDB.open(databaseName,1);}catch{fail();return;}
        request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(storeName))request.result.createObjectStore(storeName,{keyPath:'scope'});};
        request.onerror=fail;request.onblocked=fail;
        request.onsuccess=()=>{
            if(settled){request.result.close();return;}
            settled=true;clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(request.result);
        };
    });
}

/** Результат записи подтверждается commit транзакции, а не отдельным успешным put. */
async function transaction<T>(scope:string,mode:IDBTransactionMode,action:(store:IDBObjectStore,finish:(value:T)=>void,fail:(cause:Error)=>void)=>void):Promise<T> {
    if(!scope||scope.length>8192)throw new Error('Не определён владелец запроса упаковки.');
    const database=await open();
    return new Promise((resolve,reject)=>{
        let value:T,cause:Error|undefined,tx:IDBTransaction;
        const close=()=>{clearTimeout(timer);database.close();};
        const fail=(error:Error)=>{cause=error;try{tx.abort();}catch{close();reject(cause);}};
        const timer=setTimeout(()=>fail(storageError()),5000);
        try{
            tx=database.transaction(storeName,mode,mode==='readwrite'?{durability:'strict'}:undefined);
            tx.oncomplete=()=>{close();resolve(value);};
            tx.onabort=()=>{close();reject(cause??storageError());};
            tx.onerror=()=>{cause??=storageError();};
            action(tx.objectStore(storeName),next=>{value=next;},fail);
        }catch(error){close();reject(error);}
    });
}

export async function readStoredBuildDraft(scope:string):Promise<StoredBuildDraft|undefined> {
    return transaction(scope,'readonly',(store,finish,fail)=>{
        const read=store.get(scope);read.onsuccess=()=>{try{finish(decode(read.result,scope));}catch(cause){fail(cause as Error);}};
    });
}

/** CAS защищает два окна и повторную отправку от подмены тела под сохранённым UUID. */
export async function saveStoredBuildDraft(scope:string,request:ToolBuildRequest):Promise<StoredBuildDraft> {
    const exact=requestJSON(request);
    return transaction(scope,'readwrite',(store,finish,fail)=>{
        const read=store.get(scope);read.onsuccess=()=>{
            try{
                const previous=decode(read.result,scope);
                if(previous&&requestJSON(previous.request)!==exact)throw new Error('Уже сохранён другой запрос упаковки. Сначала восстановите его состояние.');
                store.put({scope,schemaVersion:1,requestJSON:exact} satisfies DraftRecord);
                finish({scope,schemaVersion:1,request:JSON.parse(exact) as ToolBuildRequest});
            }catch(cause){fail(cause as Error);}
        };
    });
}

/** Поздняя очистка старого намерения не удаляет следующую сборку того же пользователя. */
export async function clearStoredBuildDraft(scope:string,expectedKey?:string):Promise<boolean> {
    return transaction<boolean>(scope,'readwrite',(store,finish,fail)=>{
        const read=store.get(scope);read.onsuccess=()=>{
            try{
                const previous=decode(read.result,scope);
                if(previous&&previous.request.requestKey!==expectedKey){finish(false);return;}
                if(previous)store.delete(scope);finish(true);
            }catch(cause){fail(cause as Error);}
        };
    });
}
