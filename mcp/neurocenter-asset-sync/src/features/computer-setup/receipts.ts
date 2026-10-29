import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {stateDir} from '../../bridge/state.js';
import {atomicText,syncDirectory} from '../../bridge/atomic-file.js';
import {readBoundedSnapshot} from '../../bridge/read-bounded.js';
import type {Completion} from '../../bridge/completions.js';
import {closeRoleMcpProcess,findRoleMcpProcess,roleMcpOwnerAlive,roleMcpProcessOwner,type RoleMcpProcessJournal} from '../system-role-mcp/owned-process.js';
import type {RoleMcpOwner} from '../system-role-mcp/session-journal.js';
import {normalizeOpenCodeCliResult} from './contract.js';

export interface CliJobIdentity {id:string;lease:string;deviceId:string}
export interface CliReceipt {
    schemaVersion:1;job:CliJobIdentity;worker:RoleMcpOwner;phase:'started'|'closed';
    process?:{nonce:string;receipt:string;owner?:RoleMcpOwner};completion?:Completion;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const names={active:'computer-setup-jobs',completed:'computer-setup-completed',processes:'computer-setup-processes'};
let writes:Promise<void>=Promise.resolve();
const exact=(value:object,keys:string[])=>Object.keys(value).sort().join(',')===keys.sort().join(',');
export const cliFailureMessage='Проверка OpenCode не завершена. Проверьте компьютер и повторите действие.';
export class CliCleanupError extends Error {constructor(cause:unknown){super('Завершение проверки OpenCode не подтверждено.',{cause});}}

async function directory(kind:keyof typeof names):Promise<string>{
    const parent=stateDir();await fs.mkdir(parent,{recursive:true,mode:0o700});
    const root=await fs.lstat(parent);
    if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid?.()||(root.mode&0o077)!==0)throw new Error('Небезопасный профиль проверки OpenCode.');
    const file=path.join(parent,names[kind]);
    try{await fs.mkdir(file,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const info=await fs.lstat(file);
    if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('Небезопасный журнал проверки OpenCode.');
    // Retry a prior mkdir whose parent fsync failed before trusting this journal directory.
    await syncDirectory(parent);return file;
}
function owner(value:RoleMcpOwner):boolean{
    return !!value&&exact(value,['pid','uid','birth','entry'])&&Number.isSafeInteger(value.pid)&&value.pid>1&&Number.isSafeInteger(value.uid)
        &&typeof value.birth==='string'&&!!value.birth&&value.birth.length<=256&&typeof value.entry==='string'&&path.isAbsolute(value.entry)&&value.entry.length<=4096;
}
function validate(item:CliReceipt):CliReceipt{
    if(!item||!exact(item,['schemaVersion','job','worker','phase',...(item.process?['process']:[]),...(item.completion?['completion']:[])])
        ||item.schemaVersion!==1||!item.job||!exact(item.job,['id','lease','deviceId'])||![item.job.id,item.job.lease,item.job.deviceId].every(value=>uuid.test(value))
        ||!owner(item.worker)||!['started','closed'].includes(item.phase))throw new Error('Повреждён журнал проверки OpenCode.');
    if(item.process){
        const process=item.process;
        if(!exact(process,['nonce','receipt',...(process.owner?['owner']:[])])||!uuid.test(process.nonce)
            ||process.receipt!==path.join(stateDir(),names.processes,process.nonce+'.json')||process.owner&&!owner(process.owner))throw new Error('Владелец проверки OpenCode изменился.');
    }
    if(item.phase==='started'&&item.completion||item.phase==='closed'&&!item.completion)throw new Error('Повреждён переход проверки OpenCode.');
    if(item.completion){
        const value=item.completion;
        if(!exact(value,['id','lease','deviceId','state','message','result'])||value.id!==item.job.id||value.lease!==item.job.lease||value.deviceId!==item.job.deviceId
            ||!['succeeded','failed'].includes(value.state)||typeof value.message!=='string'||Buffer.byteLength(value.message)>1500||value.message.includes('\0')
            ||!value.result||typeof value.result!=='object'||Array.isArray(value.result))throw new Error('Повреждён результат проверки OpenCode.');
        if(Object.keys(value.result).length){
            const result=normalizeOpenCodeCliResult(value.result,{deviceId:item.job.deviceId,jobId:item.job.id});
            if((result.status==='installed'||result.status==='missing')!==(value.state==='succeeded'))throw new Error('Результат проверки OpenCode не соответствует состоянию.');
        }else if(value.state!=='failed')throw new Error('Проверка OpenCode не содержит наблюдения.');
    }
    return item;
}
async function read(kind:'active'|'completed',id:string):Promise<CliReceipt|undefined>{
    if(!uuid.test(id))throw new Error('Некорректное задание проверки OpenCode.');
    const file=path.join(await directory(kind),id+'.json');
    try{
        const info=await fs.lstat(file);
        if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('Небезопасная запись проверки OpenCode.');
        const item=validate(JSON.parse((await readBoundedSnapshot(file,16384)).bytes.toString('utf8')) as CliReceipt);
        if(item.job.id!==id)throw new Error('Журнал проверки OpenCode относится к другому заданию.');return item;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
export async function readCliReceipt(id:string):Promise<CliReceipt|undefined>{return await read('active',id)??await read('completed',id);}
/** Cancellation cannot cancel an fsync already in flight; drain it before accepting physical cleanup. */
export async function settleCliReceipt(item:CliReceipt):Promise<CliReceipt>{
    await writes;const current=await read('active',item.job.id);
    if(!current||!same(current.job,item.job)||!same(current.worker,item.worker))throw new Error('Владелец проверки OpenCode изменился.');
    return current;
}
async function change(previous:CliReceipt,next:CliReceipt):Promise<CliReceipt>{
    const prior=writes;let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});writes=prior.then(()=>gate);
    await prior;
    try{
        validate(next);
        if(!same(previous.job,next.job)||!same(previous.worker,next.worker)||!same(await read('active',previous.job.id),previous))throw new Error('Журнал проверки OpenCode изменился.');
        await atomicText(path.join(await directory('active'),previous.job.id+'.json'),JSON.stringify(next),0o600);return next;
    }finally{release();}
}
export async function beginCliReceipt(job:CliJobIdentity):Promise<CliReceipt>{
    if(await readCliReceipt(job.id))throw new Error('Проверка OpenCode уже принята.');
    const item=validate({schemaVersion:1,job,worker:await roleMcpProcessOwner(),phase:'started'});
    await atomicText(path.join(await directory('active'),job.id+'.json'),JSON.stringify(item),0o600);return item;
}
/** Nonce and exact wrapper identity are fsynced before the wrapper can receive its execution permit. */
export async function cliProcessJournal(item:CliReceipt,save:(next:CliReceipt)=>void):Promise<RoleMcpProcessJournal>{
    if(item.phase!=='started'||item.process)throw new Error('Проверка OpenCode уже получила владельца.');
    const nonce=randomUUID(),record={nonce,receipt:path.join(await directory('processes'),nonce+'.json')};
    let current=await change(item,{...item,process:record});save(current);
    return {...record,retain:async process=>{current=await change(current,{...current,process:{...record,owner:process}});save(current);}};
}
/** A missing wrapper without a retained owner had no permit; a retained owner requires its exact closure receipt. */
export async function closeCliReceipt(item:CliReceipt):Promise<void>{
    if(item.phase==='closed'||!item.process)return;
    try{
        const process=item.process,owner=process.owner??await findRoleMcpProcess(process.nonce,process.receipt);
        if(owner)await closeRoleMcpProcess(owner,process.nonce,process.receipt);
    }catch(cause){throw new CliCleanupError(cause);}
}
export async function completeCliReceipt(item:CliReceipt,completion:Completion):Promise<CliReceipt>{
    if(item.phase!=='started')throw new Error('Результат проверки OpenCode уже зафиксирован.');
    return change(item,{...item,phase:'closed',completion});
}
/** Outbox takes delivery ownership first; the immutable closed archive prevents execution replay after its ACK. */
export async function queueCliCompletion(item:CliReceipt,save:(value:Completion)=>Promise<void>):Promise<void>{
    if(item.phase!=='closed'||!item.completion)throw new Error('Очистка проверки OpenCode не подтверждена.');
    await save(item.completion);
    const previous=await read('active',item.job.id),archived=await read('completed',item.job.id);
    if(!same(previous,item)||archived&&!same(archived,item))throw new Error('Результат проверки OpenCode изменился перед архивированием.');
    const source=path.join(await directory('active'),item.job.id+'.json'),destination=path.join(await directory('completed'),item.job.id+'.json');
    // Keep the owned closure receipt: this local outbox handoff is not a server acknowledgement.
    if(archived)await fs.unlink(source);else await fs.rename(source,destination);
    await syncDirectory(path.dirname(destination));await syncDirectory(path.dirname(source));
}
/** Recover only orphaned intents. A live worker keeps its own lane, and uncertain closure blocks every new claim. */
export async function recoverComputerSetupCompletions(save:(value:Completion)=>Promise<void>,expected:readonly CliReceipt[]=[]):Promise<void>{
    await writes;
    let count=0;
    for await(const file of await fs.opendir(await directory('active'))){
        if(!file.name.endsWith('.json'))continue;
        if(++count>64||!uuid.test(file.name.slice(0,-5)))throw new Error('Сначала восстановите сохранённые проверки OpenCode.');
        let item=await read('active',file.name.slice(0,-5));if(!item)continue;
        if(item.worker.pid!==process.pid&&await roleMcpOwnerAlive(item.worker))throw new CliCleanupError(new Error('Проверка OpenCode принадлежит работающему мосту.'));
        if(item.phase==='started'){
            await closeCliReceipt(item);
            item=await completeCliReceipt(item,{...item.job,state:'failed',message:cliFailureMessage,result:{}});
        }
        await queueCliCompletion(item,save);
    }
    // A rename may have removed the active name before either directory fsync failed.
    // Retry metadata durability even with an empty active directory before releasing any lane.
    await syncDirectory(await directory('completed'));await syncDirectory(await directory('active'));
    for(const item of expected){
        validate(item);
        if(item.phase!=='closed'||!same(await read('completed',item.job.id),item))throw new CliCleanupError(new Error('Архив результата проверки OpenCode не подтверждён.'));
    }
}
