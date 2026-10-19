import {randomUUID} from 'node:crypto';
import {lstat,open,readFile,unlink,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {safeDirectory} from '../models/bundle-files.mjs';

/** Общая блокировка hook/startup: умерший владелец снимается лишь после проверки PID и inode. */
export async function withAssetsLock(root,action,{signal,onProgress=()=>{},waitMs=30*60*1000}={}) {
    await safeDirectory(root,'.run',true);
    const filename=path.join(root,'.run/assets-sync.lock'),token=randomUUID(),started=Date.now(),candidate=filename+'.'+token;
    let owned=false;
    // Lock появляется атомарно только после полной записи владельца: авария не оставляет пустую блокировку.
    try {
        const owner=await open(candidate,'wx',0o600);
        try {await owner.writeFile(JSON.stringify({pid:process.pid,token})+'\n');await owner.sync();}
        finally {await owner.close();}
        while(!owned) {
            signal?.throwIfAborted();
            try {
                await link(candidate,filename);owned=true;
            } catch(error) {
                if(error.code!=='EEXIST')throw error;
                let info;try {info=await lstat(filename);} catch(failure) {if(failure.code==='ENOENT')continue;throw failure;}
                if(!info.isFile()||info.isSymbolicLink()||info.size>1024)throw new Error('Блокировка поставки заменена посторонними данными.');
                let current;try {current=JSON.parse(await readFile(filename,'utf8'));} catch { /* Постороннюю повреждённую блокировку автоматически не удаляем. */ }
                if(Number.isSafeInteger(current?.pid)&&current.pid>0&&typeof current.token==='string') {
                    try {process.kill(current.pid,0);} catch(failure) {
                        if(failure.code==='ESRCH') {
                            try {const after=await lstat(filename);if(after.ino===info.ino&&after.dev===info.dev)await unlink(filename);}
                            catch(failure) {if(failure.code!=='ENOENT')throw failure;}
                            continue;
                        }
                    }
                }
                if(Date.now()-started>=waitMs)throw new Error('Подготовка поставки уже выполняется. Дождитесь завершения и повторите команду.');
                await onProgress({section:'supply',stage:'waiting',message:'Другая команда готовит поставку; ожидаем завершения.'});
                await setTimeout(250,undefined,{signal});
            }
        }
        return await action();
    } finally {
        try {
            if(owned) {
                const current=JSON.parse(await readFile(filename,'utf8'));
                if(current.token===token)await unlink(filename);
            }
        } finally {await rm(candidate,{force:true});}
    }
}
