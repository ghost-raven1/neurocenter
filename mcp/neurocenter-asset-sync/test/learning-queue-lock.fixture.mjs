import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {withLearningQueueLock,LEARNING_QUEUE_MUTEX} from '../src/features/project-learning/queue-lock.ts';

const [mode,directory]=process.argv.slice(2);
const message=type=>new Promise(resolve=>{const listener=value=>{if(value?.type===type){process.off('message',listener);resolve();}};process.on('message',listener);});
const start=message('start');process.send({type:'ready'});await start;
try{
    if(mode==='reader'){
        const db=new DatabaseSync(path.join(directory,LEARNING_QUEUE_MUTEX));
        try{db.exec('BEGIN; SELECT count(*) FROM sqlite_schema');process.send({type:'reading'});await message('release');db.exec('COMMIT');}
        finally{db.close();}
    }else await withLearningQueueLock(directory,async()=>{process.send({type:'entered'});});
    process.disconnect();
}catch(error){process.stderr.write(String(error.stack??error));process.exitCode=1;process.disconnect();}
