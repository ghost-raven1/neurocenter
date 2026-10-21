import {constants} from 'node:fs';
import {open,lstat,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {validateManifest} from './recovery-manifest.mjs';
import contract from '../../services/shared/web-restore.cjs';

/** Только operator-owned receipt даёт ожидаемый SHA; SHA самой непроверенной описи не становится доверием. */
export async function privateJson(filename,maximum=65536){
 const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size<1||info.size>maximum||info.mode&0o077)throw new Error('Нужен закрытый обычный JSON файл.');
  const bytes=await handle.readFile(),after=await handle.stat();if(info.size!==after.size||info.mtimeMs!==after.mtimeMs||bytes.length!==info.size)throw new Error('Квитанция изменилась при чтении.');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{await handle.close();}
}
export async function restoreCheckpoints({directory,backupRoot,registry}){
 const root=await realpath(backupRoot),rootInfo=await lstat(backupRoot);
 if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||rootInfo.mode&0o077)throw new Error('Каталог полных копий должен быть обычным закрытым каталогом.');
 const candidates=[];
 const ledgerDirectory=path.join(directory,'maintenance-runner');
 try{
  const info=await lstat(ledgerDirectory);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw new Error('Небезопасный каталог квитанций обслуживания.');
  const names=await readdir(ledgerDirectory);if(names.length>1000)throw new Error('Слишком много квитанций обслуживания.');
  for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const item=await privateJson(path.join(ledgerDirectory,name));
   if(!contract.checkpoint(item.backupId)||!contract.sha(item.sha256)||typeof item.source!=='string')throw new Error('Некорректная квитанция полной копии.');
   candidates.push({id:item.backupId,label:item.backupId,source:item.source,sha256:item.sha256});
  }
 }catch(error){if(error.code!=='ENOENT')throw error;}
 if(registry){
  const saved=await privateJson(registry);if(!saved||Object.keys(saved).join(',')!=='checkpoints'||!Array.isArray(saved.checkpoints)||saved.checkpoints.length>1000)throw new Error('Неверный реестр полных копий.');
  for(const item of saved.checkpoints){if(!item||Object.keys(item).some(key=>!['id','label','source','sha256'].includes(key))||!contract.checkpoint(item.id)||!contract.sha(item.sha256)||typeof item.label!=='string'||typeof item.source!=='string'||path.basename(item.source)!==item.source)throw new Error('Небезопасная запись реестра полных копий.');candidates.push({...item,source:path.join(root,item.source)});}
 }
 const records=new Map();
 for(const item of candidates){
  if(path.dirname(path.resolve(item.source))!==root)throw new Error('Checkpoint должен быть непосредственным дочерним каталогом backup-root.');
  let info;try{info=await lstat(item.source);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077)throw new Error('Небезопасный checkpoint.');
  const manifest=validateManifest(await privateJson(path.join(item.source,'manifest.json'),64*1024*1024));
  const value={...contract.checkpointInfo({id:item.id,label:item.label,sha256:item.sha256,createdAt:manifest.createdAt}),source:path.resolve(item.source)};
  const previous=records.get(item.id);if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw new Error('Checkpoint ID относится к разным копиям.');records.set(item.id,value);
 }
 if(records.size>1000)throw new Error('Слишком много checkpoint.');return [...records.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
