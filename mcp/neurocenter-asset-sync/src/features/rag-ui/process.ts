import {spawn,type ChildProcess} from 'node:child_process';
import {ragUiReady} from './contract.js';

interface StopOptions {force?:boolean;timeoutMs?:number}
export interface UiProcess {child:ChildProcess;url:string;stop(options?:StopOptions):Promise<void>}
/** Долгоживущий HTTP-процесс принадлежит worker; URL читается только из IPC и не печатается. */
export async function startRagUiProcess(entrypoint:string,args:string[],cwd:string,env:NodeJS.ProcessEnv):Promise<UiProcess>{
    const child=spawn(process.execPath,[entrypoint,...args],{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
    let ended=false;child.once('close',()=>{ended=true;});
    let outputBytes=0;const drain=(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>1024*1024)void stop();};
    child.stdout?.on('data',drain);child.stderr?.on('data',drain);child.on('error',()=>{});
    let stopping:Promise<void>|undefined;
    const close=async(force:boolean,timeoutMs:number)=>{
        if(ended)return;
        if(child.connected)child.disconnect();
        if(ended)return;
        await new Promise<void>(resolve=>{const timer=setTimeout(resolve,timeoutMs);timer.unref();child.once('close',()=>{clearTimeout(timer);resolve();});});
        if(!ended&&!force)throw new Error('Интерфейс завершает текущую работу с индексом. Дождитесь её окончания и повторите восстановление.');
        if(!ended&&child.pid){try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{/* Уже завершён только наш процесс. */}}
    };
    const stop=(options:StopOptions={}):Promise<void>=>{
        if(stopping)return options.force===false?stopping:stopping.catch(()=>{stopping=undefined;return stop(options);});
        const task=close(options.force!==false,options.timeoutMs??1200);stopping=task;
        void task.catch(()=>{if(stopping===task)stopping=undefined;});return task;
    };
    try{
        const ready=await new Promise<{url:string;port:number}>((resolve,reject)=>{
            const timer=setTimeout(()=>{cleanup();reject(new Error('Интерфейс OpenCodeRAG не запустился за отведённое время.'));},20000);
            const fail=()=>{cleanup();reject(new Error('Локальный интерфейс OpenCodeRAG завершился до готовности.'));};
            const message=(value:unknown)=>{try{const result=ragUiReady(value);cleanup();resolve(result);}catch{cleanup();reject(new Error('Локальный интерфейс не подтвердил безопасную готовность.'));}};
            const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('error',fail);child.off('exit',fail);};
            child.on('message',message);child.once('error',fail);child.once('exit',fail);
        });
        return {child,url:ready.url,stop};
    }catch(error){await stop();throw error;}
    finally{
        // Потоки дренируются, но приватный вывод и URL не попадают в журнал площадки.
        child.stdout?.resume();child.stderr?.resume();
    }
}
