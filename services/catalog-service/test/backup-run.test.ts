import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,readdir,writeFile,readFile,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
const mock=vi.hoisted(()=>({mode:'success',calls:0}));
vi.mock('../src/backups/pg-dump',()=>({parsePgUrl:()=>({database:'fixture'}),runPgDump:async(_location:unknown,file:string,budget:{consume:(size:number,total:number)=>Promise<void>},signal:AbortSignal)=>{
    mock.calls++;if(mock.mode==='second-fails'&&mock.calls===2){throw new Error('SQL private');}
    if(mock.mode==='wait'){await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
    const fs=await import('node:fs/promises');const bytes=Buffer.from('PGDMPfixture');await budget.consume(bytes.length,bytes.length);await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return bytes.length;
}}));

describe('Подтверждение и удержание последних копий',()=>{
    let root:string;let backup:typeof import('../src/catalog/backup');
    const names=(values:string[])=>values.filter(name=>name.endsWith('.dump'));
    beforeEach(async()=>{vi.resetModules();mock.mode='success';mock.calls=0;vi.stubEnv('BACKUP_MIN_FREE_BYTES','1');root=await mkdtemp(path.join(os.tmpdir(),'nc-backup-run-'));backup=await import('../src/catalog/backup');});
    afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});
    const previous=async(root:string):Promise<string[]>=>{const files=Array.from({length:5},(_,i)=>`project-20250101-00000000${i}-00000000-0000-0000-0000-00000000000${i}.dump`);for(const file of files){await writeFile(path.join(root,file),'PGDMPold');}return files;};
    it('До подтверждения новый файл полный и приватный, а пять старых ещё доступны',async()=>{
        const old=await previous(root);let confirmed=false;
        const result=await backup.runAllBackups({project:'fixture'},root,{confirm:async made=>{
            expect(names(await readdir(root))).toHaveLength(6);for(const file of old){expect(await readFile(path.join(root,file),'utf8')).toBe('PGDMPold');}
            expect((await stat(made.files[0].file)).mode&0o777).toBe(0o600);confirmed=true;
        }});
        expect(confirmed).toBe(true);expect(result.errors).toEqual([]);expect(names(await readdir(root))).toHaveLength(5);expect(await readFile(result.files[0].file,'utf8')).toBe('PGDMPfixture');
    });
    it('Отказ подтверждения оставляет новый файл для проверки и сохраняет все старые',async()=>{
        const old=await previous(root);await expect(backup.runAllBackups({project:'fixture'},root,{confirm:async()=>{throw new Error('БД недоступна');}})).rejects.toMatchObject({status:503,response:{code:'BACKUP_CONFIRMATION_FAILED'}});
        expect(names(await readdir(root))).toHaveLength(6);for(const file of old){expect(await readFile(path.join(root,file),'utf8')).toBe('PGDMPold');}
        expect((await readdir(root)).some(name=>name.includes('partial')||name.includes('lock'))).toBe(false);
    });
    it('Сбой второй БД не публикует первый незавершённый комплект и не запускает retention',async()=>{
        const old=await previous(root);mock.mode='second-fails';const confirm=vi.fn();await expect(backup.runAllBackups({project:'fixture',rag:'fixture'},root,{confirm})).rejects.toMatchObject({status:503});
        expect(confirm).not.toHaveBeenCalled();expect((await readdir(root)).sort()).toEqual(old.sort());
    });
    it('Сбой квоты до публикации сохраняет все исходные файлы',async()=>{
        const old=await previous(root);vi.stubEnv('BACKUP_MAX_TOTAL_BYTES','40');vi.stubEnv('BACKUP_MAX_FILE_BYTES','40');
        await expect(backup.runAllBackups({project:'fixture'},root)).rejects.toMatchObject({status:507});expect((await readdir(root)).sort()).toEqual(old.sort());
    });
    it('Чужой файл с похожим именем не удаляется при очистке',async()=>{
        await previous(root);await writeFile(path.join(root,'project-my-important.dump'),'keep');await backup.runAllBackups({project:'fixture'},root);expect(await readFile(path.join(root,'project-my-important.dump'),'utf8')).toBe('keep');
    });
    it('Сдвиг часов назад не удаляет только что подтверждённую копию',async()=>{
        const old=await previous(root);for(const file of old){await rm(path.join(root,file));await writeFile(path.join(root,file.replace('20250101','20990101')),'PGDMPfuture');}
        const result=await backup.runAllBackups({project:'fixture'},root);expect(await readFile(result.files[0].file,'utf8')).toBe('PGDMPfixture');expect(names(await readdir(root))).toHaveLength(5);
    });
    it('Каталог получает только имена файлов, действительно удалённых retention',async()=>{
        const old=await previous(root);const removed:string[]=[];await backup.runAllBackups({project:'fixture'},root,{afterPrune:async files=>{removed.push(...files);}});
        expect(removed.map(file=>path.basename(file))).toEqual([old[0]]);await expect(readFile(removed[0])).rejects.toMatchObject({code:'ENOENT'});
    });
    it('Отказ очистки старого объекта даёт предупреждение и сохраняет подтверждённую копию',async()=>{
        const old=await previous(root);const unexpected=path.join(root,old[0]);await rm(unexpected);await mkdir(unexpected);
        const result=await backup.runAllBackups({project:'fixture'},root,{confirm:async()=>undefined});
        expect(result.warnings).toHaveLength(1);expect((await stat(unexpected)).isDirectory()).toBe(true);expect(await readFile(result.files[0].file,'utf8')).toBe('PGDMPfixture');
        for(const name of old.slice(1)){expect(await readFile(path.join(root,name),'utf8')).toBe('PGDMPold');}
    });
    it('Отказ удаления старых метаданных не превращает готовый дамп в ошибку',async()=>{
        await previous(root);const result=await backup.runAllBackups({project:'fixture'},root,{confirm:async()=>undefined,afterPrune:async()=>{throw new Error('SQL private');}});
        expect(result.warnings).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('SQL private');expect(await readFile(result.files[0].file,'utf8')).toBe('PGDMPfixture');expect(names(await readdir(root))).toHaveLength(5);
    });
    it('Общая блокировка удерживается до конца подтверждения метаданных',async()=>{
        let start!:()=>void;let release!:()=>void;const started=new Promise<void>(resolve=>start=resolve);const hold=new Promise<void>(resolve=>release=resolve);
        const pending=backup.runAllBackups({project:'fixture'},path.join(root,'project'),{rootDirectory:root,confirm:async()=>{start();await hold;}});
        await started;await expect(backup.runAllBackups({system:'fixture'},root)).rejects.toMatchObject({status:409});release();await pending;
    });
    it('Остановка сервера снимает блокировку и не объявляет незавершённый поток успешным',async()=>{
        mock.mode='wait';const pending=backup.runAllBackups({project:'fixture'},root);const rejected=expect(pending).rejects.toMatchObject({status:503,response:{code:'BACKUP_STOPPED'}});
        while(!mock.calls){await new Promise(resolve=>setTimeout(resolve,5));}await backup.stopBackups();await rejected;expect(await readdir(root)).toEqual([]);
    });
    it('Deadline прерывает зависший поток и освобождает mutex без очистки старых файлов',async()=>{
        const old=await previous(root);mock.mode='wait';vi.useFakeTimers();
        const pending=backup.runAllBackups({project:'fixture'},root);const rejected=expect(pending).rejects.toMatchObject({status:503,response:{code:'BACKUP_TIMEOUT'}});
        await vi.waitFor(()=>expect(mock.calls).toBe(1));await vi.advanceTimersByTimeAsync(20_000);await rejected;expect((await readdir(root)).sort()).toEqual(old.sort());
    });
    it('Потерянное подтверждение при остановке не уничтожает готовый файл',async()=>{
        await previous(root);let start!:()=>void;const started=new Promise<void>(resolve=>start=resolve);
        const pending=backup.runAllBackups({project:'fixture'},root,{confirm:async()=>{start();await new Promise(()=>undefined);}});const rejected=expect(pending).rejects.toMatchObject({response:{code:'BACKUP_CONFIRMATION_FAILED'}});
        await started;await backup.stopBackups();await rejected;expect(names(await readdir(root))).toHaveLength(6);
    });
});
