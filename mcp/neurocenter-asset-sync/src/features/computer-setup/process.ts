import {startRoleMcpProcess,RoleMcpCleanupError,type RoleMcpProcessJournal} from '../system-role-mcp/owned-process.js';
import {assertUserCliCurrent,findUserOpenCode} from './executable.js';
import {normalizeOpenCodeCliResult,type OpenCodeCliResult} from './contract.js';
import {CliCleanupError} from './receipts.js';
import {observedOpenCodeVersion} from './version.js';

export interface CliObservationContext {
    deviceId:string;jobId:string;home:string;environment:NodeJS.ProcessEnv;
    directories:readonly string[];bridgeRoots:readonly string[];
    pathOnly?:boolean;
    journal:()=>Promise<RoleMcpProcessJournal>;
}
export type CliAuthorization=(signal:AbortSignal)=>Promise<void>;
class CliAuthorizationError extends Error {constructor(){super('Доступ к проверке OpenCode не подтверждён.');}}

/** Cancellation bounds reads/authorization without letting a late result become an observation. */
async function beforeAbort<T>(start:()=>Promise<T>,signal:AbortSignal):Promise<T>{
    signal.throwIfAborted();let abort:()=>void=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    const value=Promise.resolve().then(()=>{signal.throwIfAborted();return start();});
    try{return await Promise.race([value,cancelled]);}finally{signal.removeEventListener('abort',abort);}
}

/** Executes only --version; output stays local, bounded, and cannot escape as an error message. */
export async function observeOpenCodeCli(context:CliObservationContext,authorize:CliAuthorization,signal:AbortSignal):Promise<OpenCodeCliResult>{
    const receipt=(status:OpenCodeCliResult['status'],version?:string)=>normalizeOpenCodeCliResult({schemaVersion:1,scope:'global',
        deviceId:context.deviceId,jobId:context.jobId,checkedAt:new Date().toISOString(),status,...(version?{version}:{})});
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(context.deviceId)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(context.jobId))throw new Error('Некорректное задание проверки OpenCode.');
    const authorized=async()=>{
        try{await beforeAbort(()=>authorize(signal),signal);signal.throwIfAborted();}
        catch(error){if(signal.aborted)throw signal.reason;throw new CliAuthorizationError();}
    };
    let closing:Promise<void>|undefined,stop:(()=>Promise<void>)|undefined,actualStarted=false;
    const close=()=>closing??=(stop?.()??Promise.resolve()).catch(error=>{throw new CliCleanupError(error);});
    let abort:()=>void=()=>{};
    try{
        await authorized();
        const executable=await beforeAbort(()=>findUserOpenCode(context.directories,context.bridgeRoots,signal,context.pathOnly),signal);
        if(!executable){
            await authorized();
            if(await beforeAbort(()=>findUserOpenCode(context.directories,context.bridgeRoots,signal,context.pathOnly),signal))throw new Error('OpenCode изменился во время проверки.');
            return receipt('missing');
        }
        const current=async()=>{await authorized();await beforeAbort(()=>assertUserCliCurrent(executable,context.directories,context.bridgeRoots,signal,context.pathOnly),signal);};
        const journal=await beforeAbort(context.journal,signal);
        const process=await startRoleMcpProcess(executable.file,['--version'],context.home,context.environment,current,signal,journal);
        stop=process.close;process.child.stdin.end();
        const started=process.started.then(value=>{actualStarted=value;return value;});
        const chunks:Buffer[]=[];let bytes=0,overflow=false;
        const receive=(chunk:Buffer,stdout:boolean)=>{
            bytes+=chunk.length;
            if(bytes>65536){overflow=true;void close().catch(()=>{});}
            else if(stdout)chunks.push(chunk);
        };
        process.child.stdout.on('data',chunk=>receive(Buffer.from(chunk),true));
        process.child.stderr.on('data',chunk=>receive(Buffer.from(chunk),false));
        const cancelled=new Promise<never>((_,reject)=>{
            abort=()=>{void close().then(()=>reject(signal.reason),reject);};
            signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        });
        if(!await Promise.race([started,cancelled]))throw new Error('OpenCode не запущен.');
        const result=await Promise.race([process.execution,cancelled]);
        await close();signal.throwIfAborted();
        if(overflow||result.code!==0||result.signal!==null)return receipt('failed');
        await current();
        const version=observedOpenCodeVersion(Buffer.concat(chunks).toString('utf8'));
        return version?receipt('installed',version):receipt('failed');
    }catch(error){
        if(error instanceof RoleMcpCleanupError)throw new CliCleanupError(error);
        if(error instanceof CliAuthorizationError||error instanceof CliCleanupError)throw error;
        await close();
        if(!actualStarted)throw new Error('Проверка OpenCode не получила наблюдение.');
        if(signal.aborted&&signal.reason?.name!=='TimeoutError')throw new Error('Проверка OpenCode остановлена.');
        return receipt(signal.aborted?'timed-out':'failed');
    }finally{
        signal.removeEventListener('abort',abort);await close();
    }
}
