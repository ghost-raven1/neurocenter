import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,open,rename,rm,unlink,lstat,readlink,utimes} from 'node:fs/promises';
import path from 'node:path';
import {hostname} from 'node:os';
import {safeDirectory,verifyFile} from './bundle-files.mjs';

const digest=/^[a-f0-9]{64}$/,tagPath=/^models\/manifests\/registry\.ollama\.ai\/[a-z0-9_-]+\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const managed='.bundle-managed',queues=new Map(),leases=new Map();
const namespace=process.platform==='linux'?await readlink('/proc/self/ns/pid').catch(()=>hostname()):hostname();
const leaseTimeout=5000;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const conflict=()=>Object.assign(new Error('Манифест существующего файла модели не принадлежит проверенной поставке. Данные сохранены. Проверьте immutable alias и журнал подготовки; пользовательские теги не перезаписываются.'),{code:'MODEL_MANAGED_CONFLICT'});
const invalid=()=>new Error('Квитанция управляемой поставки моделей повреждена. Данные сохранены.');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

function validateTag(tag) {
    if(!plain(tag)||!tagPath.test(tag.path)||!Number.isSafeInteger(tag.size)||tag.size<1||tag.size>128*1024||!digest.test(tag.sha256)
        ||typeof tag.inlineBase64!=='string')throw invalid();
    const bytes=Buffer.from(tag.inlineBase64,'base64');
    if(bytes.length!==tag.size||hash(bytes)!==tag.sha256||bytes.toString('base64')!==tag.inlineBase64)throw invalid();
    return tag;
}

function revision(tags) {
    const files=tags.map(tag=>({path:tag.path,size:tag.size,sha256:tag.sha256,inlineBase64:tag.inlineBase64})).sort((a,b)=>a.path.localeCompare(b.path));
    files.forEach(validateTag);
    if(!files.length||new Set(files.map(file=>file.path)).size!==files.length)throw invalid();
    const value={schemaVersion:1,kind:'neurocenter-managed-models',tags:files};
    return {id:hash(JSON.stringify(value)),value};
}

async function readJson(directory,name) {
    await safeDirectory(directory,path.posix.dirname(`${managed}/${name}`));
    let handle;
    try {
        const filename=path.join(directory,managed,name),info=await lstat(filename);
        if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024**2)throw invalid();
        handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const before=await handle.stat();if(before.ino!==info.ino||before.dev!==info.dev)throw invalid();
        return JSON.parse(await handle.readFile('utf8'));
    }catch(error){if(error.code==='ENOENT')return undefined;throw error;}
    finally{await handle?.close();}
}

async function maybeJson(directory,name) {
    try{return await readJson(directory,name);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}

async function syncFolder(folder) {
    if(process.platform==='win32')return;
    const handle=await open(folder,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await handle.sync();}finally{await handle.close();}
}

async function atomicBytes(directory,relative,bytes) {
    const parent=await safeDirectory(directory,path.posix.dirname(relative),true),filename=path.join(directory,relative);
    try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw invalid();}catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(parent,`.managed-${randomUUID()}`),handle=await open(temporary,'wx',0o600);
    try {
        try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
        await assertLease(directory);await rename(temporary,filename);await syncFolder(parent);
    }finally{await rm(temporary,{force:true});}
}

const writeJson=(directory,name,value)=>atomicBytes(directory,`${managed}/${name}`,JSON.stringify(value)+'\n');

function validatePointer(value) {
    if(!plain(value)||value.schemaVersion!==1||!digest.test(value.revision)||value.previous!==undefined&&!digest.test(value.previous))throw invalid();
    return value;
}

async function readRevision(directory,id) {
    if(!digest.test(id))throw invalid();
    const value=await readJson(directory,`revisions/${id}.json`);
    if(!value||value.schemaVersion!==1||value.kind!=='neurocenter-managed-models'||!Array.isArray(value.tags)||revision(value.tags).id!==id)throw invalid();
    return value.tags;
}

/** Квитанция разрешает заменять только тег, SHA которого совпадает с предыдущей проверенной поставкой. */
export async function managedModelState(directory) {
    const pointer=await maybeJson(directory,'active.json');
    if(!pointer)return {pointer:undefined,tags:[]};
    validatePointer(pointer);return {pointer,tags:await readRevision(directory,pointer.revision)};
}

