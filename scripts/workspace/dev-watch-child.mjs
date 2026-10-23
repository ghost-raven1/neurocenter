import {spawn,execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
let child,started=false,stopping=false;
const members=()=>new Promise((resolve,reject)=>{const probe=execFile('/bin/ps',['-ax','-o','pid=,pgid=,stat='],{encoding:'utf8',timeout:2000,maxBuffer:4*1024**2},(error,output)=>{if(error){reject(error);return;}resolve(output.split('\n').some(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);return m&&Number(m[2])===process.pid&&Number(m[1])!==process.pid&&Number(m[1])!==probe.pid&&!m[3].startsWith('Z');}));});});
/** A group leader stays alive until its command and descendants end, including abrupt owner IPC loss. */
async function finish(code){if(stopping)return;stopping=true;try{process.kill(-process.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')code=1;}
    const deadline=Date.now()+1200;while(await members().catch(()=>true)&&Date.now()<deadline)await delay(25);
    if(await members().catch(()=>true)){try{process.kill(-process.pid,'SIGKILL');}catch{}return;}
    process.exit(code);
}
process.once('disconnect',()=>void finish(143));process.on('SIGTERM',()=>void finish(143));process.once('SIGINT',()=>void finish(130));
process.on('message',message=>{if(started||message?.kind!=='run')return;started=true;
    if(!process.connected||!Array.isArray(message.args)||message.args.some(item=>typeof item!=='string')||!message.environment||typeof message.environment!=='object'){void finish(1);return;}
    child=spawn(process.execPath,message.args,{cwd:process.cwd(),env:message.environment,stdio:['ignore','inherit','inherit']});child.once('error',()=>void finish(1));child.once('exit',(code,signal)=>void finish(signal?1:code??1));
});
if(!process.connected)void finish(1);
