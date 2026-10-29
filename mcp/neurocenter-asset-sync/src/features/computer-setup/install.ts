import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {syncDirectory} from '../../bridge/atomic-file.js';
import {findUserOpenCode,type UserCliExecutable} from './executable.js';
import {withGlobalConfigLock} from '../../lib/global-config-lock.js';
import {normalizeOpenCodeInstallResult,type OpenCodeInstallPayload,type OpenCodeInstallResult,type OpenCodeInstallFailure} from './install-contract.js';

export class CliInstallError extends Error {constructor(readonly code:OpenCodeInstallFailure){super('Установка OpenCode не подтверждена: '+code);}}
interface InstallContext {
    payload:OpenCodeInstallPayload;jobId:string;home:string;directories:readonly string[];pathDirectories:readonly string[];bridgeRoots:readonly string[];sourceFile:string;signal:AbortSignal;
    authorize:()=>Promise<void>;assertSource:()=>Promise<void>;probe:(file:string,current:()=>Promise<void>)=>Promise<string>;
    beforePublish:()=>Promise<void>;published:()=>Promise<void>;
    stageOwned?:(stage:{file:string;dev:number;ino:number;parentDev:number;parentIno:number})=>Promise<void>;
}
const stamp=(stat:Awaited<ReturnType<typeof fs.stat>>)=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const version=(value:string)=>value.length<=128&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value);

