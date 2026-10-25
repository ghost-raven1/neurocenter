import fs from 'node:fs/promises';
import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {BuildRow} from './package-build.model';

const ackPath=(root:string,row:BuildRow)=>path.join(root,'.cleanup-acks',row.id+'.'+row.execution_nonce+'.json');
const reapPath=(root:string,row:BuildRow)=>path.join(root,'.process-reaped',row.id+'.'+row.execution_nonce+'.json');
export const hasBuildReapProof=(stage:string,nonce:string)=>proof(reapPath(path.dirname(stage),{id:path.basename(stage),execution_nonce:nonce} as BuildRow),nonce);
async function proof(filename:string,nonce:string):Promise<boolean>{
    try{
        const directory=await fs.lstat(path.dirname(filename));if(!directory.isDirectory()||directory.isSymbolicLink())return false;
        const info=await fs.lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4096)return false;
        const record=JSON.parse(await fs.readFile(filename,'utf8')) as {nonce?:string;reaped?:boolean};return record.nonce===nonce&&record.reaped===true;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}
}
/** A crash cannot expose a partially written positive acknowledgment at its authoritative filename. */
export async function writeBuildProof(filename:string,nonce:string,extra:Record<string,unknown>={}):Promise<void>{
    const directory=path.dirname(filename);await fs.mkdir(directory,{recursive:true,mode:0o700});
    const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe cleanup acknowledgment directory');
    if(await proof(filename,nonce))return;
    const temporary=filename+'.'+randomUUID()+'.tmp',file=await fs.open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify({...extra,nonce,reaped:true})+'\n');await file.sync();}finally{await file.close();}
    try{await fs.link(temporary,filename);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!await proof(filename,nonce))throw error;}
    finally{await fs.rm(temporary,{force:true});}
}
/** Negative lifecycle evidence never authorizes cleanup and contains no argv, environment or builder output. */
export async function writeBuildReapFailure(stage:string,nonce:string,detail:{builderPid:number|null;phase:string;code:string;groupProbeCode?:string}):Promise<void>{
    const directory=path.join(path.dirname(stage),'.process-reap-failures');await fs.mkdir(directory,{recursive:true,mode:0o700});
    const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe reap failure directory');
    const filename=path.join(directory,path.basename(stage)+'.'+nonce+'.json'),file=await fs.open(filename,'wx',0o600);
    try{await file.writeFile(JSON.stringify({nonce,reaped:false,...detail,checkedAt:new Date().toISOString()})+'\n');await file.sync();}finally{await file.close();}
}
/** A cleanup acknowledgment is written only by the old worker after child close AND stage removal. */
export async function acknowledgeBuildCleanup(root:string,row:BuildRow):Promise<void>{
    if(!row.execution_nonce)return;
    await writeBuildProof(ackPath(root,row),row.execution_nonce);
}
export async function forgetBuildCleanup(root:string,row:BuildRow):Promise<void>{if(row.execution_nonce){await fs.rm(ackPath(root,row),{force:true});await fs.rm(reapPath(root,row),{force:true});await fs.rm(path.join(root,'.process-reap-failures',row.id+'.'+row.execution_nonce+'.json'),{force:true});}}

/** SQL ownership alone never proves that an old worker has stopped writing its private stage. */
export async function mayRecoverBuildStage(root:string,row:BuildRow):Promise<boolean>{
    const nonce=row.execution_nonce;
    if(!nonce)return row.state!=='CANCELLING';
    if(await proof(ackPath(root,row),nonce))return true;
    if(row.execution_host!==hostname()||!Number.isSafeInteger(row.execution_pid)||(row.execution_pid??0)<=0)return false;
    try{process.kill(row.execution_pid!,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return false;}
    return !row.execution_started||await proof(reapPath(root,row),nonce);
}
