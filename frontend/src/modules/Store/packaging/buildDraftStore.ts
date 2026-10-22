import type {ToolBuildRequest} from './types';

export interface StoredBuildDraft {schemaVersion:1;scope:string;request:ToolBuildRequest}
export interface StoredBuildCancellation {schemaVersion:1;scope:string;target:'request'|'job';id:string}
export interface ArchivedBuildSummary {requestKey:string;jobId:string;name:string}
export interface BuildCancellationAcknowledgment {id:string;requestKey:string;state:'CANCELLING'}
interface ArchivedBuildRecord extends ArchivedBuildSummary {schemaVersion:1;scope:string;acknowledgedState:'CANCELLING';requestJSON?:string;cancellation:StoredBuildCancellation}
interface DraftRecord {scope:string;schemaVersion:1;requestJSON:string}
const databaseName='neurocenter-tool-builds';
const storeName='requests';
const cancellationStore='cancellations';
const archiveStore='archivedRequests';
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
        try{request=indexedDB.open(databaseName,3);}catch{fail();return;}
        request.onupgradeneeded=()=>{
            for(const name of [storeName,cancellationStore])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'scope'});
            if(!request.result.objectStoreNames.contains(archiveStore))request.result.createObjectStore(archiveStore,{keyPath:['scope','requestKey']}).createIndex('scope','scope');
        };
        request.onerror=fail;request.onblocked=fail;
        request.onsuccess=()=>{
            if(settled){request.result.close();return;}
            settled=true;clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(request.result);
        };
    });
}

