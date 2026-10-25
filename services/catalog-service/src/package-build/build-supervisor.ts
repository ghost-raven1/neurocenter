import {spawn,type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {stopWindowsBuildTree} from './windows-build-process';
import {writeBuildProof,writeBuildReapFailure} from './build-cleanup';

/** Trusted passive reaper: START is sent only after the worker durably fences its nonce. */
async function main():Promise<void>{
    const [script,nonce,...args]=process.argv.slice(2);
    if(!script||!nonce||!/^[a-f0-9-]{36}$/i.test(nonce)||!process.send)throw Error('Invalid owned supervisor context');
    let child:ChildProcess|undefined,started=false,cancelled=false,settling=false,windowsKilled=false,unconfirmed=false;
    let phase:'waiting'|'terminate'|'reap'|'proof'|'notification'='waiting',signalErrorCode:string|undefined,groupProbeCode:string|undefined;
    // IPC is a wakeup only; a closed owner channel cannot invalidate the durable cleanup receipt.
    const notify=(message:{type:'ready'|'reaped';nonce?:string})=>{
        if(!process.connected)return;
        try{process.send?.(message,()=>undefined);}catch{/* The caller can recover from the durable receipt. */}
    };
    const failed=async(error:unknown)=>{
        const raw=(error as NodeJS.ErrnoException|null)?.code,code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(raw)?raw:'SUPERVISOR_FAILURE';
        await writeBuildReapFailure(process.cwd(),nonce,{builderPid:child?.pid??null,phase,code,...(groupProbeCode?{groupProbeCode}:{})}).catch(()=>undefined);
        process.exit(1);
    };
    const kill=()=>{if(!child?.pid)return;try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else if(!windowsKilled){stopWindowsBuildTree(child.pid);windowsKilled=true;}}catch(error){
        if((error as NodeJS.ErrnoException).code==='ESRCH')return;
        signalErrorCode=(error as NodeJS.ErrnoException).code;
        // A group may disappear between child close and this repeated signal; only ESRCH confirms that race.
        try{process.kill(-child.pid,0);groupProbeCode='PRESENT';}catch(probe){groupProbeCode=(probe as NodeJS.ErrnoException).code;if(groupProbeCode==='ESRCH')return;}
        throw error;
    }};
    const finish=(code:number)=>{
        process.exitCode=code;process.removeAllListeners('message');process.removeAllListeners('disconnect');process.removeAllListeners('SIGTERM');process.removeAllListeners('SIGINT');if(process.connected)process.disconnect();
    };
    const settle=async(code:number)=>{
        if(settling)return;settling=true;
        // Preserve ordinary Windows builds; only a successful tree kill plus leader close acknowledges cancellation.
        if(process.platform==='win32'&&child?.pid&&(!cancelled||unconfirmed)){finish(cancelled?1:code);return;}
        // Descendants share the exact builder group. The supervisor remains outside it to record reaping.
        phase='terminate';kill();
        if(child?.pid&&process.platform!=='win32'){
            phase='reap';const until=Date.now()+5000;
            while(true){try{process.kill(-child.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')break;throw error;}
                if(Date.now()>=until)throw Object.assign(Error('Builder process group is not reaped'),{code:'BUILD_GROUP_NOT_REAPED'});await new Promise(resolve=>setTimeout(resolve,25));}
        }
        phase='proof';await writeBuildProof(path.join(path.dirname(process.cwd()),'.process-reaped',path.basename(process.cwd())+'.'+nonce+'.json'),nonce,{builderPid:child?.pid??null,...(signalErrorCode?{signalErrorCode,groupProbeCode}:{})});
        phase='notification';notify({type:'reaped',nonce});
        finish(cancelled?1:code);
    };
    const cancel=()=>{cancelled=true;if(child){try{kill();}catch{unconfirmed=true;child.kill('SIGKILL');}}else void settle(1).catch(failed);};
    process.on('disconnect',cancel);process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
    process.on('message',message=>{
        if(!message||typeof message!=='object')return;
        const type=(message as {type?:unknown}).type;
        if(type==='cancel'){cancel();return;}
        if(type!=='start'||started||cancelled)return;started=true;
        child=spawn(process.execPath,['--require',path.join(__dirname,'build-guardian.js'),script,...args],{cwd:process.cwd(),env:process.env,detached:process.platform!=='win32',stdio:['ignore','inherit','inherit','ipc']});
        child.once('error',()=>{void settle(1).catch(failed);});
        child.once('close',code=>{void settle(code??1).catch(failed);});
    });
    notify({type:'ready'});
}
void main().catch(()=>{process.exitCode=1;if(process.connected)process.disconnect();});
