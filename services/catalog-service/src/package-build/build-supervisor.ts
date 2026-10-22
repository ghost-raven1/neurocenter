import {spawn,type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {stopWindowsBuildTree} from './windows-build-process';
import {writeBuildProof} from './build-cleanup';

/** Trusted passive reaper: START is sent only after the worker durably fences its nonce. */
async function main():Promise<void>{
    const [script,nonce,...args]=process.argv.slice(2);
    if(!script||!nonce||!/^[a-f0-9-]{36}$/i.test(nonce)||!process.send)throw Error('Invalid owned supervisor context');
    let child:ChildProcess|undefined,started=false,cancelled=false,settling=false,windowsKilled=false,unconfirmed=false;
    const kill=()=>{if(!child?.pid)return;try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else if(!windowsKilled){stopWindowsBuildTree(child.pid);windowsKilled=true;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
    const finish=(code:number)=>{
        process.exitCode=code;process.removeAllListeners('message');process.removeAllListeners('disconnect');process.removeAllListeners('SIGTERM');process.removeAllListeners('SIGINT');if(process.connected)process.disconnect();
    };
    const settle=async(code:number)=>{
        if(settling)return;settling=true;
        // Preserve ordinary Windows builds; only a successful tree kill plus leader close acknowledges cancellation.
        if(process.platform==='win32'&&child?.pid&&(!cancelled||unconfirmed)){finish(cancelled?1:code);return;}
        // Descendants share the exact builder group. The supervisor remains outside it to record reaping.
        kill();
        if(child?.pid&&process.platform!=='win32'){
            const until=Date.now()+5000;
            while(true){try{process.kill(-child.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')break;throw error;}
                if(Date.now()>=until)throw Error('Builder process group is not reaped');await new Promise(resolve=>setTimeout(resolve,25));}
        }
        if(process.connected)process.send?.({type:'reaped',nonce});
        await writeBuildProof(path.join(path.dirname(process.cwd()),'.process-reaped',path.basename(process.cwd())+'.'+nonce+'.json'),nonce,{builderPid:child?.pid??null});
        finish(cancelled?1:code);
    };
    const cancel=()=>{cancelled=true;if(child){try{kill();}catch{unconfirmed=true;child.kill('SIGKILL');}}else void settle(1).catch(()=>process.exit(1));};
    process.on('disconnect',cancel);process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
    process.on('message',message=>{
        if(!message||typeof message!=='object')return;
        const type=(message as {type?:unknown}).type;
        if(type==='cancel'){cancel();return;}
        if(type!=='start'||started||cancelled)return;started=true;
        child=spawn(process.execPath,['--require',path.join(__dirname,'build-guardian.js'),script,...args],{cwd:process.cwd(),env:process.env,detached:process.platform!=='win32',stdio:['ignore','inherit','inherit','ipc']});
        child.once('error',()=>{void settle(1).catch(()=>process.exit(1));});
        child.once('close',code=>{void settle(code??1).catch(()=>process.exit(1));});
    });
    process.send({type:'ready'});
}
void main().catch(()=>{process.exitCode=1;if(process.connected)process.disconnect();});
