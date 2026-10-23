import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {devProcessIdentity,ownsDevProcess,discoverDevProcesses} from './dev-processes.mjs';
import {watchService} from './dev-watch-plan.mjs';
import {readWatchFile} from './dev-watch-files.mjs';
import {saveWatchProcesses} from './dev-watch-runtime.mjs';
/** The detached guardian receives service environments through private IPC, never files or command arguments. */
export async function startDevWatch({root,node,logDir,services,signal}){
    if(process.platform==='win32')throw Error('Watch требует POSIX process groups (macOS/Linux).');
    signal?.throwIfAborted();
    const previous=discoverDevProcesses(root,[watchService]);if(previous.length)throw Error('Watch этого checkout уже запущен. Сначала scripts/dev.sh down.');
    const log=await fs.open(path.join(logDir,'neurocenter-source-watch.log'),'a',0o600);let child;
    try{child=spawn(node,[path.join(root,watchService.entry)],{cwd:root,env:{PATH:process.env.PATH,NODE_BIN:node},stdio:['ignore',log.fd,log.fd,'ipc'],detached:true});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}finally{await log.close();}
    const watcherRecord={name:watchService.name,pid:child.pid,identity:devProcessIdentity(child.pid)};await saveWatchProcesses(root,[watcherRecord]);
    try{await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill('SIGTERM');reject(Error('Запуск watch отменён.'));};signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);reject(Error('Watch не запустился за 45 секунд.'));},45000);const failed=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Error('Watch завершился при запуске.'));};child.once('exit',failed);child.on('message',message=>{if(message?.kind==='ready'){clearTimeout(timer);signal?.removeEventListener('abort',abort);child.off('exit',failed);resolve();}else if(message?.kind==='failed')failed();});child.send({kind:'start',config:{root,node,logDir,services,watcherRecord}});});
        child.disconnect();child.unref();return {child,record:watcherRecord};
    }catch(error){child.kill('SIGTERM');throw error;}
}
export async function stopDevWatch(root,record){
    const records=record?[record]:discoverDevProcesses(root,[watchService]);
    for(const item of records){if(!ownsDevProcess(item,root,watchService))continue;process.kill(item.pid,'SIGTERM');const deadline=Date.now()+10000;while(ownsDevProcess(item,root,watchService)&&Date.now()<deadline)await delay(100);
        if(ownsDevProcess(item,root,watchService)){process.kill(item.pid,'SIGKILL');throw Error('Watch не подтвердил очистку процессов. Повторите down для проверки реестра.');}}
}
export async function devWatchStatus(root){const value=await readWatchFile(root,'status.json');if(!value)return null;return {...value,alive:ownsDevProcess({pid:value.pid,identity:value.identity},root,watchService)};}
