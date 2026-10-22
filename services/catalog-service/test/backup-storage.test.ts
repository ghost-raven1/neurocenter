import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile,mkdir,symlink,link,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {backupPolicy,backupError} from '../src/backups/backup-policy';
import {backupDirectories,backupLock,backupUsage,BackupBudget} from '../src/backups/backup-storage';
import {parsePgUrl} from '../src/backups/pg-dump';

describe('Ограничения резервных копий',()=>{
    it('Положительные значения по умолчанию и заданный оператором бюджет',()=>{
        expect(backupPolicy({})).toEqual({maxTotalBytes:64*1024**3,maxFileBytes:16*1024**3,minFreeBytes:1024**3});
        expect(backupPolicy({BACKUP_MAX_TOTAL_BYTES:'100',BACKUP_MAX_FILE_BYTES:'20',BACKUP_MIN_FREE_BYTES:'1'})).toEqual({maxTotalBytes:100,maxFileBytes:20,minFreeBytes:1});
    });
    it.each(['0','','-1','1.5','1e3',' 5','NaN','9007199254740992'])('Неверный лимит %j не отключает защиту',value=>{
        for(const key of ['BACKUP_MAX_TOTAL_BYTES','BACKUP_MAX_FILE_BYTES','BACKUP_MIN_FREE_BYTES']){expect(()=>backupPolicy({[key]:value})).toThrow();}
    });
    it('Один файл не может иметь лимит больше общего хранилища',()=>{expect(()=>backupPolicy({BACKUP_MAX_TOTAL_BYTES:'10',BACKUP_MAX_FILE_BYTES:'11'})).toThrow();});
    it.each(['ENOSPC','EDQUOT'])('Ошибка диска %s даёт 507 с действием и без технического текста',code=>{
        expect(backupError({code,message:'password=private'})).toMatchObject({status:507,response:{code:'BACKUP_DISK_FULL',message:expect.stringContaining('Предыдущие копии сохранены')}});
        expect(JSON.stringify(backupError({code,message:'password=private'}))).not.toContain('private');
    });
    it('Пароль и имя БД декодируются, IPv6 остаётся допустимым для pg_dump',()=>{expect(parsePgUrl('postgresql://name:p%40ss@[::1]:5433/db%5Fname')).toMatchObject({password:'p@ss',host:'::1',port:'5433',database:'db_name'});});
    it.each(['wrong-secret','https://user:private@host/db','postgresql://host/'])('Некорректное подключение не попадает в ошибку: %s',url=>{expect(()=>parsePgUrl(url)).toThrow('Некорректная строка подключения PostgreSQL');});
});

describe('Границы хранилища и единая блокировка',()=>{
    let root:string;beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'nc-backup-test-'));});afterEach(async()=>rm(root,{recursive:true,force:true}));
    it('Неучтённые и частичные файлы тоже занимают бюджет',async()=>{
        await mkdir(path.join(root,'projects'));await writeFile(path.join(root,'manual.dump'),'123');await writeFile(path.join(root,'projects','unfinished.partial'),'45');
        const release=await backupLock(root);try{expect(await backupUsage(root)).toBe(5);}finally{await release();}
    });
    it('Два процесса не получают один корень одновременно, повтор после cleanup допустим',async()=>{
        const release=await backupLock(root);await expect(backupLock(root)).rejects.toMatchObject({status:409,response:{code:'BACKUP_BUSY'}});await release();await(await backupLock(root))();
    });
    it('Изменившийся владелец lock сохраняет чужую блокировку и продолжает запрещать запись',async()=>{
        const release=await backupLock(root);await writeFile(path.join(root,'.neurocenter-backup.lock','owner'),'another-owner');
        await expect(release()).rejects.toThrow('Владелец блокировки');expect(await readFile(path.join(root,'.neurocenter-backup.lock','owner'),'utf8')).toBe('another-owner');
        await expect(backupLock(root)).rejects.toMatchObject({status:409});
    });
    it('Корневой симлинк не создаёт каталог резервной копии в чужой папке',async()=>{
        const target=path.join(root,'foreign'),alias=path.join(root,'alias');await mkdir(target);await symlink(target,alias);
        await expect(backupDirectories(alias,path.join(alias,'child'))).rejects.toThrow('обычный каталог');await expect(readFile(path.join(target,'child'))).rejects.toMatchObject({code:'ENOENT'});
    });
    it('Старая блокировка не удаляется автоматически и не разрешает второго писателя',async()=>{
        await mkdir(path.join(root,'.neurocenter-backup.lock'));await expect(backupLock(root)).rejects.toMatchObject({status:409});
    });
    it('Выход из корня отклоняется до создания каталогов',async()=>{await expect(backupDirectories(root,path.resolve(root,'../outside'))).rejects.toThrow('вне управляемого корня');});
    it('Ссылка в проектном подкаталоге не перенаправляет запись',async()=>{
        await symlink(os.tmpdir(),path.join(root,'projects'));await expect(backupDirectories(root,path.join(root,'projects','outside'))).rejects.toThrow();
    });
    it('Симлинки и hard link не скрывают объём и не удаляют исходный файл',async()=>{
        const file=path.join(root,'original');await writeFile(file,'данные');await symlink(file,path.join(root,'symbolic'));await expect(backupUsage(root)).rejects.toThrow();await rm(path.join(root,'symbolic'));
        await link(file,path.join(root,'hard'));await expect(backupUsage(root)).rejects.toThrow();expect(await readFile(file,'utf8')).toBe('данные');
    });
    it('Точное равенство общей квоте разрешено, следующий байт отклоняется',async()=>{
        const budget=new BackupBudget(root,{maxTotalBytes:100,maxFileBytes:100,minFreeBytes:1},90);await budget.consume(10,10);await expect(budget.consume(1,11)).rejects.toMatchObject({status:507,response:{code:'BACKUP_QUOTA_EXCEEDED'}});
    });
    it('Лимит одного файла действует даже при большом свободном бюджете',async()=>{
        const budget=new BackupBudget(root,{maxTotalBytes:100,maxFileBytes:5,minFreeBytes:1},0);await expect(budget.consume(6,6)).rejects.toMatchObject({status:507});
    });
    it('Резерв диска проверяется перед записью следующего блока',async()=>{
        const budget=new BackupBudget(root,{maxTotalBytes:100,maxFileBytes:100,minFreeBytes:Number.MAX_SAFE_INTEGER},0);await expect(budget.consume(1,1)).rejects.toMatchObject({status:507,response:{code:'BACKUP_DISK_FULL'}});
    });
});
