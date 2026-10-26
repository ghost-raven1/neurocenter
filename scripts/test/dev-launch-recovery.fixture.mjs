import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {recoverDevLaunch} from '../workspace/dev-launch-recovery.mjs';

async function waitFile(filename) {
    const deadline=Date.now()+3000;
    while(!await fs.stat(filename).then(()=>true,()=>false)&&Date.now()<deadline)await delay(10);
    return fs.readFile(filename,'utf8');
}

/** Own actual JS is deliberately blocked after launch proof; its writer ignores TERM. */
export async function blockedLaunch(f,environment={}) {
    const writer=path.join(path.dirname(f.entry),'recovery-writer.cjs'),ready=path.join(f.root,'writer-ready'),block=path.join(f.root,'block'),blocked=path.join(f.root,'blocked');
    const state=path.join(f.root,'recovery-pids.json');
    await fs.writeFile(writer,`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.RECOVERY_READY,'ready');setInterval(()=>{},1000);`);
    await fs.writeFile(f.entry,`const fs=require('node:fs'),{spawn}=require('node:child_process');const writer=spawn(process.execPath,[process.env.RECOVERY_WRITER],{stdio:'inherit'});fs.writeFileSync(process.env.RECOVERY_STATE,JSON.stringify({pid:process.pid,writer:writer.pid}));console.log('ready');const wait=setInterval(()=>{if(!fs.existsSync(process.env.RECOVERY_BLOCK))return;clearInterval(wait);fs.writeFileSync(process.env.RECOVERY_BLOCKED,'blocked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);},5);`);
    const launched=await f.launch({environment:{...environment,RECOVERY_WRITER:writer,RECOVERY_READY:ready,RECOVERY_BLOCK:block,RECOVERY_BLOCKED:blocked,RECOVERY_STATE:state}});
    await waitFile(ready);await fs.writeFile(block,'block');await waitFile(blocked);
    const pids=JSON.parse(await fs.readFile(state,'utf8'));
    return {launched,pids,
        async killOwner(){const exited=once(launched.child,'exit');launched.child.kill('SIGKILL');await exited;
            const index=f.records?.indexOf(launched.record);if(index>=0)f.records.splice(index,1);},
        cleanup:()=>recoverDevLaunch(f.root,launched.record,f.service)};
}