/** Результат записи подтверждается commit транзакции, а не отдельным успешным put. */
async function transaction<T>(scope:string,mode:IDBTransactionMode,action:(store:IDBObjectStore,finish:(value:T)=>void,fail:(cause:Error)=>void,tx:IDBTransaction)=>void):Promise<T> {
    if(!scope||scope.length>8192)throw new Error('Не определён владелец запроса упаковки.');
    const database=await open();
    return new Promise((resolve,reject)=>{
        let value:T,cause:Error|undefined,tx:IDBTransaction;
        const close=()=>{clearTimeout(timer);database.close();};
        const fail=(error:Error)=>{cause=error;try{tx.abort();}catch{close();reject(cause);}};
        const timer=setTimeout(()=>fail(storageError()),5000);
        try{
            tx=database.transaction([storeName,cancellationStore,archiveStore],mode,mode==='readwrite'?{durability:'strict'}:undefined);
            tx.oncomplete=()=>{close();resolve(value);};
            tx.onabort=()=>{close();reject(cause??storageError());};
            tx.onerror=()=>{cause??=storageError();};
            action(tx.objectStore(storeName),next=>{value=next;},fail,tx);
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
    return transaction(scope,'readwrite',(store,finish,fail,tx)=>{
        const cancelled=tx.objectStore(cancellationStore).get(scope);
        const read=store.get(scope);read.onsuccess=()=>{
            try{
                const previous=decode(read.result,scope);
                if(cancelled.result)throw new Error('Сначала подтвердите отмену сохранённой сборки. Новый запрос не отправлен.');
                if(previous&&requestJSON(previous.request)!==exact)throw new Error('Уже сохранён другой запрос упаковки. Сначала восстановите его состояние.');
                store.put({scope,schemaVersion:1,requestJSON:exact} satisfies DraftRecord);
                finish({scope,schemaVersion:1,request:JSON.parse(exact) as ToolBuildRequest});
            }catch(cause){fail(cause as Error);}
        };
    });
}

/** Поздняя очистка старого намерения не удаляет следующую сборку того же пользователя. */
export async function clearStoredBuildDraft(scope:string,expectedKey?:string,expectedCancellation?:StoredBuildCancellation):Promise<boolean> {
    return transaction<boolean>(scope,'readwrite',(store,finish,fail,tx)=>{
        const cancellations=tx.objectStore(cancellationStore),cancellation=cancellations.get(scope);
        const read=store.get(scope);read.onsuccess=()=>{
            try{
                const previous=decode(read.result,scope);
                if(previous&&previous.request.requestKey!==expectedKey){finish(false);return;}
                const intent=decodeCancellation(cancellation.result,scope);
                if(intent&&!sameCancellation(intent,expectedCancellation)){finish(false);return;}
                if(intent)cancellations.delete(scope);
                if(previous)store.delete(scope);finish(true);
            }catch(cause){fail(cause as Error);}
        };
    });
}

function decodeCancellation(value:unknown,scope:string):StoredBuildCancellation|undefined {
    if(value===undefined)return;
    if(!object(value)||!fields(value,['scope','schemaVersion','target','id'])||value.schemaVersion!==1||value.scope!==scope
        ||!['request','job'].includes(String(value.target))||typeof value.id!=='string'||!uuid.test(value.id))throw new Error('Сохранённая отмена упаковки повреждена. Проверьте операции.');
    return value as unknown as StoredBuildCancellation;
}
const sameCancellation=(a:StoredBuildCancellation,b?:StoredBuildCancellation):boolean=>!!b&&a.scope===b.scope&&a.target===b.target&&a.id===b.id;

export async function readStoredBuildCancellation(scope:string):Promise<StoredBuildCancellation|undefined> {
    return transaction(scope,'readonly',(_store,finish,fail,tx)=>{
        const read=tx.objectStore(cancellationStore).get(scope);read.onsuccess=()=>{try{finish(decodeCancellation(read.result,scope));}catch(cause){fail(cause as Error);}};
    });
}

/** Форма и отмена читаются одним снимком, чтобы не смешать поколения разных вкладок. */
export async function readStoredBuildRecovery(scope:string,checkpoint?:{jobId?:string;requestKey?:string}):Promise<{draft?:StoredBuildDraft;cancellation?:StoredBuildCancellation;archivedCheckpoint?:boolean}> {
    return transaction(scope,'readonly',(store,finish,fail,tx)=>{
        const cancel=tx.objectStore(cancellationStore).get(scope),read=store.get(scope);
        read.onsuccess=()=>{try{
            const draft=decode(read.result,scope),cancellation=decodeCancellation(cancel.result,scope);
            if(draft&&cancellation?.target==='request'&&draft.request.requestKey!==cancellation.id)throw new Error('Сохранённая отмена не соответствует исходному запросу. Проверьте операции.');
            const recovery={draft,cancellation};
            if(draft||cancellation||!checkpoint?.jobId&&!checkpoint?.requestKey){finish(recovery);return;}
            const cursor=tx.objectStore(archiveStore).index('scope').openCursor(scope);
            cursor.onsuccess=()=>{try{
                if(!cursor.result){finish(recovery);return;}
                const archived=archiveRecord(cursor.result.value,scope);
                if(archived.jobId===checkpoint.jobId||archived.requestKey===checkpoint.requestKey){finish({...recovery,archivedCheckpoint:true});return;}
                cursor.result.continue();
            }catch(cause){fail(cause as Error);}};
        }catch(cause){fail(cause as Error);}};
    });
}

/** Намерение отмены фиксируется до DELETE; поздний POST и другое окно не могут заменить его. */
export async function saveStoredBuildCancellation(scope:string,target:StoredBuildCancellation['target'],id:string,expectedKey?:string):Promise<StoredBuildCancellation> {
    const intent=decodeCancellation({schemaVersion:1,scope,target,id},scope)!;
    return transaction(scope,'readwrite',(store,finish,fail,tx)=>{
        const cancellations=tx.objectStore(cancellationStore),cancel=cancellations.get(scope),read=store.get(scope);
        read.onsuccess=()=>{try{
            const previous=decode(read.result,scope),pending=decodeCancellation(cancel.result,scope);
            if(previous&&previous.request.requestKey!==(target==='request'?id:expectedKey)||pending&&!sameCancellation(pending,intent))throw new Error('Запрос упаковки изменён в другой вкладке. Восстановите его перед отменой.');
            cancellations.put(intent);finish(intent);
        }catch(cause){fail(cause as Error);}};
    });
}

/** Удаляется только подтверждённое намерение; исходная заполненная форма остаётся до явного возврата. */
export async function clearStoredBuildCancellation(scope:string,expected:StoredBuildCancellation):Promise<boolean> {
    return transaction(scope,'readwrite',(_store,finish,fail,tx)=>{
        const cancellations=tx.objectStore(cancellationStore),read=cancellations.get(scope);
        read.onsuccess=()=>{try{const pending=decodeCancellation(read.result,scope);if(pending&&!sameCancellation(pending,expected)){finish(false);return;}if(pending)cancellations.delete(scope);finish(true);}catch(cause){fail(cause as Error);}};
    });
}

function archiveRecord(value:unknown,scope:string):ArchivedBuildRecord {
    if(!object(value)||!fields(value,['schemaVersion','scope','requestKey','jobId','name','requestJSON','cancellation','acknowledgedState'])||value.schemaVersion!==1||value.scope!==scope||value.acknowledgedState!=='CANCELLING'
        ||typeof value.requestKey!=='string'||!uuid.test(value.requestKey)||typeof value.jobId!=='string'||!uuid.test(value.jobId)||typeof value.name!=='string'
        ||value.name.length>128||value.requestJSON!==undefined&&(typeof value.requestJSON!=='string'||new TextEncoder().encode(value.requestJSON).length>maximumBytes))throw new Error('Сохранённый запрос упаковки повреждён. Проверьте операции.');
    const cancellation=decodeCancellation(value.cancellation,scope);
    if(!cancellation||cancellation.id!==(cancellation.target==='request'?value.requestKey:value.jobId))throw new Error('Сохранённая отмена не соответствует архивному запросу.');
    return value as unknown as ArchivedBuildRecord;
}

/** История читает по одному заголовку; большие исходники разбираются только при восстановлении. */
export async function listStoredBuildArchives(scope:string):Promise<ArchivedBuildSummary[]> {
    return transaction(scope,'readonly',(_store,finish,fail,tx)=>{
        const result:ArchivedBuildSummary[]=[],cursor=tx.objectStore(archiveStore).index('scope').openCursor(scope);
        cursor.onsuccess=()=>{try{
            if(!cursor.result){finish(result);return;}
            const record=archiveRecord(cursor.result.value,scope);result.push({requestKey:record.requestKey,jobId:record.jobId,name:record.name});cursor.result.continue();
        }catch(cause){fail(cause as Error);}};
    });
}

/** Успешный CANCELLING ACK освобождает только текущий CAS-slot; исходники и отмена остаются доступны. */
export async function archiveStoredBuildCancellation(scope:string,expectedKey:string|undefined,intent:StoredBuildCancellation,ack:BuildCancellationAcknowledgment):Promise<boolean> {
    if(ack.state!=='CANCELLING'||!uuid.test(ack.id)||!uuid.test(ack.requestKey)||intent.id!==(intent.target==='request'?ack.requestKey:ack.id))throw new Error('Сервер ещё не подтвердил отмену этой сборки.');
    return transaction(scope,'readwrite',(store,finish,fail,tx)=>{
        const cancellations=tx.objectStore(cancellationStore),archives=tx.objectStore(archiveStore),cancel=cancellations.get(scope),old=archives.get([scope,ack.requestKey]),read=store.get(scope);
        read.onsuccess=()=>{try{
            const draft=decode(read.result,scope),pending=decodeCancellation(cancel.result,scope);
            if(draft?.request.requestKey!==expectedKey||!pending||!sameCancellation(pending,intent)||draft&&draft.request.requestKey!==ack.requestKey){finish(false);return;}
            const record:ArchivedBuildRecord={schemaVersion:1,scope,requestKey:ack.requestKey,jobId:ack.id,acknowledgedState:'CANCELLING',name:draft?.request.name||'Сборка инструмента',cancellation:pending,...(draft?{requestJSON:requestJSON(draft.request)}:{})};
            if(old.result){
                const previous=archiveRecord(old.result,scope);
                if(previous.requestKey!==ack.requestKey||previous.jobId!==ack.id||draft&&previous.requestJSON!==record.requestJSON)throw new Error('Сохранённый запрос уже содержит другие исходники. Текущая форма не изменена.');
                // A stale tab may recover only job/intent; never replace an existing exact archive with that fallback.
            }
            if(!old.result)archives.put(record);
            if(draft)store.delete(scope);cancellations.delete(scope);finish(true);
        }catch(cause){fail(cause as Error);}};
    });
}

/** Восстановление не перезаписывает текущую сборку и продолжает только прежний DELETE, без POST. */
export async function restoreStoredBuildArchive(scope:string,key:string):Promise<boolean> {
    if(!uuid.test(key))throw new Error('Некорректный идентификатор сохранённого запроса.');
    return transaction(scope,'readwrite',(store,finish,fail,tx)=>{
        const cancellations=tx.objectStore(cancellationStore),pending=cancellations.get(scope),current=store.get(scope),read=tx.objectStore(archiveStore).get([scope,key]);
        read.onsuccess=()=>{try{
            if(current.result!==undefined||pending.result!==undefined){finish(false);return;}
            if(read.result===undefined)throw new Error('Сохранённый запрос не найден. Проверьте операции.');
            const record=archiveRecord(read.result,scope);
            if(record.requestJSON!==undefined){
                const draft={schemaVersion:1 as const,scope,requestJSON:record.requestJSON};
                if(decode(draft,scope)?.request.requestKey!==key)throw new Error('Исходники не соответствуют сохранённому запросу.');store.put(draft);
            }
            cancellations.put(record.cancellation);finish(true);
        }catch(cause){fail(cause as Error);}};
    });
}