/** Fixed destination, no overwrite and no profile/auth/config writes. The caller owns its durable publish marker. */
export async function installBundledOpenCode(context:InstallContext):Promise<OpenCodeInstallResult>{
    const {payload,signal}=context;
    const current=async()=>{signal.throwIfAborted();await context.authorize();signal.throwIfAborted();await context.assertSource();signal.throwIfAborted();};
    const result=(status:'installed'|'unchanged',installedVersion:string,commandVersion:string|null)=>normalizeOpenCodeInstallResult({...payload,jobId:context.jobId,checkedAt:new Date().toISOString(),status,installedVersion,
        commandVersion,commandReady:commandVersion===installedVersion,nextAction:commandVersion===installedVersion?'none':'inspect-path'});
    const observeCommand=async()=>{
        const found=await findUserOpenCode(context.pathDirectories,context.bridgeRoots,signal,true);if(!found)return null;
        const actual=await context.probe(found.file,async()=>{await current();if((await findUserOpenCode(context.pathDirectories,context.bridgeRoots,signal,true))?.identity!==found.identity)throw new CliInstallError('destination-changed');});
        if(!version(actual))return null;return actual;
    };
    const unchanged=async(existing:UserCliExecutable)=>{
        let actual:string;try{actual=await context.probe(existing.file,async()=>{await current();const found=await findUserOpenCode(context.directories,context.bridgeRoots,signal);if(found?.file!==existing.file||found.identity!==existing.identity)throw new CliInstallError('destination-changed');});}
        catch(error){if(signal.aborted||error instanceof CliInstallError)throw error;throw new CliInstallError('existing-cli-unavailable');}
        if(!version(actual))throw new CliInstallError('existing-cli-unavailable');return result('unchanged',actual,await observeCommand());
    };
    await current();const existing=await findUserOpenCode(context.directories,context.bridgeRoots,signal);if(existing)return unchanged(existing);
    const home=path.resolve(context.home);if(home!==await fs.realpath(home))throw new CliInstallError('destination-unsafe');
    const parents=[home,path.join(home,'.local'),path.join(home,'.local','bin')],identities:Array<{dev:number;ino:number}>=[];
    for(const [index,directory]of parents.entries()){
        if(index)try{await fs.mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
        const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0)throw new CliInstallError('destination-unsafe');
        identities.push({dev:stat.dev,ino:stat.ino});
    }
    const directoriesCurrent=async()=>{for(const[index,directory]of parents.entries()){const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==identities[index]!.dev||stat.ino!==identities[index]!.ino||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0)throw new CliInstallError('destination-changed');}};
    const directory=parents[2]!,destination=path.join(directory,'opencode'),temporary=path.join(directory,'.opencode.install.'+randomUUID()+'.tmp');
    const absent=async()=>{try{await fs.lstat(destination);}catch(error){if(missing(error))return;throw error;}throw new CliInstallError('destination-changed');};
    return withGlobalConfigLock(destination,async()=>{
    let source:Awaited<ReturnType<typeof fs.open>>|undefined,stage:Awaited<ReturnType<typeof fs.open>>|undefined,stageIdentity:{dev:number;ino:number}|undefined;
    try{
        await directoriesCurrent();await absent();
        source=await fs.open(context.sourceFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const original=await source.stat();
        if(!original.isFile()||original.nlink!==1||original.size<=0||original.size>512*1024*1024)throw new CliInstallError('source-unavailable');
        stage=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o700);const created=await stage.stat();stageIdentity={dev:created.dev,ino:created.ino};
        await context.stageOwned?.({file:temporary,...stageIdentity,parentDev:identities[2]!.dev,parentIno:identities[2]!.ino});
        const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let offset=0;
        for(;;){signal.throwIfAborted();const {bytesRead}=await source.read(buffer,0,buffer.length,offset);if(!bytesRead)break;offset+=bytesRead;if(offset>original.size)throw new CliInstallError('source-changed');
            hash.update(buffer.subarray(0,bytesRead));let written=0;while(written<bytesRead){const next=await stage.write(buffer,written,bytesRead-written,offset-bytesRead+written);if(!next.bytesWritten)throw new CliInstallError('install-failed');written+=next.bytesWritten;}
            if(offset%(8*1024*1024)===0)await current();
        }
        if(offset!==original.size||stamp(await source.stat())!==stamp(original)||hash.digest('hex')!==payload.source.sha256)throw new CliInstallError('source-changed');
        await stage.sync();await stage.close();stage=undefined;await source.close();source=undefined;
        const stagedInfo=await fs.lstat(temporary);
        const stagedCurrent=async()=>{await current();await directoriesCurrent();const stat=await fs.lstat(temporary);if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==stageIdentity!.dev||stat.ino!==stageIdentity!.ino||stat.size!==original.size||stamp(stat)!==stamp(stagedInfo))throw new CliInstallError('source-changed');};
        if(await context.probe(temporary,stagedCurrent)!==payload.source.version)throw new CliInstallError('verification-failed');
        await stagedCurrent();const raced=await findUserOpenCode(context.directories,context.bridgeRoots,signal);if(raced)return unchanged(raced);
        await absent();await context.beforePublish();await stagedCurrent();await absent();
        // link is an atomic absent-only publication; a competing manual install is never replaced.
        try{await fs.link(temporary,destination);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new CliInstallError('destination-changed');throw error;}
        await syncDirectory(directory);await context.published();
        const installedCurrent=async()=>{await current();await directoriesCurrent();const stat=await fs.lstat(destination);if(!stat.isFile()||stat.isSymbolicLink()||stat.dev!==stageIdentity!.dev||stat.ino!==stageIdentity!.ino||stat.size!==stagedInfo.size||stat.mtimeMs!==stagedInfo.mtimeMs)throw new CliInstallError('destination-changed');};
        if(await context.probe(destination,installedCurrent)!==payload.source.version)throw new CliInstallError('verification-failed');
        await installedCurrent();return result('installed',payload.source.version,await observeCommand());
    }finally{
        await stage?.close();await source?.close();
        const stat=await fs.lstat(temporary).catch(error=>{if(missing(error))return undefined;throw error;});
        if(stat&&stageIdentity&&stat.isFile()&&!stat.isSymbolicLink()&&stat.dev===stageIdentity.dev&&stat.ino===stageIdentity.ino){await fs.unlink(temporary);await syncDirectory(directory);}
    }
    });
}
