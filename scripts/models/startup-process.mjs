import {spawn} from 'node:child_process';

const failure=(code,message)=>Object.assign(new Error(message),{code});

/** Подготовка моделей остаётся отзывчивой; завершение затрагивает только собственную группу процессов. */
export function runModelStartupProcess(command,args,{cwd,env,encoding,stdio=['ignore','pipe','pipe'],
    maxBuffer=2*1024*1024,timeout=0,onTick=()=>{},heartbeatInterval=10000,killGraceMs=1000}={}) {
    return new Promise(resolve=>{
        const started=Date.now(),output={stdout:[],stderr:[]};let size=0,error,cancelSignal;
        let child,deadline,heartbeat,killTimer;
        const signalGroup=signal=>{
            if(!child?.pid)return;
            try {
                if(process.platform==='win32')child.kill(signal);
                else process.kill(-child.pid,signal);
            } catch(failure) {if(failure.code!=='ESRCH')error??=failure;}
        };
        const stop=(reason,signal)=>{
            if(error)return;
            error=reason;cancelSignal=signal;
            signalGroup('SIGTERM');
            killTimer=setTimeout(()=>signalGroup('SIGKILL'),killGraceMs);
        };
        const cancel=signal=>stop(failure('ECANCELED','Запуск хостинга моделей отменён.'),signal);
        const interrupt=()=>cancel('SIGINT'),terminate=()=>cancel('SIGTERM');
        const finish=(status,signal)=>{
            // Лидер мог завершиться раньше дочернего процесса, который закрыл/унаследовал stdio.
            if(error)signalGroup('SIGKILL');
            for(const timer of [deadline,heartbeat,killTimer])clearTimeout(timer);
            process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);
            const captured=stream=>child?.[stream]===null?null:
                encoding?Buffer.concat(output[stream]).toString(encoding):Buffer.concat(output[stream]);
            resolve({status:child?.pid?status:null,signal:cancelSignal||signal,stdout:captured('stdout'),stderr:captured('stderr'),...(error?{error}:{})});
        };
        try {child=spawn(command,args,{cwd,env,stdio,shell:false,detached:process.platform!=='win32'});}
        catch(failure) {error=failure;finish(null,null);return;}
        for(const stream of ['stdout','stderr'])child[stream]?.on('data',bytes=>{
            const available=Math.max(0,maxBuffer-size);
            if(available)output[stream].push(bytes.subarray(0,available));
            size+=bytes.length;
            if(size>maxBuffer)stop(failure('ENOBUFS','Вывод подготовки моделей превысил допустимый размер.'));
        });
        child.once('error',failure=>{error??=failure;});
        child.once('close',finish);
        process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
        if(timeout>0)deadline=setTimeout(()=>stop(failure('ETIMEDOUT','Истекло время запуска хостинга моделей.')),timeout);
        if(heartbeatInterval>0)heartbeat=setInterval(()=>{
            try {onTick(Date.now()-started);} catch(failure) {stop(failure);}
        },heartbeatInterval);
    });
}
