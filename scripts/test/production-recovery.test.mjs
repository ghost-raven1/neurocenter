import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link,readdir,chmod,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applicationServices,composeClient,saveDiagnostic} from '../production/compose-client.mjs';
import {copyTree,inventory,transferVolumes,volumeKeys} from '../production/recovery-files.mjs';
import {writeManifest,verifyBackup,validateManifest} from '../production/recovery-manifest.mjs';
import {assertExternalDestination} from '../production/recovery.mjs';

const image='sha256:'+'a'.repeat(64);
const metadata=()=>({createdAt:'2026-10-17T00:00:00.000Z',postgresMajor:16,postgresImage:image,images:Object.fromEntries(applicationServices.map(key=>[key,image])),quiesced:true,
    databases:['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C.UTF-8',ctype:'C.UTF-8',file:'databases/'+name+'.dump'}))});

async function fixture(action){
    const root=await mkdtemp(path.join(tmpdir(),'nc-recovery-'));const backup=path.join(root,'backup');await mkdir(backup,{mode:0o700});
    try{
        await mkdir(path.join(backup,'databases'));for(const db of metadata().databases){await writeFile(path.join(backup,db.file),'тестовый дамп '+db.name);}
        for(const key of volumeKeys){await mkdir(path.join(backup,'files',key),{recursive:true});}
        await writeFile(path.join(backup,'files/skills/инструкция.md'),'# Знания команды');
        const receipt=await writeManifest(backup,metadata());await action({root,backup,...receipt});
    }finally{await rm(root,{recursive:true,force:true});}
}