async function matches(directory,tag,filename=tag?.path) {
    if(!tag) {try{await lstat(path.join(directory,filename));return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
    try{return await verifyFile(path.join(directory,tag.path),tag);}catch(error){if(error.code)throw error;return false;}
}

export async function managedTagPresent(directory,tag,state) {
    if(await matches(directory,tag))return true;
    const previous=state.tags.find(file=>file.path===tag.path);
    if(previous&&await matches(directory,previous))return false;
    try{await lstat(path.join(directory,tag.path));}catch(error){if(error.code==='ENOENT')return false;throw error;}
    throw conflict();
}

/** Lease fencing не позволяет старому процессу продолжать запись после возврата блокировки. */
async function assertLease(directory) {
    const token=leases.get(directory);if(!token)return;
    const owner=await maybeJson(directory,'activation.lock/owner.json');
    if(owner?.token!==token)throw new Error('Блокировка активации моделей потеряна. Повторите npm run models:prepare.');
}

/** Загрузка не блокируется. В разных Docker PID namespaces живость определяется по heartbeat. */
async function exclusive(directory,action) {
    const previous=queues.get(directory)||Promise.resolve();let done;
    const pending=new Promise(resolve=>{done=resolve;});queues.set(directory,pending);
    await previous.catch(()=>{});
    const lock=path.join(directory,managed,'activation.lock'),token=randomUUID();let acquired=false,heartbeat,candidate;
    try {
        await safeDirectory(directory,managed,true);
        // В общий путь попадает только каталог с уже записанным и fsync-проверенным владельцем.
        candidate=await mkdtemp(path.join(directory,managed,'.activation-'));
        await writeJson(directory,`${path.basename(candidate)}/owner.json`,{pid:process.pid,namespace,token});
        const deadline=Date.now()+30000;
        while(!acquired) {
            try {
                const now=new Date();await utimes(path.join(candidate,'owner.json'),now,now);
                await rename(candidate,lock);acquired=true;await syncFolder(path.join(directory,managed));
            }catch(error) {
                if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;
                await safeDirectory(directory,`${managed}/activation.lock`);
                const owner=await maybeJson(directory,'activation.lock/owner.json');let stale=false;
                if(!owner) {
                    const before=await lstat(lock),current=await lstat(lock);
                    if(Date.now()-before.mtimeMs>leaseTimeout&&before.ino===current.ino&&before.dev===current.dev&&before.mtimeMs===current.mtimeMs
                        &&!await maybeJson(directory,'activation.lock/owner.json')) {
                        // Сохраняем остатки прежнего неатомарного захвата, ничего из них не исполняется.
                        await rename(lock,path.join(directory,managed,`.abandoned-lock-${randomUUID()}`));continue;
                    }
                }
                if(owner&&Number.isSafeInteger(owner.pid)&&owner.pid>0&&typeof owner.token==='string') {
                    if(owner.namespace===namespace) {
                        if(owner.pid===process.pid)stale=true;
                        else try{process.kill(owner.pid,0);}catch(failure){if(failure.code==='ESRCH')stale=true;else if(failure.code!=='EPERM')throw failure;}
                    }else stale=Date.now()-(await lstat(path.join(lock,'owner.json'))).mtimeMs>leaseTimeout;
                    if(stale&&(await maybeJson(directory,'activation.lock/owner.json'))?.token===owner.token) {await rm(lock,{recursive:true});continue;}
                }
                if(Date.now()>deadline)throw new Error('Активация моделей уже выполняется. Дождитесь завершения и повторите npm run models:prepare.');
                await new Promise(resolve=>setTimeout(resolve,50));
            }
        }
        leases.set(directory,token);
        heartbeat=setInterval(()=>{assertLease(directory).then(()=>{const now=new Date();return utimes(path.join(lock,'owner.json'),now,now);}).catch(()=>{});},500);
        heartbeat.unref();
        return await action();
    }finally {
        clearInterval(heartbeat);
        try {
            if(acquired&&(await maybeJson(directory,'activation.lock/owner.json'))?.token===token)await rm(lock,{recursive:true,force:true});
            if(candidate)await rm(candidate,{recursive:true,force:true});
        }
        finally{leases.delete(directory);done();if(queues.get(directory)===pending)queues.delete(directory);}
    }
}

async function assertBlobs(directory,tags) {
    for(const tag of tags) {
        let value;try{value=JSON.parse(Buffer.from(tag.inlineBase64,'base64').toString('utf8'));}catch{throw invalid();}
        if(!plain(value.config)||!Array.isArray(value.layers))throw invalid();
        for(const blob of [value.config,...value.layers]) {
            if(!plain(blob)||!/^sha256:[a-f0-9]{64}$/.test(blob.digest)||!Number.isSafeInteger(blob.size)||blob.size<1)throw invalid();
            await safeDirectory(directory,'models/blobs');
            if(!await verifyFile(path.join(directory,'models/blobs',blob.digest.replace(':','-')),{size:blob.size,sha256:blob.digest.slice(7)}))throw Object.assign(new Error('Для активации или возврата отсутствуют проверенные файлы модели.'),{code:'MODEL_BLOBS_MISSING'});
        }
    }
}

async function recover(directory) {
    const journal=await maybeJson(directory,'pending.json');if(!journal)return false;
    if(!plain(journal)||journal.schemaVersion!==1||!Array.isArray(journal.changes)||!journal.changes.length)throw invalid();
    validatePointer(journal.next);if(journal.previous!==null)validatePointer(journal.previous);
    const paths=new Set();
    for(const change of journal.changes) {
        if(change.after!==null)validateTag(change.after);if(change.before!==null)validateTag(change.before);
        const filename=change.after?.path||change.before?.path;
        if(!filename||paths.has(filename)||change.before&&change.after&&change.before.path!==change.after.path)throw invalid();paths.add(filename);
    }
    const current=await maybeJson(directory,'active.json');if(current)validatePointer(current);
    const committed=current?.revision===journal.next.revision;
    if(current?.revision!==journal.previous?.revision&&!committed)throw invalid();
    // Сначала проверяются все пути: неизвестный тег не перезаписывается даже при аварийном возврате.
    for(const change of journal.changes) {
        const filename=change.after?.path||change.before.path;
        if(await matches(directory,change.after,filename)||await matches(directory,change.before,filename))continue;
        throw conflict();
    }
    if(committed) {
        const tags=await readRevision(directory,journal.next.revision);await assertBlobs(directory,tags);
        for(const tag of tags)if(!await matches(directory,tag))throw invalid();
    } else {
        if(journal.previous)await assertBlobs(directory,await readRevision(directory,journal.previous.revision));
        for(const change of journal.changes) {
            if(change.before)await atomicBytes(directory,change.before.path,Buffer.from(change.before.inlineBase64,'base64'));
            else {await assertLease(directory);await rm(path.join(directory,change.after.path),{force:true});}
        }
    }
    await assertLease(directory);await unlink(path.join(directory,managed,'pending.json'));await syncFolder(path.join(directory,managed));
    return true;
}

/** Неполное переключение восстанавливается до следующей проверки готовности; предзагрузка теги не меняет. */
export async function recoverManagedModelBundle(directory,{verifyOnly=false,downloadOnly=false}={}) {
    if(!await maybeJson(directory,'pending.json'))return {ok:true,recovered:false};
    if(verifyOnly||downloadOnly)throw Object.assign(new Error('Предыдущее переключение моделей не завершено. Выполните npm run models:prepare -- --recover-only для восстановления согласованного комплекта.'),{code:'MODEL_RECOVERY_REQUIRED'});
    return exclusive(directory,async()=>({ok:true,recovered:await recover(directory)}));
}

async function activate(directory,tags,{onBytes=()=>{},retainExistingTags=false}={}) {
    await recover(directory);
    const state=await managedModelState(directory),changes=[];
    // Импорт immutable aliases дополняет набор под той же lease, сохраняя активные исторические pins.
    if(retainExistingTags) {
        for(const previous of state.tags) {
            const replacement=tags.find(tag=>tag.path===previous.path);
            if(replacement&&replacement.sha256!==previous.sha256)throw conflict();
        }
        tags=[...tags,...state.tags.filter(previous=>!tags.some(tag=>tag.path===previous.path))];
    }
    const next=revision(tags);
    // Проверка каждого blob предшествует любому изменению активных тегов.
    await assertBlobs(directory,tags);
    for(const tag of tags) {
        const present=await managedTagPresent(directory,tag,state);
        if(!present)changes.push({before:state.tags.find(file=>file.path===tag.path)||null,after:tag});
    }
    for(const previous of state.tags)if(!tags.some(tag=>tag.path===previous.path)) {
        if(!await matches(directory,previous))throw conflict();
        changes.push({before:previous,after:null});
    }
    const saved=await maybeJson(directory,`revisions/${next.id}.json`);
    if(saved) {if(JSON.stringify(saved)!==JSON.stringify(next.value))throw invalid();}
    else await writeJson(directory,`revisions/${next.id}.json`,next.value);
    const pointer={schemaVersion:1,revision:next.id,...(state.pointer?.revision!==next.id&&state.pointer?{previous:state.pointer.revision}:state.pointer?.previous?{previous:state.pointer.previous}:{})};
    if(!changes.length){await writeJson(directory,'active.json',pointer);return;}
    await writeJson(directory,'pending.json',{schemaVersion:1,previous:state.pointer||null,next:pointer,changes});
    try {
        for(const {before,after} of changes) {
            const filename=after?.path||before.path;
            if(!await matches(directory,before,filename))throw conflict();
            if(after) {await atomicBytes(directory,after.path,Buffer.from(after.inlineBase64,'base64'));await onBytes(after.size);}
            else {await assertLease(directory);await unlink(path.join(directory,filename));await syncFolder(path.dirname(path.join(directory,filename)));}
        }
        await writeJson(directory,'active.json',pointer);
        await assertLease(directory);await unlink(path.join(directory,managed,'pending.json'));await syncFolder(path.join(directory,managed));
    }catch(error){await recover(directory);throw error;}
}

export const activateManagedModelBundle=(directory,tags,options)=>exclusive(directory,()=>activate(directory,tags,options));

/** Обновляет только квитанцию полностью совпавшей поставки; теги и веса не записываются. */
export async function adoptManagedModelBundle(directory,tags,{sourceCommit}={}) {
    if(sourceCommit!==undefined&&!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit))throw invalid();
    return exclusive(directory,async()=>{
        if(await maybeJson(directory,'pending.json'))throw Object.assign(new Error('Перед регистрацией комплекта выполните npm run models:prepare -- --recover-only для завершения переключения.'),{code:'MODEL_RECOVERY_REQUIRED'});
        for(const tag of tags)if(!await matches(directory,tag))return false;
        const state=await managedModelState(directory),next=revision(tags);
        if(state.pointer)return state.pointer.revision===next.id;
        try{await assertBlobs(directory,tags);}catch(error){if(error.code==='MODEL_BLOBS_MISSING')return false;throw error;}
        const saved=await maybeJson(directory,`revisions/${next.id}.json`);
        if(saved) {if(JSON.stringify(saved)!==JSON.stringify(next.value))throw invalid();}
        else await writeJson(directory,`revisions/${next.id}.json`,next.value);
        if(sourceCommit)await writeJson(directory,`adoptions/${next.id}.json`,{schemaVersion:1,revision:next.id,sourceCommit});
        await writeJson(directory,'active.json',{schemaVersion:1,revision:next.id});return true;
    });
}

/** Возврат использует сохранённую опись и оставленные immutable blobs, сеть не требуется. */
export async function rollbackManagedModelBundle(directory) {
    directory=await safeDirectory(directory);
    return exclusive(directory,async()=>{
        await recover(directory);const state=await managedModelState(directory);
        if(!state.pointer?.previous)throw new Error('Предыдущая управляемая поставка моделей отсутствует.');
        const tags=await readRevision(directory,state.pointer.previous);
        // Нынешний комплект тоже должен оставаться известным: пользовательские изменения не затираются.
        for(const tag of state.tags)if(!await matches(directory,tag))throw conflict();
        await activate(directory,tags);
        return {ok:true,rolledBack:true,models:tags.length,revision:state.pointer.previous};
    });
}
