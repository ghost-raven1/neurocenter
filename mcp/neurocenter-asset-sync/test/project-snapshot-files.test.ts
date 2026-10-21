import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {afterEach,describe,expect,it} from 'vitest';
import {captureImageFiles,imageTree} from '../src/features/project-snapshot/files.js';
import {SNAPSHOT_CHUNK_BYTES} from '../src/features/project-snapshot/contract.js';

let temporary:string,store:string;
const limits={files:50000,entries:100000,depth:64,chunks:1000000};
async function setup(){temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-full-files-')));store=path.join(temporary,'db');await fs.mkdir(path.join(store,'table.lance'),{recursive:true});await fs.writeFile(path.join(store,'table.lance','data'),'actual data');return path.join(store,'table.lance','data');}
afterEach(async()=>{if(temporary)await fs.rm(temporary,{recursive:true,force:true});});
describe('Bounded binary full image proof',()=>{
 it('reads exact 64MiB chunks, preserves zero files, and excludes private root configuration',async()=>{
  const file=await setup(),handle=await fs.open(file,'w');try{await handle.truncate(SNAPSHOT_CHUNK_BYTES+17);await handle.write(Buffer.from([1,2,3]),0,3,SNAPSHOT_CHUNK_BYTES+14);}finally{await handle.close();}
  await fs.writeFile(path.join(store,'table.lance','empty'),'');await fs.writeFile(path.join(store,'private-key.json'),'MUST_NOT_LEAVE');
  const image=await captureImageFiles(store,['table'],async()=>{}),entry=image.files.find(file=>file.path.endsWith('/data'))!;
  expect(entry.chunks.map(chunk=>chunk.size)).toEqual([SNAPSHOT_CHUNK_BYTES,17]);expect(image.files.find(file=>file.path.endsWith('/empty'))).toMatchObject({size:0,chunks:[],sha256:createHash('sha256').update('').digest('hex')});
  const digest=createHash('sha256');for(const part of entry.chunks){const bytes=await image.readChunk(part.sha256);expect(bytes.length).toBe(part.size);digest.update(bytes);}expect(digest.digest('hex')).toBe(entry.sha256);expect(image.files).toHaveLength(2);
  await expect(captureImageFiles(store,['table'],async()=>{},{...limits,chunks:1})).rejects.toThrow();
 },30000);
 it.each(['symlink','hardlink','directory symlink','fifo','invalid portable name'])('rejects %s before reading unrelated bytes',async kind=>{
  const file=await setup(),target=path.join(store,'table.lance','bad');await fs.writeFile(path.join(temporary,'private'),'MUST_NOT_LEAVE');
  if(kind==='symlink')await fs.symlink(path.join(temporary,'private'),target);
  if(kind==='hardlink')await fs.link(file,target);
  if(kind==='directory symlink')await fs.symlink(temporary,target,'dir');
  if(kind==='fifo')execFileSync('mkfifo',[target]);
  if(kind==='invalid portable name')await fs.writeFile(path.join(store,'table.lance','evil:stream'),'unsafe');
  await expect(captureImageFiles(store,['table'],async()=>{})).rejects.toThrow();
 });
 it.each(['files','entries','depth'])('executes the real %s overflow branch instead of silently truncating',async limit=>{
  await setup();await fs.mkdir(path.join(store,'table.lance','a','b'),{recursive:true});await fs.writeFile(path.join(store,'table.lance','second'),'second');
  await expect(imageTree(store,['table'],{...limits,[limit]:1})).rejects.toThrow();
 });
 it.each(['size mutation','inode replacement','new directory','store ABA','source changes during hashing'])('rejects %s and never reports a partial image',async kind=>{
  const file=await setup();let calls=0;
  if(kind==='source changes during hashing'){await expect(captureImageFiles(store,['table'],async()=>{if(++calls===2)await fs.appendFile(file,'changed');})).rejects.toThrow();return;}
  const image=await captureImageFiles(store,['table'],async()=>{}),sha=image.files[0].chunks[0].sha256;
  if(kind==='size mutation')await fs.appendFile(file,'changed');
  if(kind==='inode replacement'){await fs.rename(file,file+'.old');await fs.writeFile(file,'actual data');}
  if(kind==='new directory')await fs.mkdir(path.join(store,'table.lance','new'));
  if(kind==='store ABA'){await fs.rename(store,store+'.old');await fs.cp(store+'.old',store,{recursive:true});}
  await expect(image.assertCurrent()).rejects.toThrow();if(kind!=='new directory')await expect(image.readChunk(sha)).rejects.toThrow();
 });
 it('keeps ordinary evaluation history private while refusing a database hidden below it',async()=>{
  await setup();const history=path.join(store,'eval-sessions','run');await fs.mkdir(history,{recursive:true});await fs.writeFile(path.join(history,'events.jsonl'),'FAKE_PRIVATE_EVALUATION');const image=await captureImageFiles(store,['table'],async()=>{});expect(image.files).toHaveLength(1);expect(JSON.stringify(image.files)).not.toContain('events');
  await fs.mkdir(path.join(history,'hidden.lance'));await expect(image.assertCurrent()).rejects.toThrow('История');
 });
 it.each(['symlink','special','metadata','limit'])('rejects unsafe evaluation history: %s',async kind=>{
  const file=await setup(),history=path.join(store,'eval-sessions');await fs.mkdir(history);
  if(kind==='symlink')await fs.symlink(file,path.join(history,'external'));
  if(kind==='special')execFileSync('mkfifo',[path.join(history,'pipe')]);
  if(kind==='metadata')await fs.mkdir(path.join(history,'__manifest'));
  if(kind==='limit'){await fs.mkdir(path.join(history,'a','b'),{recursive:true});await expect(imageTree(store,['table'],{...limits,depth:1})).rejects.toThrow();return;}
  await expect(captureImageFiles(store,['table'],async()=>{})).rejects.toThrow();
 });
 it('never reads an unknown server-selected SHA',async()=>{await setup();const image=await captureImageFiles(store,['table'],async()=>{});await expect(image.readChunk('a'.repeat(64))).rejects.toThrow('не входит');});
});