test('Полный комплект проверяется по внешней квитанции и всем файлам',async()=>fixture(async({backup,sha256,manifest})=>{
    assert.deepEqual(await verifyBackup(backup,sha256),manifest);assert.ok(manifest.entries.some(entry=>entry.path==='files/skills/инструкция.md'));
}));
test('Изменение содержимого при прежнем размере выявляется SHA256',async()=>fixture(async({backup,sha256})=>{
    const file=path.join(backup,'databases/rag.dump');const before=await readFile(file);before[0]^=1;await writeFile(file,before);await assert.rejects(verifyBackup(backup,sha256),/описи/);
}));
test('Обрезанный дамп блокирует восстановление',async()=>fixture(async({backup,sha256})=>{
    await writeFile(path.join(backup,'databases/rag.dump'),'');await assert.rejects(verifyBackup(backup,sha256));
}));
test('Отсутствующий Markdown блокирует восстановление',async()=>fixture(async({backup,sha256})=>{
    await rm(path.join(backup,'files/skills/инструкция.md'));await assert.rejects(verifyBackup(backup,sha256));
}));
test('Лишний файл не игнорируется при проверке комплекта',async()=>fixture(async({backup,sha256})=>{
    await writeFile(path.join(backup,'files/projects/лишний.txt'),'посторонний');await assert.rejects(verifyBackup(backup,sha256));
}));
test('Подмена описи и неверная квитанция отклоняются',async()=>fixture(async({backup,sha256})=>{
    await assert.rejects(verifyBackup(backup,'0'.repeat(64)),/квитанцией/);
    await writeFile(path.join(backup,'manifest.json'),'{}');await assert.rejects(verifyBackup(backup,sha256),/квитанцией/);
}));
test('Без отдельно сохранённого SHA256 восстановление не начинается',async()=>fixture(async({backup})=>{
    for(const value of [undefined,'',123,'../hash']){await assert.rejects(verifyBackup(backup,value));}
}));
test('Симлинк на чужой файл не проходит проверку копии',async()=>fixture(async({root,backup,sha256})=>{
    await writeFile(path.join(root,'outside'),'не читать');await symlink(path.join(root,'outside'),path.join(backup,'files/projects/link'));await assert.rejects(verifyBackup(backup,sha256),/Ссылки/);
}));
test('Жёсткая ссылка вместо файла блокирует копирование',async()=>fixture(async({root})=>{
    const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'a'),'test');await link(path.join(source,'a'),path.join(source,'b'));
    await assert.rejects(copyTree(source,path.join(root,'destination')),/Ссылки/);await assert.rejects(stat(path.join(root,'destination')),{code:'ENOENT'});
}));
test('Ссылка вместо описи не читается',async()=>fixture(async({root,backup,sha256})=>{
    await rm(path.join(backup,'manifest.json'));await writeFile(path.join(root,'outside'),'{}');await symlink(path.join(root,'outside'),path.join(backup,'manifest.json'));await assert.rejects(verifyBackup(backup,sha256),/описи/);
}));
test('Выход за корень и управляющие символы в описи запрещены',async()=>fixture(async({manifest})=>{
    for(const value of ['../outside','/root/secret','files/../secrets','files\\secret','files/skills/a\nb']){
        const changed=structuredClone(manifest);changed.entries[0].path=value;assert.throws(()=>validateManifest(changed),/путь/);
    }
}));
test('SQL в имени БД, подмена владельца и повтор базы запрещены',async()=>fixture(async({manifest})=>{
    for(const change of [{name:'catalog;DROP DATABASE postgres'},{owner:'nc_owner'},{file:'../catalog.dump'},{name:'postgres'}]){
        const changed=structuredClone(manifest);Object.assign(changed.databases[0],change);assert.throws(()=>validateManifest(changed));
    }
    const changed=structuredClone(manifest);changed.databases.push(changed.databases[0]);assert.throws(()=>validateManifest(changed));
}));
test('Другой формат, версия PostgreSQL и неизвестный образ требуют отдельной миграции',async()=>fixture(async({manifest})=>{
    for(const change of [{format:'other'},{postgresMajor:17},{postgresImage:'latest'},{quiesced:false},{images:{}}]){assert.throws(()=>validateManifest({...manifest,...change}));}
}));
test('Проверяются размеры, типы, дубликаты и контрольные суммы файлов',async()=>fixture(async({manifest})=>{
    const index=manifest.entries.findIndex(entry=>entry.type==='file');
    for(const change of [{type:'symlink'},{size:-1},{size:Number.MAX_SAFE_INTEGER+1},{sha256:'wrong'},{mode:0o4777}]){
        const changed=structuredClone(manifest);Object.assign(changed.entries[index],change);assert.throws(()=>validateManifest(changed));
    }
    const duplicate=structuredClone(manifest);duplicate.entries.push(duplicate.entries[index]);assert.throws(()=>validateManifest(duplicate));
}));
test('Неизвестный том и неполный набор дампов запрещены',async()=>fixture(async({manifest})=>{
    for(const removed of ['databases/catalog.dump','files/skills']){const changed=structuredClone(manifest);changed.entries=changed.entries.filter(entry=>entry.path!==removed);assert.throws(()=>validateManifest(changed));}
    const changed=structuredClone(manifest);changed.entries.push({path:'files/secrets',type:'directory',mode:0o700});assert.throws(()=>validateManifest(changed));
}));
test('Непустой второй том обнаруживается до записи первого',async()=>fixture(async({root,backup})=>{
    const volumes={};for(const key of volumeKeys){volumes[key]=path.join(root,key);await mkdir(volumes[key]);}
    await writeFile(path.join(volumes.projects,'existing'),'сохранить');await assert.rejects(transferVolumes('restore',backup,volumes),/не пуст/);
    assert.deepEqual(await readdir(volumes.skills),[]);assert.equal(await readFile(path.join(volumes.projects,'existing'),'utf8'),'сохранить');
}));
test('Незавершённый журнал скиллов не выдаётся за согласованную копию',async()=>fixture(async({root})=>{
    const volumes={};for(const key of volumeKeys){volumes[key]=path.join(root,key);await mkdir(volumes[key]);}
    await mkdir(path.join(volumes.skills,'.neurocenter-sync-journal'));await writeFile(path.join(volumes.skills,'.neurocenter-sync-journal/pending.json'),'{}');
    const destination=path.join(root,'destination');await mkdir(destination);await assert.rejects(transferVolumes('backup',destination,volumes),/журнал/);assert.deepEqual(await readdir(destination),[]);
}));
for(const marker of ['.neurocenter-backup.lock/owner','projects/fixture/project-test.dump.partial']){
    test('Незавершённая копия блокирует полный комплект до переноса файлов: '+marker,async()=>fixture(async({root})=>{
        const volumes={};for(const key of volumeKeys){volumes[key]=path.join(root,key);await mkdir(volumes[key]);}
        const filename=path.join(volumes.backups,marker);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,'незавершённая операция');
        const destination=path.join(root,'destination');await mkdir(destination);
        await assert.rejects(transferVolumes('backup',destination,volumes),/незавершённая резервная копия/);assert.deepEqual(await readdir(destination),[]);
        assert.equal(await readFile(filename,'utf8'),'незавершённая операция');
    }));
}
test('Пустые папки, русские имена и исполняемый файл сохраняются',async()=>fixture(async({root})=>{
    const source=path.join(root,'source');await mkdir(source);await mkdir(path.join(source,'пустая'));await writeFile(path.join(source,'команда.sh'),'#!/bin/sh\nexit 0\n');await chmod(path.join(source,'команда.sh'),0o750);
    const destination=path.join(root,'copy');await copyTree(source,destination);assert.deepEqual(await inventory(source),await inventory(destination));
}));
test('Файловые тома полностью восстанавливаются в пустые каталоги',async()=>fixture(async({root,backup})=>{
    const volumes={};for(const key of volumeKeys){volumes[key]=path.join(root,key);await mkdir(volumes[key]);}
    await transferVolumes('restore',backup,volumes);assert.equal(await readFile(path.join(volumes.skills,'инструкция.md'),'utf8'),'# Знания команды');assert.deepEqual(await readdir(volumes.backups),[]);
    await transferVolumes('verify',backup,volumes);await writeFile(path.join(volumes.skills,'инструкция.md'),'повреждено');await assert.rejects(transferVolumes('verify',backup,volumes),/не соответствует/);
}));
test('Имя Compose-проекта проверяется до вызова Docker',()=>{
    for(const projectName of ['../production','--project-directory','test;echo','UPPER','']){assert.throws(()=>composeClient({directory:'/test',projectName}));}
});
test('Пустой параметр имени стека не возвращает setup к рабочему production по умолчанию',()=>{
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../production/setup.mjs',import.meta.url)),'up','--project-name'],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert.ok(result.stderr.includes('Некорректное имя Compose-проекта'));
});
test('Подробности сбоя пишутся в закрытый журнал без перехода по ссылкам',async()=>fixture(async({root})=>{
    const error={diagnostic:'закрытые технические сведения'};const filename=await saveDiagnostic(error,root);assert.equal((await stat(filename)).mode&0o777,0o600);assert.equal(await readFile(filename,'utf8'),error.diagnostic);
    assert.notEqual(await saveDiagnostic(error,root),filename);
    await rm(path.join(root,'operation-logs'),{recursive:true});await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(root,'operation-logs'));
    assert.equal(await saveDiagnostic(error,root),undefined);assert.deepEqual(await readdir(path.join(root,'outside')),[]);
}));
test('Копия не создаётся внутри PG или собственного backup-тома',()=>{
    const mounts=[{Source:'/var/lib/docker/volumes/nc_postgres/_data'},{Source:'/var/lib/docker/volumes/nc_backups/_data'}];
    for(const {Source:root} of mounts){for(const filename of [root,root+'/snapshot']){assert.throws(()=>assertExternalDestination(filename,mounts),/вне рабочих томов/);}}
    assert.doesNotThrow(()=>assertExternalDestination('/mnt/independent/snapshot',mounts));
});

