import {constants,createWriteStream} from 'node:fs';
import {lstat,readdir,open,mkdir,chmod,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';

export const volumeKeys=['skills','projects','backups','runtime-artifacts'];
const maximumEntries=200000;

function validName(name){return name!=='.'&&name!=='..'&&!/[\\\x00-\x1f\x7f]/.test(name);}

async function ordinaryFile(filename){
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const info=await handle.stat();if(!info.isFile()||info.nlink!==1){throw new Error('В копии допускаются только обычные файлы без жёстких ссылок');}return {handle,info};}
    catch(error){await handle.close();throw error;}
}

function unchanged(before,after){
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||after.nlink!==1){throw new Error('Файл изменился во время чтения');}
}

export async function digestFile(filename,{checkDeadline=()=>{}}={}){
    const {handle,info}=await ordinaryFile(filename);const digest=createHash('sha256');
    try{for await(const chunk of handle.createReadStream({autoClose:false})){checkDeadline();digest.update(chunk);}checkDeadline();unchanged(info,await handle.stat());return digest.digest('hex');}
    finally{await handle.close();}
}

/** Ссылки и специальные файлы отвергаются до записи в целевое хранилище. */
export async function inventory(root,{hash=true,checkDeadline=()=>{}}={}){
    checkDeadline();
    const base=await lstat(root);if(!base.isDirectory()||base.isSymbolicLink()){throw new Error('Нужен обычный каталог копии');}
    const entries=[];
    async function walk(directory,prefix='',depth=0){
        if(depth>128){throw new Error('Слишком глубокое дерево файлов');}
        for(const name of (await readdir(directory)).sort()){
            checkDeadline();
            if(!validName(name)){throw new Error('Недопустимое имя в копии');}
            const relative=prefix+name;if(Buffer.byteLength(relative)>4096||entries.length>=maximumEntries){throw new Error('Превышен предел описи копии');}
            const filename=path.join(directory,name);const info=await lstat(filename);
            if(info.isSymbolicLink()||!info.isDirectory()&&(!info.isFile()||info.nlink!==1)){throw new Error('Ссылки и специальные файлы не поддерживаются резервным копированием');}
            const entry={path:relative,type:info.isDirectory()?'directory':'file',mode:info.mode&0o777};
            if(entry.type==='file'){entry.size=info.size;if(hash){entry.sha256=await digestFile(filename,{checkDeadline});}}
            entries.push(entry);if(entry.type==='directory'){await walk(filename,relative+'/',depth+1);}
        }
    }
    await walk(root);return entries;
}

/** Копирование ограничено проверенным деревом; никогда не перезаписывает файл. */
export async function copyTree(source,destination,{existing=false}={}){
    const entries=await inventory(source,{hash:false});
    if(existing){if((await inventory(destination,{hash:false})).length){throw new Error('Целевой каталог не пуст');}}
    else{await mkdir(destination,{mode:0o700});}
    for(const entry of entries){
        const target=path.join(destination,entry.path);
        if(entry.type==='directory'){await mkdir(target,{mode:0o700});continue;}
        const {handle,info}=await ordinaryFile(path.join(source,entry.path));
        try{
            await pipeline(handle.createReadStream({autoClose:false}),createWriteStream(target,{flags:'wx',mode:0o600,flush:true}));
            unchanged(info,await handle.stat());await chmod(target,entry.mode);
        }finally{await handle.close();}
    }
    for(const entry of entries.filter(item=>item.type==='directory').reverse()){await chmod(path.join(destination,entry.path),entry.mode|0o700);}
}

/** Полный набор томов переносится только после проверки каждого исходного дерева. */
export async function transferVolumes(mode,backupRoot,volumes){
    if(!['backup','restore','check-empty','verify'].includes(mode)){throw new Error('Неизвестная файловая операция');}
    let legacy=false;
    if(mode!=='backup'){
        try{const manifest=JSON.parse(await readFile(path.join(backupRoot,'manifest.json'),'utf8'));legacy=manifest.format==='neurocenter-recovery-v1';}
        catch(error){if(error.code!=='ENOENT'){throw error;}}
    }
    for(const key of volumeKeys){
        const entries=await inventory(volumes[key],{hash:false});
        if(['restore','check-empty'].includes(mode)&&entries.length){throw new Error('Восстановление запрещено: целевой том '+key+' не пуст');}
        if(mode==='backup'&&key==='skills'&&entries.some(entry=>entry.type==='file'&&entry.path.startsWith('.neurocenter-sync-journal/'))){throw new Error('Есть незавершённый журнал скиллов: сначала восстановите сервис и повторите копирование');}
        if(mode==='backup'&&key==='runtime-artifacts'&&entries.some(entry=>entry.path.endsWith('.partial'))){throw new Error('Есть незавершённый импорт готового комплекта: завершите или проверьте его до копирования');}
        if(mode==='backup'&&key==='backups'&&entries.some(entry=>entry.path==='.neurocenter-backup.lock'||entry.path.startsWith('.neurocenter-backup.lock/')||entry.path.endsWith('.dump.partial'))){throw new Error('Есть незавершённая резервная копия: сначала проверьте хранилище и повторите копирование');}
        if(legacy&&key==='runtime-artifacts'){if(entries.length){throw new Error('Старый комплект не содержит runtime-артефактов, целевой том должен быть пуст');}continue;}
        if(mode==='restore'){await inventory(path.join(backupRoot,'files',key),{hash:false});}
        if(mode==='verify'&&!isDeepStrictEqual(await inventory(volumes[key]),await inventory(path.join(backupRoot,'files',key)))){throw new Error('Восстановленный том '+key+' не соответствует копии');}
    }
    if(['check-empty','verify'].includes(mode)){return;}
    if(mode==='backup'){await mkdir(path.join(backupRoot,'files'),{mode:0o700});}
    for(const key of volumeKeys){
        if(legacy&&key==='runtime-artifacts'){continue;}
        if(mode==='backup'){await copyTree(volumes[key],path.join(backupRoot,'files',key));}
        else{await copyTree(path.join(backupRoot,'files',key),volumes[key],{existing:true});}
    }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    process.umask(0o077);
    transferVolumes(process.argv[2],'/backup',Object.fromEntries(volumeKeys.map(key=>[key,'/volumes/'+key])))
        .then(()=>console.log(JSON.stringify({ok:true})))
        .catch(error=>{console.error(error.message);process.exitCode=1;});
}
