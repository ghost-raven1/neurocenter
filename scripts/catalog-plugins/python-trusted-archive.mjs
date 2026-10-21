import {createHash} from 'node:crypto';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import runtime from '../../services/shared/runtime-artifacts.cjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const tar=require('tar');

/** Pinned producer tools alone may normalize internal file links; uploaded archives never use this parser. */
export async function extractPinnedPythonArchive(filename,pin,directory,{headlessPython=false}={}){
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat();
  if(!before.isFile()||before.nlink!==1||before.size!==pin.bytes)throw new Error('Размер закреплённого Python toolchain не совпал.');
  const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
  if(hash.digest('hex')!==pin.sha256)throw new Error('SHA-256 закреплённого Python toolchain не совпала.');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  if((await fs.lstat(directory)).isSymbolicLink()||(await fs.readdir(directory)).length)throw new Error('Python toolchain требует пустую обычную папку.');
  const entries=new Map(),folded=new Map(),writes=[];let bytes=0,count=0,omittedEntries=0,omittedBytes=0;
  const parser=new tar.Parser({strict:true,onReadEntry(entry){
   const task=(async()=>{
    const name=entry.path.replace(/^(?:\.\/)+/,'').replace(/\/$/,'');
    if(!runtime.portablePath(name)||!['Directory','File','SymbolicLink','Link'].includes(entry.type)||entries.has(name))throw new Error('Небезопасная запись Python toolchain.');
    if(++count>runtime.LIMITS.filesCount||!Number.isSafeInteger(entry.size)||entry.size<0||(bytes+=entry.size)>runtime.LIMITS.unpackedBytes)throw new Error('Python toolchain превышает лимиты.');
    // PBS terminal descriptions contain POSIX case-distinct aliases. Stdio MCP does not use terminal UI data.
    if(headlessPython&&(name==='python/share/terminfo'||name.startsWith('python/share/terminfo/'))){
     omittedEntries++;omittedBytes+=entry.size;entry.resume();return;
    }
    const parts=name.split('/');
    for(let length=1;length<=parts.length;length++){
     const prefix=parts.slice(0,length).join('/'),key=prefix.normalize('NFC').toLowerCase();
     if(folded.has(key)&&folded.get(key)!==prefix)throw new Error('Конфликт путей Python toolchain.');
     if(length<parts.length&&entries.has(prefix)&&entries.get(prefix).type!=='Directory')throw new Error('Файл является родителем Python toolchain.');
     folded.set(key,prefix);
    }
    if(entry.type!=='Directory'&&[...entries.keys()].some(item=>item.startsWith(name+'/')))throw new Error('Конфликт папки Python toolchain.');
    const item={type:entry.type,size:entry.size,mode:entry.mode,link:entry.linkpath};entries.set(name,item);
    const destination=path.join(directory,name);
    if(entry.type==='Directory'){await fs.mkdir(destination,{recursive:true,mode:0o700});entry.resume();}
    else if(entry.type==='File'){
     await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
     await pipeline(entry,createWriteStream(destination,{flags:'wx',mode:item.mode&0o111?0o755:0o644}));
    }else entry.resume();
   })();
   writes.push(task);task.catch(error=>parser.abort(error));
  }});
  await pipeline(handle.createReadStream({autoClose:false,start:0}),parser);await Promise.all(writes);
  const resolve=(name,visited=new Set())=>{
   if(visited.has(name))throw new Error('Цикл ссылок Python toolchain.');visited.add(name);
   const item=entries.get(name);if(!item)throw new Error('Отсутствует цель ссылки Python toolchain.');
   if(item.type==='File')return {name,item};
   if(!['SymbolicLink','Link'].includes(item.type)||typeof item.link!=='string'||path.posix.isAbsolute(item.link)||item.link.includes('\\'))throw new Error('Некорректная ссылка Python toolchain.');
   const target=path.posix.normalize(item.type==='Link'?item.link:path.posix.join(path.posix.dirname(name),item.link));
   if(!runtime.portablePath(target))throw new Error('Ссылка выходит за Python toolchain.');
   return resolve(target,visited);
  };
  for(const [name,item] of entries)if(['SymbolicLink','Link'].includes(item.type)){
   const resolved=resolve(name);bytes+=resolved.item.size;
   if(bytes>runtime.LIMITS.unpackedBytes)throw new Error('Нормализованный Python toolchain превышает лимит.');
   const destination=path.join(directory,name);await fs.mkdir(path.dirname(destination),{recursive:true});
   await fs.copyFile(path.join(directory,resolved.name),destination,constants.COPYFILE_EXCL);
   await fs.chmod(destination,resolved.item.mode&0o111?0o755:0o644);
  }
  const after=await handle.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Python toolchain изменился при подготовке.');
  return {files:entries.size,unpackedBytes:bytes-omittedBytes,...(headlessPython?{policy:'headless-mcp-v1',omittedEntries,omittedBytes}:{})};
 }finally{await handle.close();}
}