test('Готовые runtime-комплекты включаются в полную копию и проверяются после восстановления',async()=>fixture(async({root,backup})=>{
    const source=path.join(root,'source-volumes'),target=path.join(root,'target-volumes');await mkdir(source);await mkdir(target);const sourceVolumes={},targetVolumes={};
    for(const key of volumeKeys){sourceVolumes[key]=path.join(source,key);targetVolumes[key]=path.join(target,key);await mkdir(sourceVolumes[key]);await mkdir(targetVolumes[key]);}
    const filename='a'.repeat(64)+'.tar.gz';await writeFile(path.join(sourceVolumes['runtime-artifacts'],filename),'готовый неизменяемый архив');const copy=path.join(root,'artifact-copy');await mkdir(copy);
    await transferVolumes('backup',copy,sourceVolumes);await transferVolumes('restore',copy,targetVolumes);await transferVolumes('verify',copy,targetVolumes);assert.equal(await readFile(path.join(targetVolumes['runtime-artifacts'],filename),'utf8'),'готовый неизменяемый архив');
}));

test('Незавершённый импорт runtime-комплекта блокирует полную копию до первой записи',async()=>fixture(async({root})=>{
    const volumes={};for(const key of volumeKeys){volumes[key]=path.join(root,key);await mkdir(volumes[key]);}await writeFile(path.join(volumes['runtime-artifacts'],'.pending.partial'),'незавершённый архив');const copy=path.join(root,'copy');await mkdir(copy);await assert.rejects(transferVolumes('backup',copy,volumes),/Незавершённый|незавершённый/);assert.deepEqual(await readdir(copy),[]);
}));

test('Историческая полная копия v1 проверяется и восстанавливается с пустым новым томом',async()=>fixture(async({root,backup,manifest})=>{
    await rm(path.join(backup,'files/runtime-artifacts'),{recursive:true});const legacy={...manifest,format:'neurocenter-recovery-v1',entries:manifest.entries.filter(entry=>entry.path!=='files/runtime-artifacts'&&!entry.path.startsWith('files/runtime-artifacts/'))};const {createHash}=await import('node:crypto');const raw=JSON.stringify(legacy,null,2)+'\n';await writeFile(path.join(backup,'manifest.json'),raw);assert.deepEqual(await verifyBackup(backup,createHash('sha256').update(raw).digest('hex')),legacy);
    const volumes={};for(const key of volumeKeys){volumes[key]=path.join(root,key);await mkdir(volumes[key]);}await transferVolumes('restore',backup,volumes);await transferVolumes('verify',backup,volumes);assert.deepEqual(await readdir(volumes['runtime-artifacts']),[]);
}));
