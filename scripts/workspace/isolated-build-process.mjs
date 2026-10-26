import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {BuildError,digest} from './isolated-build-source.mjs';

/** Only numeric state for the newly created group; commands and foreign processes are never selected for termination. */
function groupMembers(pgid){
    let output;
    // A busy host or a wrapper signal may interrupt one probe; persistent failures remain fatal.
    for(let attempt=0;;attempt++)try{
        output=execFileSync('/bin/ps',['-ax','-o','pid=,pgid=,stat='],{encoding:'utf8',timeout:1000,maxBuffer:1024**2,
            env:{PATH:'/usr/bin:/bin',LANG:'C'}});break;
    }catch(error){if(attempt>=2||!(['ETIMEDOUT','EAGAIN'].includes(error.code)||['SIGINT','SIGTERM'].includes(error.signal)))throw error;}
    return output.split('\n').map(line=>/^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)).filter(match=>match&&Number(match[2])===pgid)
        .map(match=>({pid:Number(match[1]),zombie:match[3].startsWith('Z')}));
}
function signalGroup(pgid,signal){try{process.kill(-pgid,signal);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}

/** Supervise npm and its compiler descendants in one owned POSIX group, even after the leader exits. */
export async function runBuildProcess({node,args,cwd,env,logFile,signal,timeoutMs=180000,graceMs=1000,logLimit=32*1024**2,onSpawn,ownerFile,inspectLog=handle=>handle.stat()}){
    if(process.platform==='win32')throw new BuildError('UNSUPPORTED_PLATFORM','Owned process-group cleanup is currently supported on POSIX only.');
    const log=await fs.open(logFile,'wx',0o600),started=Date.now();
    let child,pid,exit,spawnError,inspectionError,primary=null,closed=false,leaderExited=false,groupInspectionFailed=false;
    const signals=[];let termAt=null,killAt=null;
    const fail=code=>{primary??={code};};
    const terminate=()=>{if(!pid||termAt!==null)return;termAt=Date.now();try{if(signalGroup(pid,'SIGTERM'))signals.push('SIGTERM');}catch{fail('PROCESS_CLEANUP_FAILED');}};
    const abort=()=>{fail('CANCELLED');terminate();};
    try{
        if(signal?.aborted)return {ok:false,failure:{code:'CANCELLED'},exitCode:null,signal:null,durationMs:0,leaderReaped:false,cleanup:{noLiveDescendants:true,signals:[]}};
        child=spawn(node,ownerFile?[ownerFile]:args,{cwd,env,stdio:ownerFile?['ignore',log.fd,log.fd,'ipc']:['ignore',log.fd,log.fd],detached:true,windowsHide:true});pid=child.pid;
        child.once('spawn',()=>{try{onSpawn?.(child.pid);if(ownerFile)child.send({kind:'run',args,environment:env});}
            catch{fail('BUILD_PROCESS_FAILED');terminate();}});
        child.once('error',error=>{spawnError=error.code||'UNKNOWN';fail('SPAWN_FAILED');});
        child.once('exit',(code,endedBy)=>{leaderExited=true;exit={code,signal:endedBy};if(code!==0||endedBy)fail('BUILD_FAILED');});
        child.once('close',()=>{closed=true;});
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        let finalMembers=[];
        while(true){
            if(!primary&&Date.now()-started>=timeoutMs){fail('BUILD_TIMEOUT');terminate();}
            // An I/O or caller observation failure still drains our group through the same cleanup loop.
            if(!primary)try{if((await inspectLog(log)).size>logLimit){fail('BUILD_LOG_LIMIT');terminate();}}
            catch{fail('BUILD_PROCESS_FAILED');terminate();}
            if(spawnError&&!pid)break;
            let members;
            try{members=pid?groupMembers(pid):[];}catch(error){inspectionError=error.code;groupInspectionFailed=true;fail('PROCESS_INSPECTION_FAILED');terminate();members=null;}
            if(leaderExited&&members?.some(item=>!item.zombie)&&termAt===null){fail('SURVIVING_DESCENDANTS');terminate();}
            if(primary&&termAt===null)terminate();
            if(termAt!==null&&killAt===null&&Date.now()-termAt>=graceMs){
                killAt=Date.now();try{if(pid&&signalGroup(pid,'SIGKILL'))signals.push('SIGKILL');}catch{fail('PROCESS_CLEANUP_FAILED');}
            }
            if(closed&&members&&!members.some(item=>!item.zombie)){finalMembers=members;break;}
            if(killAt!==null&&Date.now()-killAt>=2000){fail('PROCESS_CLEANUP_FAILED');finalMembers=members||[];break;}
            await delay(25);
        }
        const noLiveDescendants=!groupInspectionFailed&&!finalMembers.some(item=>!item.zombie);
        return {ok:!primary&&closed&&leaderExited&&exit?.code===0&&noLiveDescendants,pid,exitCode:exit?.code??null,signal:exit?.signal??null,
            durationMs:Date.now()-started,leaderReaped:leaderExited,cleanup:{noLiveDescendants,zombiePids:finalMembers.filter(item=>item.zombie).map(item=>item.pid),signals,
                note:'Node reaps its direct npm child. Orphan descendant reaping belongs to the OS; zombie state is reported separately.'},
            ...(primary?{failure:{...primary,...(spawnError||inspectionError?{errno:spawnError||inspectionError}:{})}}:{}),log:{path:logFile}};
    }finally{
        signal?.removeEventListener('abort',abort);await log.close();
    }
}

/** Hash bounded private compiler output without returning its potentially sensitive contents. */
export async function buildLogIdentity(file){
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
        const info=await handle.stat(),limit=Math.min(info.size,64*1024**2),bytes=Buffer.alloc(limit);let offset=0;
        if(!info.isFile()||info.nlink!==1)throw new BuildError('UNSAFE_LOG','The compiler log is not a regular owned file.');
        while(offset<limit){const result=await handle.read(bytes,offset,limit-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead;}
        const after=await handle.stat(),selected=await fs.lstat(file);
        if(info.dev!==after.dev||info.ino!==after.ino||after.dev!==selected.dev||after.ino!==selected.ino||selected.isSymbolicLink()||after.nlink!==1
            ||info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ctimeMs!==after.ctimeMs||offset!==limit)throw new BuildError('LOG_CHANGED','The compiler log changed during hashing.');
        return {bytes:info.size,hashedBytes:offset,complete:offset===info.size,sha256Scope:offset===info.size?'complete-file':'first-64MiB',sha256:digest(bytes.subarray(0,offset))};
    }finally{await handle.close();}
}
