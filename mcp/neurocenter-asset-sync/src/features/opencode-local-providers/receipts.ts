import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {stateDir} from '../../bridge/state.js';
import {atomicText,syncDirectory} from '../../bridge/atomic-file.js';
import {readBoundedSnapshot} from '../../bridge/read-bounded.js';
import {roleMcpProcessOwner,roleMcpOwnerAlive} from '../system-role-mcp/owned-process.js';
import type {RoleMcpOwner} from '../system-role-mcp/session-journal.js';
import type {Completion} from '../../bridge/completions.js';
import {contract} from './contract.js';
export interface GlobalJob {id:string;lease:string;kind:string;project_id?:string|null;payload:unknown}
export interface GlobalReceipt {schemaVersion:1;job:GlobalJob&{deviceId:string};owner:RoleMcpOwner;phase:'started'|'closed';completion?:Completion;outboxed?:true}
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const failure=()=>Error('Журнал локальной настройки не подтверждён. Восстановите подключение без повторного открытия окна.');
async function directory(){
    const parent=stateDir();await fs.mkdir(parent,{recursive:true,mode:0o700});const root=path.join(parent,'opencode-global-provider-jobs');
    try{await fs.mkdir(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    for(const file of [parent,root]){const info=await fs.lstat(file);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw failure();}await syncDirectory(parent);return root;
}
async function archiveDirectory(){const parent=await directory(),root=path.join(parent,'completed');try{await fs.mkdir(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const info=await fs.lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw failure();await syncDirectory(parent);return root;}
function validate(value:GlobalReceipt){
    if(!value||Object.keys(value).some(key=>!['schemaVersion','job','owner','phase','completion','outboxed'].includes(key))||value.outboxed!==undefined&&value.outboxed!==true||value.schemaVersion!==1||!['started','closed'].includes(value.phase)||!value.job||!uuid(value.job.id)||!uuid(value.job.lease)||!uuid(value.job.deviceId)||value.job.project_id!=null
        ||!value.owner||!Number.isSafeInteger(value.owner.pid)||!Number.isSafeInteger(value.owner.uid)||typeof value.owner.birth!=='string'||typeof value.owner.entry!=='string')throw failure();
    if(![contract.OPENCODE_GLOBAL_PROVIDERS_READ_JOB,contract.OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB].includes(value.job.kind as typeof contract.OPENCODE_GLOBAL_PROVIDERS_READ_JOB))throw failure();
    if(contract.normalizeGlobalProvidersPayload(value.job.payload,value.job.kind).deviceId!==value.job.deviceId)throw failure();
    if(value.phase==='closed'){
        const completion=value.completion;if(!completion||completion.id!==value.job.id||completion.lease!==value.job.lease||completion.deviceId!==value.job.deviceId||!['succeeded','failed'].includes(completion.state))throw failure();
        const result=contract.normalizeGlobalProvidersResult(completion.result,{deviceId:value.job.deviceId,jobId:value.job.id,kind:value.job.kind,expiresAt:contract.normalizeGlobalProvidersPayload(value.job.payload,value.job.kind).expiresAt});
        if((result.status!=='failed')!==(completion.state==='succeeded'))throw failure();
    }else if(value.completion||value.outboxed)throw failure();return value;
}
async function readFile(file:string,id:string):Promise<GlobalReceipt|undefined>{
    try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw failure();
        const value=validate(JSON.parse((await readBoundedSnapshot(file,600*1024)).bytes.toString('utf8')));if(value.job.id!==id)throw failure();return value;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
export async function readGlobalReceipt(id:string):Promise<GlobalReceipt|undefined>{
    if(!uuid(id))throw failure();return await readFile(path.join(await directory(),id+'.json'),id)??await readFile(path.join(await archiveDirectory(),id+'.json'),id);
}
export async function beginGlobalReceipt(job:GlobalReceipt['job']){
    if(await readGlobalReceipt(job.id))throw failure();const value=validate({schemaVersion:1,job,owner:await roleMcpProcessOwner(),phase:'started'});await atomicText(path.join(await directory(),job.id+'.json'),JSON.stringify(value),0o600);return value;
}
export async function completeGlobalReceipt(previous:GlobalReceipt,completion:Completion){
    if(previous.phase!=='started'||!isDeepStrictEqual(await readGlobalReceipt(previous.job.id),previous))throw failure();const value=validate({...previous,phase:'closed',completion});await atomicText(path.join(await directory(),value.job.id+'.json'),JSON.stringify(value),0o600);return value;
}
/** Delivery is repeated; browser opening and config changes never are. Closed receipts remain immutable. */
export async function queueGlobalReceipt(value:GlobalReceipt,save:(completion:Completion)=>Promise<void>){
    if(value.phase!=='closed'||!value.completion||!isDeepStrictEqual(await readGlobalReceipt(value.job.id),value))throw failure();
    const root=await directory(),archive=await archiveDirectory(),source=path.join(root,value.job.id+'.json'),destination=path.join(archive,value.job.id+'.json');
    if(!value.outboxed){await save({...value.completion,message:'Локальное действие OpenCode завершено; сохранение провайдеров и ответ модели проверяются отдельно.'});
        if(!isDeepStrictEqual(await readGlobalReceipt(value.job.id),value))throw failure();value={...value,outboxed:true};await atomicText(source,JSON.stringify(value),0o600);}
    const archived=await readFile(destination,value.job.id);if(archived){if(!isDeepStrictEqual(archived,value))throw failure();try{await fs.unlink(source);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    else await fs.rename(source,destination);await syncDirectory(archive);await syncDirectory(root);
}
export async function* globalReceipts(){const root=await directory();let count=0;for await(const entry of await fs.opendir(root)){const name=entry.name;if(name==='completed')continue;if(++count>10000||!/^[a-f0-9-]{36}\.json$/.test(name))throw failure();yield(await readFile(path.join(root,name),name.slice(0,-5)))!;}}
export async function globalReceiptRecoverable(value:GlobalReceipt){const current=await roleMcpProcessOwner();return isDeepStrictEqual(current,value.owner)||!await roleMcpOwnerAlive(value.owner);}
