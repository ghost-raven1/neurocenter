import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,stateDir,readState,type Credentials} from '../../bridge/state.js';
import {syncDirectory} from '../../bridge/atomic-file.js';
import {fileFingerprint,readBoundedSnapshot,type BoundedSnapshot} from '../../bridge/read-bounded.js';
import {projectBindingId,projectFolder,projectInstanceId} from '../../bridge/workspace.js';
import {normalizeLearningObservedExperienceInput,type LearningObservedExperienceInput} from './contract.js';
import {learningQueueLockFile,withLearningQueueLock} from './queue-lock.js';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const LEARNING_QUEUE_LIMIT={entries:200,bytes:1024*1024,entryBytes:16384};
export interface LearningQueueTarget {projectId:string;bindingId:string;instanceId:string}
interface Observation {schemaVersion:1;target:LearningQueueTarget;input:LearningObservedExperienceInput}
const queueError=()=>new Error('Приватная очередь наблюдений недоступна, повреждена или заполнена.');
export const learningQueueRoot=()=>path.join(stateDir(),'learning-observations');
const validTarget=(target:LearningQueueTarget)=>!!target&&typeof target.projectId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(target.projectId)
    &&typeof target.bindingId==='string'&&/^[a-f0-9]{64}$/.test(target.bindingId)&&typeof target.instanceId==='string'&&UUID.test(target.instanceId);

