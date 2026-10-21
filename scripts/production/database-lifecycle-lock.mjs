import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {composeEnvironment} from './configuration.mjs';

/** PostgreSQL session survives application shutdown; a lost session invalidates the backup receipt. */
export async function databaseLifecycleLock(container,{timeoutMs=30000,spawnProcess=spawn}={}){
    if(typeof container!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container))throw new Error('Некорректный PostgreSQL container');
    const applicationName='nc:backup-lifecycle:'+randomUUID();
    const child=spawnProcess('docker',['exec','-i',container,'psql','-X','-U','nc_owner','-d','rag','-v','ON_ERROR_STOP=1','-At'],{env:composeEnvironment(),stdio:['pipe','pipe','pipe']});
    let held=false,closing=false,closed=false,output='';let resolveReady,rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const done=new Promise(resolve=>child.once('close',()=>{closed=true;held=false;rejectReady(new Error('Блокировка жизненного цикла БД прервана'));resolve();}));
    child.once('error',()=>rejectReady(new Error('Не удалось открыть PostgreSQL lifecycle fence')));
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>1024){child.kill();return;}if(output.includes('NC_LIFECYCLE_LOCKED')){held=true;resolveReady();}});
    // Neither SQL errors nor user database names are forwarded into logs.
    child.stderr.on('data',()=>{});
    const timer=setTimeout(()=>{rejectReady(new Error('PostgreSQL занят изменением жизненного цикла базы'));child.kill();},Math.min(timeoutMs,30000));timer.unref();
    child.stdin.on('error',()=>rejectReady(new Error('PostgreSQL lifecycle fence недоступен')));
    child.stdin.write(`SET application_name='${applicationName}';\nDO $$ BEGIN IF NOT pg_try_advisory_lock(hashtextextended('neurocenter:database-lifecycle',0)) THEN RAISE EXCEPTION 'Lifecycle busy'; END IF; END $$;\nSELECT 'NC_LIFECYCLE_LOCKED';\n`);
    try{await ready;}catch(error){child.kill();await done;throw error;}finally{clearTimeout(timer);}
    return {applicationName,assertHeld(){if(!held||closed||closing)throw new Error('Блокировка жизненного цикла БД потеряна: копия не подтверждена');},
        async close(){if(closing)return done;closing=true;held=false;if(!closed)child.stdin.end("SELECT pg_advisory_unlock(hashtextextended('neurocenter:database-lifecycle',0));\n\\q\n");
            const timer=setTimeout(()=>child.kill(),5000);timer.unref();try{await done;}finally{clearTimeout(timer);}}};
}
