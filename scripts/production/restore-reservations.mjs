import {mkdir,lstat,realpath,readFile,writeFile,rm,open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

/** Reservation живёт вне immutable checkpoint; crash оставляет hold до операторской проверки. */
export async function reserveRestoreSource(backupRoot,source,owner){
 const root=await realpath(backupRoot),parentPath=await realpath(path.dirname(path.resolve(source))),resolved=path.join(parentPath,path.basename(source)),info=await lstat(backupRoot);
 if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||parentPath!==root||typeof owner!=='string'||owner.length>100)throw new Error('Некорректная область резервирования копии.');
 const reservations=path.join(root,'.restore-reservations');await mkdir(reservations,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
 const parent=await lstat(reservations);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077)throw new Error('Небезопасный каталог резервирования копий.');
 const target=path.join(reservations,createHash('sha256').update(resolved).digest('hex'));
 try{await mkdir(target,{mode:0o700});}catch(error){if(error.code==='EEXIST')return null;throw error;}
 const token=randomUUID(),filename=path.join(target,'owner.json');
 await writeFile(filename,JSON.stringify({owner,token,source:resolved,createdAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600,flush:true});
 const handle=await open(reservations,'r');try{await handle.sync();}finally{await handle.close();}
 const release=async()=>{
  const current=await lstat(target),file=await lstat(filename);
  if(!current.isDirectory()||current.isSymbolicLink()||!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>4096)throw new Error('Владелец reservation изменился; hold оставлен для проверки.');
  const saved=JSON.parse(await readFile(filename,'utf8'));
  if(saved.token!==token||saved.owner!==owner||saved.source!==resolved)throw new Error('Нельзя освободить reservation другого запуска.');
  await rm(target,{recursive:true});
 };
 release.token=token;return release;
}

/** Повтор ACK после restart освобождает только exact token из закрытого журнала этого запуска. */
export async function releaseSavedRestoreSource(backupRoot,source,owner,token){
 const root=await realpath(backupRoot),resolved=path.join(await realpath(path.dirname(path.resolve(source))),path.basename(source));
 if(path.dirname(resolved)!==root)throw new Error('Reservation выходит за backup-root.');
 const target=path.join(root,'.restore-reservations',createHash('sha256').update(resolved).digest('hex')),filename=path.join(target,'owner.json');
 let info;try{info=await lstat(target);}catch(error){if(error.code==='ENOENT')return;throw error;}
 const file=await lstat(filename);if(!info.isDirectory()||info.isSymbolicLink()||!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>4096)throw new Error('Reservation изменился.');
 const current=JSON.parse(await readFile(filename,'utf8'));if(current.source!==resolved||current.owner!==owner||current.token!==token)throw new Error('Reservation принадлежит другому запуску.');await rm(target,{recursive:true});
}
