import fs from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileFingerprint} from '../../bridge/read-bounded.js';
import {safeTarget} from '../../bridge/workspace-paths.js';
import {assertEvaluationHistory} from './history.js';
import {SNAPSHOT_CHUNK_BYTES,snapshotCanonicalJson,snapshotFilePath,type SnapshotFile} from './contract.js';

export interface SnapshotLimits {files:number;entries:number;depth:number;chunks:number}
const maximum:SnapshotLimits={files:50000,entries:100000,depth:64,chunks:1000000};
export interface ImageTree {physical:string;entries:Record<string,string>}
export interface ImageChunk {path:string;offset:number;size:number;fingerprint:string}
const changed=()=>new Error('Файлы LanceDB изменились или содержат неподдерживаемый путь. Снимок не завершён; повторите после остановки индексации.');
const regular=(stat:BigIntStats)=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.size>=0n&&stat.size<=BigInt(Number.MAX_SAFE_INTEGER);
const physical=(stat:BigIntStats)=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

/** Discover every physical root table before SDK access; nested namespaces are never silently skipped. */
export async function physicalSnapshotTableNames(store:string):Promise<string[]>{
 const names:string[]=[];let count=0;
 if(await fs.realpath(store)!==path.resolve(store)||(await fs.lstat(store)).isSymbolicLink())throw changed();
 for await(const entry of await fs.opendir(store)){
  if(++count>maximum.entries)throw changed();
  if(entry.name.endsWith('.lance')){const name=entry.name.slice(0,-6);if(!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(name)||!entry.isDirectory()||names.some(value=>value.toLowerCase()===name.toLowerCase())||names.length>=512)throw changed();names.push(name);}
  else if(entry.name==='eval-sessions'&&entry.isDirectory())await assertEvaluationHistory(path.join(store,entry.name),maximum.entries,maximum.depth);
  else if(entry.name!=='__manifest'&&(entry.isDirectory()||entry.isSymbolicLink()))throw new Error('Вложенные пространства имён и внешние таблицы не поддерживаются полным снимком. Перенесите данные в плоскую локальную LanceDB.');
 }
 if(!names.length)throw new Error('В LanceDB пока нет таблиц. Пустое хранилище не выдаётся за полный снимок.');return names.sort();
}

/** Only SDK table directories are included; private runtime/config files never enter the image. */
export async function imageTree(store:string,names:string[],limits:SnapshotLimits=maximum):Promise<ImageTree>{
    for(const key of Object.keys(maximum) as Array<keyof SnapshotLimits>)if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>maximum[key])throw new Error('Некорректный предел снимка.');
    const root=await fs.lstat(store,{bigint:true});if(!root.isDirectory()||root.isSymbolicLink()||await fs.realpath(store)!==path.resolve(store))throw changed();
    const expected=new Set(names.map(name=>name+'.lance')),actual:string[]=[];
    const top=await fs.opendir(store);let seen=0,files=0;
    for await(const entry of top){if(++seen>limits.entries)throw changed();if(entry.name.endsWith('.lance'))actual.push(entry.name);else if(entry.name==='eval-sessions'&&entry.isDirectory())await assertEvaluationHistory(path.join(store,entry.name),limits.entries,limits.depth);else if(entry.name!=='__manifest'&&(entry.isDirectory()||entry.isSymbolicLink()))throw new Error('Вложенные пространства имён и внешние таблицы не поддерживаются полным снимком. Перенесите данные в плоскую локальную LanceDB.');}
    if(snapshotCanonicalJson(actual.sort())!==snapshotCanonicalJson([...expected].sort()))throw changed();
    const entries:Record<string,string>=Object.create(null) as Record<string,string>;
    const walk=async(relative:string,depth:number):Promise<void>=>{
        if(depth>limits.depth||!snapshotFilePath(relative)||++seen>limits.entries)throw changed();
        const file=await safeTarget(store,relative),stat=await fs.lstat(file,{bigint:true});
        if(stat.isSymbolicLink())throw changed();
        if(stat.isDirectory()){
            entries[relative]='d:'+fileFingerprint(stat)+':'+stat.birthtimeNs;
            for await(const child of await fs.opendir(file))await walk(relative+'/'+child.name,depth+1);
            if(fileFingerprint(await fs.lstat(file,{bigint:true}))!==fileFingerprint(stat))throw changed();
        }else{
            if(!regular(stat)||++files>limits.files)throw changed();entries[relative]='f:'+fileFingerprint(stat);
        }
    };
    for(const name of [...expected].sort())await walk(name,0);
    const after=await fs.lstat(store,{bigint:true});if(!after.isDirectory()||after.isSymbolicLink()||physical(after)!==physical(root))throw changed();
    return {physical:physical(root),entries};
}

