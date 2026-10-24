import {BadRequestException,ConflictException} from '@nestjs/common';
import {Pool,type PoolClient} from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {SourceUploads} from '../src/source-upload/source-upload.service';
import type {UploadBuildSource} from '../src/source-upload/source-upload.model';
import {ownedAccessTestAdminUrl} from './access-write-postgres.fixture';
import {inspectUploadArchive} from '../../shared/upload-inspection.cjs';

const connection=process.env.CATALOG_TEST_PG_URL,actor={email:'upload-ack-owner@example.test',activeRole:'Главный админ'};
function executable(){const bytes=Buffer.alloc(64);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x100000c,4);bytes.writeUInt32LE(2,12);bytes.writeUInt32LE(1,16);bytes.writeUInt32LE(24,20);bytes.writeUInt32LE(0x32,32);bytes.writeUInt32LE(24,36);bytes.writeUInt32LE(1,40);return bytes;}
const intent=(bytes=executable())=>({requestKey:randomUUID(),name:'program',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
function barrier(){let release!:()=>void;return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}

/** Real PostgreSQL COMMIT/ROLLBACK and files; only delivery of the selected COMMIT acknowledgement is faulted. */
describe.skipIf(!connection)('Source upload settlement recovers an uncertain COMMIT acknowledgement',()=>{
 let admin:Pool,pool:Pool,database:string,root:string,uploads:SourceUploads;
 const pending:Promise<unknown>[]=[];
 const releases=new Set<()=>void>();
 beforeAll(async()=>{
  const url=ownedAccessTestAdminUrl(connection!);admin=new Pool({connectionString:url.href,max:1});database='nc_source_upload_ack_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;
  pool=new Pool({connectionString:url.href,max:8});await ensureCatalogSchema(pool);await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true)',[actor.email]);
 });
 beforeEach(async()=>{await pool.query('DELETE FROM tool_build_jobs');await pool.query('DELETE FROM tool_source_uploads');await pool.query('UPDATE platform_users SET is_main_admin=true,enabled=true WHERE email=$1',[actor.email]);root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-source-upload-ack-'));uploads=new SourceUploads(pool,root);await uploads.setup();vi.stubEnv('CAPACITY_REQUIRED','false');});
 afterEach(async()=>{for(const release of releases)release();releases.clear();await Promise.allSettled(pending.splice(0));uploads?.stop();vi.restoreAllMocks();vi.unstubAllEnvs();if(root)await fs.rm(root,{recursive:true,force:true});});
 afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP DATABASE '+database);await admin.end();}});
 const source=(row:{id:string;sha256:string;bytes:number}):UploadBuildSource=>({type:'upload',uploadId:row.id,sha256:row.sha256,bytes:row.bytes,entrypoint:'program'});
 async function begin(bytes=executable()){const request=intent(bytes),row=await uploads.create(actor,request);return {request,row,bytes,receive:vi.spyOn(uploads.files,'receive')};}
 function loseAcknowledgement(mode:'commit'|'rollback',after?:()=>Promise<void>){
  const original=uploads.repository.transaction.bind(uploads.repository),error=new Error('Owned READY commit acknowledgement was lost');let reached=false;
  vi.spyOn(uploads.repository,'transaction').mockImplementationOnce(async work=>{
   let restore:(()=>void)|undefined;
   try{return await original(async client=>{
    const query=client.query.bind(client) as (...args:unknown[])=>Promise<unknown>;
    const spy=vi.spyOn(client,'query').mockImplementation((async(...args:unknown[])=>{
     const text=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text;
     if(text==='COMMIT'&&!reached){reached=true;await query(mode==='commit'?'COMMIT':'ROLLBACK');await after?.();throw error;}
     return query(...args);
    }) as PoolClient['query']);restore=()=>spy.mockRestore();return work(client);
   });}finally{restore?.();}
  });
  return {error,get reached(){return reached;}};
 }
 it('keeps the committed blob and original failure, then recovers the same UUID and pin without another byte write',async()=>{
  const f=await begin();let committedInode:number|undefined;
  const fault=loseAcknowledgement('commit',async()=>{committedInode=(await fs.stat(uploads.files.filename(f.row.id))).ino;});
  await expect(uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length)).rejects.toMatchObject({status:400,message:fault.error.message});expect(fault.reached).toBe(true);
  expect((await pool.query('SELECT state,lease_token FROM tool_source_uploads WHERE id=$1',[f.row.id])).rows[0]).toEqual({state:'READY',lease_token:null});
  expect(await fs.readFile(uploads.files.filename(f.row.id))).toEqual(f.bytes);expect((await fs.stat(uploads.files.filename(f.row.id))).ino).toBe(committedInode);
  expect(await uploads.lookup(actor,f.request.requestKey)).toMatchObject({id:f.row.id,state:'READY'});await expect(uploads.pin(actor,source(f.row))).resolves.toMatchObject({uploadId:f.row.id});
  expect(await uploads.content(actor,f.row.id,Readable.from([Buffer.from('unused retry body')]),undefined)).toMatchObject({id:f.row.id,state:'READY'});expect(f.receive).toHaveBeenCalledOnce();
 });
 it('removes an uncommitted blob after a real rollback is confirmed and never exposes it as a READY pin',async()=>{
  const f=await begin(),fault=loseAcknowledgement('rollback');
  await expect(uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length)).rejects.toMatchObject({status:400,message:fault.error.message});expect(fault.reached).toBe(true);
  expect(await uploads.lookup(actor,f.request.requestKey)).toMatchObject({id:f.row.id,state:'WAITING'});await expect(uploads.pin(actor,source(f.row))).rejects.toBeInstanceOf(ConflictException);
  await expect(fs.stat(uploads.files.filename(f.row.id))).rejects.toMatchObject({code:'ENOENT'});
  expect(await uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length)).toMatchObject({id:f.row.id,state:'READY'});expect(f.receive).toHaveBeenCalledTimes(2);
 });
 it.each(['commit','rollback'] as const)('retains checked bytes when a fresh outcome read fails after %s, then reconciles the same UUID without rewriting',async mode=>{
  const f=await begin();let ackLost=false;const fault=loseAcknowledgement(mode,async()=>{ackLost=true;});
  const get=uploads.repository.get.bind(uploads.repository);const read=vi.spyOn(uploads.repository,'get').mockImplementation(async(...args)=>{if(ackLost&&args[3]===true)throw new Error('Owned post-commit row read unavailable');return get(...args);});
  await expect(uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length)).rejects.toMatchObject({status:400,message:fault.error.message});expect(fault.reached).toBe(true);
  const kept=await fs.stat(uploads.files.filename(f.row.id));expect(await fs.readFile(uploads.files.filename(f.row.id))).toEqual(f.bytes);read.mockRestore();
  const recovered=await uploads.content(actor,f.row.id,Readable.from([Buffer.from('must not replace checked bytes')]),undefined);expect(recovered).toMatchObject({id:f.row.id,state:'READY'});
  expect((await fs.stat(uploads.files.filename(f.row.id))).ino).toBe(kept.ino);expect(f.receive).toHaveBeenCalledOnce();await expect(uploads.pin(actor,source(f.row))).resolves.toMatchObject({uploadId:f.row.id});
 });
 it('lets an explicit cancellation win while a committed acknowledgement is held, with no late READY result',async()=>{
  const f=await begin(),entered=barrier(),held=barrier();releases.add(held.release);loseAcknowledgement('commit',async()=>{entered.release();await held.promise;});
  const receiving=uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length);pending.push(receiving.catch(()=>undefined));const failed=expect(receiving).rejects.toBeInstanceOf(BadRequestException);
  await entered.promise;expect((await uploads.cancel(actor,f.row.id)).state).toBe('CANCELLED');held.release();await failed;
  expect((await uploads.lookup(actor,f.request.requestKey)).state).toBe('CANCELLED');await expect(fs.stat(uploads.files.filename(f.row.id))).rejects.toMatchObject({code:'ENOENT'});
  await expect(uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length)).rejects.toBeInstanceOf(ConflictException);expect(f.receive).toHaveBeenCalledOnce();
 });
 it('preserves a blob already retained by a build before the original READY acknowledgement is lost',async()=>{
  const f=await begin(),entered=barrier(),held=barrier();releases.add(held.release);const fault=loseAcknowledgement('commit',async()=>{entered.release();await held.promise;});
  const receiving=uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length);pending.push(receiving.catch(()=>undefined));const failed=expect(receiving).rejects.toMatchObject({status:400,message:fault.error.message});
  await entered.promise;const pin=await uploads.pin(actor,source(f.row));await uploads.repository.transaction(async client=>{await uploads.retain(client,actor.email,pin);await client.query("INSERT INTO tool_build_jobs(id,actor,request_key,request_hash,config,state,message) VALUES($1,$2,$3,$4,$5,'SUCCEEDED','Owned retained source fixture')",[randomUUID(),actor.email,randomUUID(),'b'.repeat(64),JSON.stringify({source:pin})]);});
  held.release();await failed;await expect(uploads.assertRetained(actor.email,pin)).resolves.toBeUndefined();expect(await fs.readFile(uploads.files.filename(f.row.id))).toEqual(f.bytes);
  await expect(uploads.cancel(actor,f.row.id)).rejects.toBeInstanceOf(ConflictException);expect(f.receive).toHaveBeenCalledOnce();
 });
 it('still removes fully received bytes when archive inspection fails before any READY transaction',async()=>{
  const f=await begin(Buffer.from('not a supported native executable'));
  await expect(uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length)).rejects.toBeInstanceOf(BadRequestException);expect((await uploads.lookup(actor,f.request.requestKey)).state).toBe('WAITING');
  expect(await fs.readdir(root)).toEqual([]);expect(f.receive).toHaveBeenCalledOnce();
 });
 it('does not reclaim or rewrite a previous READY publication that commits after the initial row read',async()=>{
  const f=await begin();await uploads.files.receive(Readable.from([f.bytes]),f.row.id,randomUUID(),f.bytes.length,f.row.sha256,new AbortController().signal,async()=>undefined);
  const filename=uploads.files.filename(f.row.id),kept=await fs.stat(filename),metadata=await inspectUploadArchive(filename,{name:'program',format:'file'}),publishing=await pool.connect();
  await publishing.query('BEGIN');await publishing.query("UPDATE tool_source_uploads SET state='READY',metadata=$2,lease_token=NULL WHERE id=$1",[f.row.id,JSON.stringify(metadata)]);
  const receiving=uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length);pending.push(receiving.catch(()=>undefined));
  try{
   await expect.poll(async()=>(await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE tool_source_uploads SET state=%'")).rows[0].count,{timeout:2000,interval:10}).toBe(1);
   await publishing.query('COMMIT');expect(await receiving).toMatchObject({id:f.row.id,state:'READY'});expect((await fs.stat(filename)).ino).toBe(kept.ino);expect(f.receive).toHaveBeenCalledOnce();
  }finally{await publishing.query('ROLLBACK').catch(()=>undefined);publishing.release();}
 });
 it.each(['role','disabled','epoch-aba'] as const)('retains a concurrently committed blob but rejects stale %s authorization before returning READY',async revoked=>{
  const f=await begin();await uploads.files.receive(Readable.from([f.bytes]),f.row.id,randomUUID(),f.bytes.length,f.row.sha256,new AbortController().signal,async()=>undefined);
  const filename=uploads.files.filename(f.row.id),kept=await fs.stat(filename),metadata=await inspectUploadArchive(filename,{name:'program',format:'file'}),publishing=await pool.connect();
  await publishing.query('BEGIN');await publishing.query("UPDATE tool_source_uploads SET state='READY',metadata=$2,lease_token=NULL WHERE id=$1",[f.row.id,JSON.stringify(metadata)]);
  const receiving=uploads.content(actor,f.row.id,Readable.from([f.bytes]),f.bytes.length);pending.push(receiving.catch(()=>undefined));const outcome=receiving.then(value=>({value}),error=>({error}));
  try{
   await expect.poll(async()=>(await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE tool_source_uploads SET state=%'")).rows[0].count,{timeout:2000,interval:10}).toBe(1);
   if(revoked==='disabled')await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[actor.email]);
   else{await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor.email]);if(revoked==='epoch-aba')await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actor.email]);}
   await publishing.query('COMMIT');expect(await outcome).toMatchObject({error:{status:403}});expect((await pool.query('SELECT state FROM tool_source_uploads WHERE id=$1',[f.row.id])).rows[0].state).toBe('READY');
   expect((await fs.stat(filename)).ino).toBe(kept.ino);expect(await fs.readFile(filename)).toEqual(f.bytes);expect(f.receive).toHaveBeenCalledOnce();
  }finally{await publishing.query('ROLLBACK').catch(()=>undefined);publishing.release();}
 });
});