async function privateDirectory(directory:string,create:boolean):Promise<boolean>{
    if(create)await fs.mkdir(directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
    let stat;try{stat=await fs.lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&((stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw queueError();
    return true;
}
async function queueDirectory(root:string,target:LearningQueueTarget,create:boolean):Promise<string|undefined>{
    if(!path.isAbsolute(root)||!validTarget(target))throw queueError();
    if(!await privateDirectory(root,create))return;
    const directory=path.join(root,target.bindingId);
    return await privateDirectory(directory,create)?directory:undefined;
}

function parseObservation(raw:string,target:LearningQueueTarget):Observation{
    let value:unknown;try{value=JSON.parse(raw);}catch{throw queueError();}
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='input,schemaVersion,target')throw queueError();
    const record=value as Observation;
    if(record.schemaVersion!==1||!record.target||Object.keys(record.target).sort().join(',')!=='bindingId,instanceId,projectId'
        ||!validTarget(record.target)||record.target.projectId!==target.projectId||record.target.bindingId!==target.bindingId||record.target.instanceId!==target.instanceId)throw queueError();
    return {schemaVersion:1,target:record.target,input:normalizeLearningObservedExperienceInput(record.input)};
}

const staging=/^\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/;
async function syncSnapshot(file:string,snapshot:BoundedSnapshot):Promise<void>{
    const handle=await fs.open(file,constants.O_RDWR|(constants.O_NOFOLLOW??0));
    try{
        if(fileFingerprint(await handle.stat({bigint:true}))!==snapshot.fingerprint)throw queueError();
        await handle.sync();
        if(fileFingerprint(await handle.stat({bigint:true}))!==snapshot.fingerprint||fileFingerprint(await fs.lstat(file,{bigint:true}))!==snapshot.fingerprint)throw queueError();
    }finally{await handle.close();}
}
/** No publisher writes a staging file outside the queue lock; complete interrupted payloads keep their original UUID. */
async function recoverStaging(directory:string,target:LearningQueueTarget):Promise<void>{
    let changed=false;
    for(const name of await fs.readdir(directory)){
        if(!staging.test(name))continue;
        const file=path.join(directory,name),snapshot=await readBoundedSnapshot(file,LEARNING_QUEUE_LIMIT.entryBytes);
        let decoded:unknown;
        try{
            const raw=snapshot.bytes.toString('utf8');if(!Buffer.from(raw).equals(snapshot.bytes))throw queueError();
            decoded=JSON.parse(raw);
        }catch{
            // A partial unpublished write has no receipt or committed queue entry.
            await fs.unlink(file);changed=true;continue;
        }
        // Complete foreign/corrupt envelopes are preserved for inspection, never retargeted or silently discarded.
        const parsed=parseObservation(JSON.stringify(decoded),target);
        await syncSnapshot(file,snapshot);
        const destination=path.join(directory,parsed.input.requestKey+'.json');
        try{
            const existing=await readBoundedSnapshot(destination,LEARNING_QUEUE_LIMIT.entryBytes);
            if(!existing.bytes.equals(snapshot.bytes))throw queueError();
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await fs.link(file,destination);}
        await fs.unlink(file);changed=true;
    }
    if(changed)await syncDirectory(directory);
}

/** Atomic immutable UUID files retain exactly the same append payload after an offline or lost-ACK retry. */
export async function enqueueLearningObservation(target:LearningQueueTarget,value:unknown,root=learningQueueRoot()):Promise<void>{
    const input=normalizeLearningObservedExperienceInput(value),directory=await queueDirectory(root,target,true);
    if(!directory)throw queueError();
    const content=JSON.stringify({schemaVersion:1,target,input})+'\n';
    if(Buffer.byteLength(content)>LEARNING_QUEUE_LIMIT.entryBytes)throw queueError();
    await withLearningQueueLock(directory,async()=>{
        await recoverStaging(directory,target);
        const file=path.join(directory,input.requestKey+'.json');
        try{const existing=await readBoundedSnapshot(file,LEARNING_QUEUE_LIMIT.entryBytes);if(existing.bytes.toString('utf8')!==content)throw queueError();await syncSnapshot(file,existing);await syncDirectory(directory);return;}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        const files=(await fs.readdir(directory)).filter(name=>!learningQueueLockFile(name));
        let bytes=0;for(const name of files)bytes+=(await readBoundedSnapshot(path.join(directory,name),LEARNING_QUEUE_LIMIT.entryBytes)).bytes.length;
        if(files.length>=LEARNING_QUEUE_LIMIT.entries||bytes+Buffer.byteLength(content)>LEARNING_QUEUE_LIMIT.bytes)throw queueError();
        const temporary=path.join(directory,'.'+randomUUID()+'.tmp'),handle=await fs.open(temporary,'wx',0o600);
        try{await handle.writeFile(content);await handle.sync();await handle.close();await fs.link(temporary,file);await syncDirectory(directory);}
        finally{await handle.close().catch(()=>undefined);await fs.rm(temporary,{force:true});await syncDirectory(directory);}
    });
}

async function current(target:LearningQueueTarget):Promise<void>{
    await projectFolder(target.projectId);
    if(await projectBindingId(target.projectId)!==target.bindingId||await projectInstanceId(target.projectId)!==target.instanceId)throw queueError();
}

/** A receipt is checked before local removal; error/timeout leaves the immutable item available for replay. */
export async function flushLearningObservations(target:LearningQueueTarget,root=learningQueueRoot(),limit=4):Promise<number>{
    await current(target);const directory=await queueDirectory(root,target,false);if(!directory)return 0;
    const files=await withLearningQueueLock(directory,async()=>{await recoverStaging(directory,target);return (await fs.readdir(directory)).filter(name=>name.endsWith('.json')&&UUID.test(name.slice(0,-5))).sort().slice(0,limit);});
    let sent=0;
    for(const name of files){
        const file=path.join(directory,name),snapshot=await readBoundedSnapshot(file,LEARNING_QUEUE_LIMIT.entryBytes),raw=snapshot.bytes.toString('utf8');
        if(!Buffer.from(raw,'utf8').equals(snapshot.bytes))throw queueError();
        const record=parseObservation(raw,target);
        if(record.input.requestKey+'.json'!==name)throw queueError();
        await current(target);
        const credentials=await readState<Credentials>('credentials');if(!credentials)throw queueError();
        const result=await api<Record<string,unknown>>('learning/observe',{...target,input:record.input},credentials.token);
        const wrapper=result.result as Record<string,unknown>|undefined,experience=wrapper?.experience as Record<string,unknown>|undefined;
        const device=experience?.device as Record<string,unknown>|undefined;
        if(result.schemaVersion!==1||result.projectId!==target.projectId||result.requestKey!==record.input.requestKey||!Number.isSafeInteger(result.revision)||Number(result.revision)<1
            ||!experience||experience.projectId!==target.projectId||experience.origin!=='device'||!device||device.deviceId!==credentials.deviceId
            ||device.bindingId!==target.bindingId||device.instanceId!==target.instanceId)throw queueError();
        await current(target);
        await withLearningQueueLock(directory,async()=>{
            const after=await readBoundedSnapshot(file,LEARNING_QUEUE_LIMIT.entryBytes);
            if(after.fingerprint!==snapshot.fingerprint||!after.bytes.equals(snapshot.bytes))throw queueError();
            await fs.unlink(file);await syncDirectory(directory);
        });
        sent++;
    }
    return sent;
}
