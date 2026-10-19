import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import type {ChildProcess} from 'node:child_process';
import {runPgDump,parsePgUrl} from '../src/backups/pg-dump';
import {BackupBudget} from '../src/backups/backup-storage';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));

describe('Завершение потока pg_dump',()=>{
    let root:string;let child:ChildProcess|undefined;let payload:Buffer;let code:number;let hold:boolean;
    beforeEach(async()=>{
        root=await mkdtemp(path.join(os.tmpdir(),'nc-dump-stream-'));payload=Buffer.from('PGDMPПолный дамп');code=0;hold=false;child=undefined;
        vi.mocked(spawn).mockImplementation(()=>{
            const event=new EventEmitter() as ChildProcess;Object.assign(event,{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{event.stdout!.destroy();queueMicrotask(()=>event.emit('close',143));return true;}});child=event;
            queueMicrotask(()=>{if(!hold){event.stdout!.end(payload);event.stderr!.end('password=private');queueMicrotask(()=>event.emit('close',code));}});return event;
        });
    });
    afterEach(async()=>rm(root,{recursive:true,force:true}));
    const location=parsePgUrl('postgresql://user:secret@localhost/fixture');
    const budget=(root:string,max=1000)=>new BackupBudget(root,{maxTotalBytes:1000,maxFileBytes:max,minFreeBytes:1},0);
    it('Успешный поток закрывает descriptor и возвращает читаемый файл без зависания',async()=>{
        const file=path.join(root,'test.partial');expect(await runPgDump(location,file,budget(root),new AbortController().signal)).toBe(payload.length);expect(await readFile(file)).toEqual(payload);
    });
    it('Частичный дамп с ненулевым кодом удаляется, stderr не попадает в ошибку',async()=>{
        code=1;const result=runPgDump(location,path.join(root,'test.partial'),budget(root),new AbortController().signal);
        await expect(result).rejects.toMatchObject({status:503});expect(await readdir(root)).toEqual([]);
    });
    it('Переполнение файла останавливает процесс и удаляет partial',async()=>{
        await expect(runPgDump(location,path.join(root,'test.partial'),budget(root,5),new AbortController().signal)).rejects.toMatchObject({status:507});expect(await readdir(root)).toEqual([]);
    });
    it('Отмена не оставляет ни файл, ни дочерний процесс',async()=>{
        hold=true;const controller=new AbortController();const result=runPgDump(location,path.join(root,'test.partial'),budget(root),controller.signal);const rejected=expect(result).rejects.toMatchObject({status:503});
        while(!child){await new Promise(resolve=>setTimeout(resolve,2));}controller.abort(new Error('stop'));await rejected;expect(await readdir(root)).toEqual([]);
    });
    it('Существующее имя не перезаписывается и не удаляется при отказе',async()=>{
        const file=path.join(root,'old.partial');await writeFile(file,'keep');await expect(runPgDump(location,file,budget(root),new AbortController().signal)).rejects.toMatchObject({code:'EEXIST'});expect(await readFile(file,'utf8')).toBe('keep');
    });
    it('Успех процесса с HTML вместо custom-дампа не публикуется',async()=>{
        payload=Buffer.from('<html>failed</html>');await expect(runPgDump(location,path.join(root,'test.partial'),budget(root),new AbortController().signal)).rejects.toMatchObject({status:503});expect(await readdir(root)).toEqual([]);
    });
});