async function openChecked(store:string,relative:string,fingerprint:string){
    if(await fs.realpath(store)!==path.resolve(store)||(await fs.lstat(store)).isSymbolicLink())throw changed();
    const file=await safeTarget(store,relative),before=await fs.lstat(file,{bigint:true});
    if(!regular(before)||fileFingerprint(before)!==fingerprint)throw changed();
    const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try{const opened=await handle.stat({bigint:true});if(!regular(opened)||fileFingerprint(opened)!==fingerprint)throw changed();return{handle,file,size:Number(opened.size)};}
    catch(error){await handle.close();throw error;}
}
async function assertFile(store:string,relative:string,file:string,handle:Awaited<ReturnType<typeof fs.open>>,fingerprint:string){
    if(await fs.realpath(store)!==path.resolve(store)||(await fs.lstat(store)).isSymbolicLink()||await safeTarget(store,relative)!==file)throw changed();
    const [opened,located]=await Promise.all([handle.stat({bigint:true}),fs.lstat(file,{bigint:true})]);
    if(!regular(opened)||!regular(located)||fileFingerprint(opened)!==fingerprint||fileFingerprint(located)!==fingerprint)throw changed();
}
async function exactRead(handle:Awaited<ReturnType<typeof fs.open>>,offset:number,size:number):Promise<Buffer>{
    const value=Buffer.allocUnsafe(size);let read=0;
    while(read<size){const part=await handle.read(value,read,size-read,offset+read);if(!part.bytesRead)throw changed();read+=part.bytesRead;}
    return value;
}

/** One bounded chunk is held at a time; hashes sign exact binary bytes, including zero-byte files. */
export async function captureImageFiles(store:string,names:string[],checkpoint:()=>Promise<void>,limits:SnapshotLimits=maximum){
    const before=await imageTree(store,names,limits),files:SnapshotFile[]=[],chunks=new Map<string,ImageChunk>();let count=0;
    for(const [relative,proof] of Object.entries(before.entries).sort(([a],[b])=>a.localeCompare(b,'en'))){
        if(!proof.startsWith('f:'))continue;await checkpoint();
        const fingerprint=proof.slice(2),opened=await openChecked(store,relative,fingerprint),digest=createHash('sha256'),parts:SnapshotFile['chunks']=[];
        try{
            for(let offset=0;offset<opened.size;offset+=SNAPSHOT_CHUNK_BYTES){
                if(++count>limits.chunks)throw changed();await checkpoint();
                const size=Math.min(SNAPSHOT_CHUNK_BYTES,opened.size-offset),bytes=await exactRead(opened.handle,offset,size);digest.update(bytes);
                const sha256=createHash('sha256').update(bytes).digest('hex');parts.push({sha256,size});
                const existing=chunks.get(sha256);if(existing&&existing.size!==size)throw changed();
                if(!existing)chunks.set(sha256,{path:relative,offset,size,fingerprint});
                await assertFile(store,relative,opened.file,opened.handle,fingerprint);
            }
            if((await opened.handle.read(Buffer.alloc(1),0,1,opened.size)).bytesRead)throw changed();
            await assertFile(store,relative,opened.file,opened.handle,fingerprint);
            files.push({path:relative,size:opened.size,sha256:digest.digest('hex'),chunks:parts});
        }finally{await opened.handle.close();}
    }
    const assertCurrent=async()=>{if(snapshotCanonicalJson(await imageTree(store,names,limits))!==snapshotCanonicalJson(before))throw changed();};
    await assertCurrent();
    return {files,chunks,proof:before,assertCurrent,async readChunk(sha256:string):Promise<Buffer>{
        const source=chunks.get(sha256);if(!source)throw new Error('Запрошенный блок не входит в снимок.');await checkpoint();
        const opened=await openChecked(store,source.path,source.fingerprint);
        try{const bytes=await exactRead(opened.handle,source.offset,source.size);await assertFile(store,source.path,opened.file,opened.handle,source.fingerprint);
            if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw changed();return bytes;
        }finally{await opened.handle.close();}
    }};
}
