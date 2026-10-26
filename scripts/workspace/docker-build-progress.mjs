import {spawn} from 'node:child_process';

/** Keep Docker output live and report elapsed wait without inventing download totals. */
export function runDockerBuild(args,options){
    return new Promise(resolve=>{
        const started=Date.now(),seconds=()=>Math.floor((Date.now()-started)/1000),limit=Math.ceil(options.timeout/1000);
        let child,error,timeoutError,cancelled,closed=false,cancelTimer;
        const label='Образ проверки снимков';
        console.log(`${label}: сборка начата; лимит ${limit} с. Ниже — вывод Docker и сетевые события npm.`);
        // Mark the deadline before spawn installs its own timeout; spawn owns the SIGKILL and child reaping.
        const deadline=setTimeout(()=>{timeoutError=Object.assign(new Error('Docker build timed out'),{code:'ETIMEDOUT'});},options.timeout);
        const heartbeat=setInterval(()=>console.log(`${label}: сборка выполняется ${seconds()} с; лимит ${limit} с.`),15000);
        const cancel=signal=>{
            cancelled??=signal;child?.kill(signal);
            cancelTimer??=setTimeout(()=>child?.kill('SIGKILL'),1000);
        };
        const interrupt=()=>cancel('SIGINT'),terminate=()=>cancel('SIGTERM');
        const finish=(status,signal)=>{
            if(closed)return;closed=true;
            clearTimeout(deadline);clearInterval(heartbeat);clearTimeout(cancelTimer);
            process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
            const result={status,signal:signal||cancelled||null,error:error??timeoutError};
            console.log(`${label}: ${status===0&&!result.signal&&!result.error?'готов':'сборка остановлена'} через ${seconds()} с.`);
            resolve(result);
        };
        process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
        try{
            const env={...options.env,...(options.env.BUILDKIT_PROGRESS===undefined?{BUILDKIT_PROGRESS:'plain'}:{})};
            child=spawn('docker',args,{...options,env});
            child.on('error',failure=>{error??=failure;});
            child.once('close',finish);
        }catch(failure){error=failure;finish(null,null);}
    });
}
