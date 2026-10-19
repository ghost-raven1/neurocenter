import {readFile,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {inventory,volumeKeys} from './recovery-files.mjs';
import {applicationServices} from './compose-client.mjs';

export const manifestName='manifest.json';
export const manifestDigest=raw=>createHash('sha256').update(raw).digest('hex');
export const projectDatabasePattern=/^nc_rag_[0-9a-f]{32}$/;

/** Фиксированные имена/владельцы не позволяют описи подставить SQL или другой том. */
export function validateManifest(manifest){
    if(!['neurocenter-recovery-v1','neurocenter-recovery-v2'].includes(manifest?.format)||manifest.postgresMajor!==16||!/^sha256:[a-f0-9]{64}$/.test(manifest.postgresImage)||!Number.isFinite(Date.parse(manifest.createdAt))||manifest.quiesced!==true){throw new Error('Неизвестный формат или версия комплекта восстановления');}
    if(!Array.isArray(manifest.databases)||manifest.databases.length<2||manifest.databases.length>10000){throw new Error('Некорректный список баз');}
    const names=new Set();
    for(const db of manifest.databases){
        if(!db||names.has(db.name)||!(db.name==='catalog'||db.name==='rag'||projectDatabasePattern.test(db.name))||db.owner!==(db.name==='catalog'?'nc_catalog':'nc_rag')||db.file!=='databases/'+db.name+'.dump'||db.encoding!=='UTF8'||typeof db.collate!=='string'||typeof db.ctype!=='string'||![db.collate,db.ctype].every(value=>/^[a-zA-Z0-9_.@-]{1,100}$/.test(value))){throw new Error('Некорректное описание базы');}
        names.add(db.name);
    }
    if(!names.has('catalog')||!names.has('rag')){throw new Error('В комплекте отсутствует каталог или реестр баз');}
    for(const service of applicationServices){if(!/^sha256:[a-f0-9]{64}$/.test(manifest.images?.[service])){throw new Error('Не зафиксирован образ '+service);}}
    if(!Array.isArray(manifest.entries)||manifest.entries.length>200000){throw new Error('Некорректная файловая опись');}
    const paths=new Set();
    for(const entry of manifest.entries){
        if(!entry||typeof entry.path!=='string'||entry.path.length>4096||entry.path.split('/').some(part=>!part||part==='.'||part==='..'||/[\\\x00-\x1f\x7f]/.test(part))||paths.has(entry.path)||!['directory','file'].includes(entry.type)||!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>0o777){throw new Error('Некорректный путь или тип файла в описи');}
        if(entry.type==='file'&&(!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256))){throw new Error('Некорректный размер или SHA256 файла');}
        paths.add(entry.path);
    }
    const allowedRoots=['databases','files'];
    if(manifest.entries.some(entry=>!allowedRoots.includes(entry.path.split('/')[0]))){throw new Error('Посторонние файлы в комплекте');}
    for(const db of manifest.databases){if(!manifest.entries.some(entry=>entry.path===db.file&&entry.type==='file'&&entry.size>0)){throw new Error('Отсутствует дамп базы '+db.name);}}
    const dumps=manifest.entries.filter(entry=>entry.type==='file'&&entry.path.startsWith('databases/'));
    if(dumps.length!==manifest.databases.length){throw new Error('Набор дампов не соответствует реестру');}
    const manifestVolumes=manifest.format==='neurocenter-recovery-v1'?volumeKeys.filter(key=>key!=='runtime-artifacts'):volumeKeys;
    for(const key of manifestVolumes){if(!manifest.entries.some(entry=>entry.path==='files/'+key&&entry.type==='directory')){throw new Error('Отсутствует серверный том '+key);}}
    if(manifest.entries.some(entry=>entry.path.startsWith('files/')&&!manifestVolumes.includes(entry.path.split('/')[1]))){throw new Error('Неизвестный серверный том');}
    return manifest;
}

export async function writeManifest(directory,metadata,{checkDeadline=()=>{}}={}){
    const manifest=validateManifest({...metadata,format:'neurocenter-recovery-v2',entries:await inventory(directory,{checkDeadline})});
    const raw=JSON.stringify(manifest,null,2)+'\n';
    await writeFile(path.join(directory,manifestName),raw,{flag:'wx',mode:0o600,flush:true});return {manifest,sha256:manifestDigest(raw)};
}

/** Весь набор, включая лишние файлы и ссылки, проверяется до создания целевого PG. */
export async function verifyBackup(directory,expectedHash,{checkDeadline=()=>{}}={}){
    checkDeadline();
    if(!/^[a-f0-9]{64}$/.test(expectedHash||'')){throw new Error('Нужен --expect-sha256 из сохранённой квитанции');}
    const info=await lstat(path.join(directory,manifestName));if(!info.isFile()||info.nlink!==1||info.size>64*1024*1024){throw new Error('Некорректный файл описи');}
    const raw=await readFile(path.join(directory,manifestName),'utf8');if(manifestDigest(raw)!==expectedHash){throw new Error('SHA256 описи не совпадает с квитанцией');}
    const manifest=validateManifest(JSON.parse(raw));
    const actual=(await inventory(directory,{checkDeadline})).filter(entry=>entry.path!==manifestName);
    if(!isDeepStrictEqual(actual,manifest.entries)){throw new Error('Содержимое копии не соответствует описи: файл отсутствует, изменён или добавлен');}
    return manifest;
}
