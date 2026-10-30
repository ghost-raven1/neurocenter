import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {devProcessIdentity} from './dev-processes.mjs';
import {inspectLaunchBirth} from './dev-launch-inspection.mjs';
/** Groups are registered only by the trusted supervisor immediately after its own detached spawn. */
export function groupAlive(pid){
    const output=execFileSync('/bin/ps',['-ax','-o','pid=,pgid=,stat='],{encoding:'utf8',timeout:2000,maxBuffer:4*1024**2});
    return output.split('\n').some(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);return m&&Number(m[2])===pid&&!m[3].startsWith('Z');});
}
export async function stopWatchGroup(record,{graceMs=1500}={}){
    if(!Number.isSafeInteger(record.pid)||record.pid<=0||!record.identity)throw Error('WATCH_UNPROVEN_PROCESS');
    const current=devProcessIdentity(record.pid);if(current&&current!==record.identity){
        // ps rewrites a zombie's command; an ended, empty group needs no signal and is not PID reuse.
        if(inspectLaunchBirth(record.pid).state==='ended'&&!groupAlive(record.pid))return;
        throw Error('WATCH_PID_REUSED');
    }
    const signal=name=>{try{process.kill(-record.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}};
    signal('SIGTERM');const deadline=Date.now()+graceMs;while(groupAlive(record.pid)&&Date.now()<deadline)await delay(50);if(groupAlive(record.pid))signal('SIGKILL');
    const killed=Date.now()+2000;while(groupAlive(record.pid)&&Date.now()<killed)await delay(25);if(groupAlive(record.pid))throw Error('WATCH_PROCESS_CLEANUP_FAILED');
}
