import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {withLearningQueueLock,LEARNING_QUEUE_MUTEX} from '../src/features/project-learning/queue-lock.ts';
import {enqueueLearningObservation} from '../src/features/project-learning/observation-queue.ts';

const [mode,directory,rawTarget]=process.argv.slice(2),target=rawTarget?JSON.parse(rawTarget):undefined;
const input={requestKey:randomUUID(),title:'Parallel observation',summary:'Only counters',outcome:'unknown',evidence:[{kind:'observation',status:'unknown',summary:'{"read":1}'}]};
const send=value=>process.send?.(value);
const message=type=>new Promise(resolve=>{const listener=value=>{if(value?.type===type){process.off('message',listener);resolve();}};process.on('message',listener);});
const stage=async type=>{send({type,input});await new Promise(()=>{});};
const start=message('start');send({type:'ready',input});await start;
try{
    if(mode==='before-mutex'){
        const original=fs.open;
        fs.open=async(...args)=>{const handle=await original(...args);if(path.basename(String(args[0]))===LEARNING_QUEUE_MUTEX)await stage('before-mutex');return handle;};
        await withLearningQueueLock(directory,async()=>{});
    }else if(mode==='queue-before-sync'){
        const original=fs.open;
        fs.open=async(...args)=>{const handle=await original(...args);if(String(args[0]).endsWith('.tmp')){handle.sync=async()=>stage(mode);}return handle;};
        await enqueueLearningObservation(target,input,directory);
    }else if(mode==='queue-before'||mode==='queue-after'){
        const original=fs.link;
        fs.link=async(...args)=>{if(String(args[1]).endsWith('.json')){if(mode==='queue-before')await stage(mode);await original(...args);await stage(mode);}return original(...args);};
        await enqueueLearningObservation(target,input,directory);
    }else if(mode==='enqueue'){
        try{await enqueueLearningObservation(target,input,directory);send({type:'result',ok:true,input});}
        catch(error){send({type:'result',ok:false,message:String(error.message),input});}
    }else{
        const rounds=mode==='hold'?1:5;
        for(let round=0;round<rounds;round++)await withLearningQueueLock(directory,async()=>{
            const critical=path.join(directory,'critical'),handle=await fs.open(critical,'wx',0o600);
            try{
                await fs.appendFile(path.join(directory,'entries.jsonl'),JSON.stringify({pid:process.pid,round})+'\n');send({type:'entered',round});
                if(mode==='hold')await message('release');else await new Promise(resolve=>setTimeout(resolve,10));
            }finally{await handle.close();await fs.unlink(critical);}
        });
    }
    send({type:'done'});process.disconnect?.();
}catch(error){process.stderr.write(String(error.stack??error)+'\n');process.exitCode=1;process.disconnect?.();}
