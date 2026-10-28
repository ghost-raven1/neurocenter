import fs from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

const maximumBytes=2*1024*1024,timeoutMs=30000;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
type Options={cwd:string;env:NodeJS.ProcessEnv;temporary:string;signal?:AbortSignal};
type Failure=Error&{code?:string|number;stdout?:string;stderr?:string};
const failure=(code:string,message:string):Failure=>Object.assign(new Error(message),{code});

/** Read only a bounded complete file, independently of the stdout FD offset inherited by the child. */
async function captured(file:FileHandle):Promise<{text:string;bytes:number;limited:boolean}>{
    await file.sync();const {size}=await file.stat(),buffer=Buffer.alloc(Math.min(size,maximumBytes));let position=0;
    while(position<buffer.length){const {bytesRead}=await file.read(buffer,position,buffer.length-position,position);if(!bytesRead)break;position+=bytesRead;}
    return {text:buffer.subarray(0,position).toString('utf8'),bytes:size,limited:size>maximumBytes||position!==buffer.length};
}

/** Test-only native capture: regular FDs avoid pinned CLI exit truncating a large JSON pipe write. */
export async function captureNativeCliJson(binary:string,args:string[],options:Options):Promise<{stdout:string;stderr:string}>{
    options.signal?.throwIfAborted();
    const directory=await fs.mkdtemp(path.join(options.temporary,'native-cli-json-'));
    let stdout:FileHandle|undefined,stderr:FileHandle|undefined,child:ReturnType<typeof spawn>|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined,escalation:ReturnType<typeof setTimeout>|undefined,watchdog:ReturnType<typeof setInterval>|undefined;
    let reason:Failure|undefined,checking=false,closed=false,spawnError:Failure|undefined,removeCapture=true;
    let rejectOwnership:((error:Failure)=>void)|undefined;
    const ownershipUnknown=()=>{
        reason=failure('NATIVE_CLI_OWNERSHIP_UNKNOWN',`Native CLI cleanup is unconfirmed (owned PID ${child?.pid}); capture retained at ${directory}.`);
        removeCapture=false;child?.unref();rejectOwnership?.(Object.assign(reason,{captureDirectory:directory,pid:child?.pid}));
    };
    const group=():string=>{
        if(!child?.pid)return 'not-spawned';
        if(process.platform==='win32')return closed?'empty':'alive';
        try{process.kill(-child.pid,0);return 'alive';}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'?'empty':'unknown';}
    };
    const signal=(value:NodeJS.Signals)=>{
        if(!child?.pid)return;const state=group();if(state==='unknown'){ownershipUnknown();return;}if(state!=='alive')return;
        try{if(process.platform==='win32')child.kill(value);else process.kill(-child.pid,value);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')ownershipUnknown();}
    };
    const stop=(error:Failure)=>{
        reason??=error;signal('SIGTERM');if(!removeCapture)return;
        // A closed leader can leave owned descendants alive; keep escalation until the group is empty.
        escalation??=setTimeout(()=>signal('SIGKILL'),1000);
    };
    const abort=()=>stop(failure('ABORT_ERR','Native CLI capture was cancelled.'));
    try{
        stdout=await fs.open(path.join(directory,'stdout.raw'),'wx+',0o600);
        stderr=await fs.open(path.join(directory,'stderr.raw'),'wx+',0o600);
        options.signal?.throwIfAborted();
        child=spawn(binary,args,{cwd:options.cwd,env:options.env,detached:process.platform!=='win32',stdio:['ignore',stdout.fd,stderr.fd]});
        const completion=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
            child!.once('error',error=>{spawnError=error;});
            child!.once('close',(code,signal)=>{closed=true;resolve({code,signal});});
        });
        const finished=Promise.race([completion,new Promise<never>((_resolve,reject)=>{rejectOwnership=reject;})]);
        options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
        deadline=setTimeout(()=>stop(failure('ETIMEDOUT','Native CLI capture exceeded 30 seconds.')),timeoutMs);
        // This is a monitored FD budget, not execFile maxBuffer or an OS hard file-size limit.
        watchdog=setInterval(async()=>{
            if(checking||closed)return;checking=true;
            try{if((await stdout!.stat()).size>maximumBytes||(await stderr!.stat()).size>maximumBytes)stop(failure('NATIVE_CLI_OUTPUT_LIMIT','Native CLI output exceeded 2 MiB.'));}
            catch{stop(failure('NATIVE_CLI_CAPTURE_FAILED','Native CLI output could not be inspected.'));}
            finally{checking=false;}
        },25);
        const result=await finished;
        clearTimeout(deadline);clearInterval(watchdog);while(checking)await pause(5);
        let state=group();if(state==='alive')stop(failure('NATIVE_CLI_CHILDREN_REMAIN','Native CLI left an owned process running.'));
        const drainUntil=Date.now()+2000;
        while(state==='alive'&&Date.now()<drainUntil){await pause(25);state=group();}
        if(state!=='empty'&&state!=='not-spawned'){
            ownershipUnknown();throw reason!;
        }
        clearTimeout(escalation);
        const output=await captured(stdout),errors=await captured(stderr),details={stdout:output.text,stderr:errors.text,exitCode:result.code,signal:result.signal};
        if(output.limited||errors.limited)reason=failure('NATIVE_CLI_OUTPUT_LIMIT','Native CLI output exceeded 2 MiB or was incomplete.');
        if(reason||spawnError||result.code!==0||result.signal)throw Object.assign(reason??spawnError??new Error('Native CLI did not exit successfully.'),
            {code:reason?.code??spawnError?.code??result.code,...details});
        return {stdout:output.text,stderr:errors.text};
    }finally{
        clearTimeout(deadline);clearInterval(watchdog);clearTimeout(escalation);options.signal?.removeEventListener('abort',abort);
        await stdout?.close();await stderr?.close();
        if(removeCapture)await fs.rm(directory,{recursive:true,force:true});
    }
}
