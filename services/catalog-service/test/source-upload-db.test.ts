import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {SourceUploads} from '../src/source-upload/source-upload.service';
import {type PinnedUploadSource} from '../src/source-upload/source-upload.model';
const connectionString=process.env.CATALOG_TEST_PG_URL;
const actor={email:'admin@example.test',activeRole:'Главный админ'},other={email:'other@example.test',activeRole:'Главный админ'};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function executable(){const bytes=Buffer.alloc(64);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x100000c,4);bytes.writeUInt32LE(2,12);bytes.writeUInt32LE(1,16);bytes.writeUInt32LE(24,20);bytes.writeUInt32LE(0x32,32);bytes.writeUInt32LE(24,36);bytes.writeUInt32LE(1,40);return bytes;}
describe.skipIf(!connectionString)('Durable source upload: real PG + filesystem',()=>{
 let admin:Pool,pool:Pool,root:string,schema:string,uploads:SourceUploads;
 beforeEach(async()=>{
  schema='source_upload_test_'+randomUUID().replaceAll('-','');admin=new Pool({connectionString,max:1});await admin.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString,options:'-c search_path='+schema,max:8});root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-source-upload-db-'));
  await pool.query(`CREATE TABLE platform_users(email text PRIMARY KEY,is_main_admin boolean,enabled boolean);INSERT INTO platform_users VALUES('admin@example.test',true,true),('other@example.test',true,true);CREATE TABLE tool_build_jobs(id uuid PRIMARY KEY,config jsonb);`);
  uploads=new SourceUploads(pool,root);await uploads.setup();
 });
 afterEach(async()=>{uploads?.stop();await pool?.end();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}if(root)await fs.rm(root,{recursive:true,force:true});});
 const intent=(bytes=executable())=>({requestKey:randomUUID(),name:'program',sha256:sha(bytes),bytes:bytes.length});
 async function ready(){const bytes=executable(),request=intent(bytes),upload=await uploads.create(actor,request);const result=await uploads.content(actor,upload.id,Readable.from([bytes]),bytes.length);return {request,upload:result,bytes};}
 it('Exact actor request is idempotent; changed bytes and another actor cannot adopt its handle',async()=>{
  const request=intent(),first=await uploads.create(actor,request);expect(await uploads.create(actor,request)).toEqual(first);
  await expect(uploads.create(actor,{...request,name:'different'})).rejects.toMatchObject({status:409});
  await expect(uploads.get(other,first.id)).rejects.toMatchObject({status:404});expect((await uploads.lookup(actor,request.requestKey)).id).toBe(first.id);
  expect(JSON.stringify(first)).not.toContain(root);
 });
 it('Durable byte stream is checked and inspected before READY, and exact retry uses the retained blob',async()=>{
  const {upload,bytes}=await ready();expect(upload.state).toBe('READY');expect(upload.metadata).toMatchObject({entrypoint:'program',supportedTargets:['darwin-arm64']});
  expect(await fs.readFile(uploads.files.filename(upload.id))).toEqual(bytes);expect((await fs.stat(uploads.files.filename(upload.id))).mode&0o777).toBe(0o400);
  const repeated=await uploads.content(actor,upload.id,Readable.from([Buffer.from('unnecessary retry bytes')]),undefined);expect(repeated).toEqual(upload);
  const source=await uploads.pin(actor,{type:'upload',uploadId:upload.id,sha256:upload.sha256,bytes:upload.bytes,entrypoint:'program'});expect(source.runtimeSource.adapter).toBe('native');
 });
 it('Declared-size mismatch and interrupted/wrong bytes leave no partial or falsely READY file',async()=>{
  const request=intent(),upload=await uploads.create(actor,request);
  await expect(uploads.content(actor,upload.id,Readable.from([executable()]),999)).rejects.toMatchObject({status:400});
  await expect(uploads.content(actor,upload.id,Readable.from([Buffer.from('truncated')]),request.bytes)).rejects.toMatchObject({status:409});
  expect((await uploads.get(actor,upload.id)).state).toBe('WAITING');expect(await fs.readdir(root)).toEqual([]);
  await expect(uploads.pin(actor,{type:'upload',uploadId:upload.id,sha256:request.sha256,bytes:request.bytes,entrypoint:'program'})).rejects.toMatchObject({status:409});
 });
 it('Retry after a crashed upload removes stale partials under the recovered session lease before retaining READY',async()=>{
  const request=intent(),upload=await uploads.create(actor,request),oldToken=randomUUID();
  await pool.query("UPDATE tool_source_uploads SET state='UPLOADING',lease_token=$2 WHERE id=$1",[upload.id,oldToken]);await fs.writeFile(uploads.files.partial(upload.id,oldToken),'left by a crashed process');
  const result=await uploads.content(actor,upload.id,Readable.from([executable()]),request.bytes);expect(result.state).toBe('READY');expect(await fs.readdir(root)).toEqual([upload.id+'.source']);
 });
 it('A corrupt archive or script cannot become a native source merely by using an archive name',async()=>{
  const bytes=Buffer.from('broken archive'),upload=await uploads.create(actor,{...intent(bytes),name:'program.zip'});
  await expect(uploads.content(actor,upload.id,Readable.from([bytes]),bytes.length)).rejects.toMatchObject({status:400});expect((await uploads.get(actor,upload.id)).state).toBe('WAITING');expect(await fs.readdir(root)).toEqual([]);
  await expect(uploads.create(actor,{...intent(),name:'install.sh'})).rejects.toMatchObject({status:400});
 });
 it('Cancel before content is permanent; a known UUID cannot silently start another upload',async()=>{
  const upload=await uploads.create(actor,intent());await uploads.cancel(actor,upload.id);expect((await uploads.get(actor,upload.id)).state).toBe('CANCELLED');
  await expect(uploads.content(actor,upload.id,Readable.from([executable()]),64)).rejects.toMatchObject({status:409});expect(await fs.readdir(root)).toEqual([]);
 });
 it('Concurrent streaming lease rejects second owner; cancellation removes partial bytes and prevents late READY',async()=>{
  const upload=await uploads.create(actor,intent()),input=new Readable({read(){}}),stream=uploads.content(actor,upload.id,input,64);
  for(let index=0;index<100&&(await uploads.get(actor,upload.id)).state!=='UPLOADING';index++)await new Promise(resolve=>setTimeout(resolve,5));
  await expect(uploads.content(actor,upload.id,Readable.from([executable()]),64)).rejects.toMatchObject({status:409});
  const failed=expect(stream).rejects.toMatchObject({status:400});await uploads.cancel(actor,upload.id);await failed;expect((await uploads.get(actor,upload.id)).state).toBe('CANCELLED');expect(await fs.readdir(root)).toEqual([]);
 });
 it('Access revoke/regrant ABA invalidates handle, while a no-op account update does not',async()=>{
  const {upload}=await ready();await pool.query("UPDATE platform_users SET is_main_admin=true WHERE email=$1",[actor.email]);
  expect((await uploads.pin(actor,{type:'upload',uploadId:upload.id,sha256:upload.sha256,bytes:upload.bytes,entrypoint:'program'})).entrypoint).toBe('program');
  await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor.email]);await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actor.email]);
  await expect(uploads.pin(actor,{type:'upload',uploadId:upload.id,sha256:upload.sha256,bytes:upload.bytes,entrypoint:'program'})).rejects.toMatchObject({status:403});
 });
 it('Retained build protects source against cancellation and expiration cleanup, including terminal history',async()=>{
  const {upload}=await ready(),source=await uploads.pin(actor,{type:'upload',uploadId:upload.id,sha256:upload.sha256,bytes:upload.bytes,entrypoint:'program'});
  await uploads.repository.transaction(async client=>{await uploads.retain(client,actor.email,source);await client.query('INSERT INTO tool_build_jobs VALUES($1,$2)',[randomUUID(),JSON.stringify({source})]);});
  await pool.query("UPDATE tool_source_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",[upload.id]);
  await uploads.cleanup();await expect(uploads.cancel(actor,upload.id)).rejects.toMatchObject({status:409});expect(await fs.readFile(uploads.files.filename(upload.id))).toHaveLength(64);
  await uploads.assertRetained(actor.email,source as PinnedUploadSource);
 });
 it('Expired unattached blob is cleaned; tampered retained bytes do not pass build admission',async()=>{
  const {upload}=await ready();await fs.chmod(uploads.files.filename(upload.id),0o600);await fs.writeFile(uploads.files.filename(upload.id),Buffer.alloc(64));
  await expect(uploads.pin(actor,{type:'upload',uploadId:upload.id,sha256:upload.sha256,bytes:upload.bytes,entrypoint:'program'})).rejects.toMatchObject({status:409});
  await pool.query("UPDATE tool_source_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",[upload.id]);await uploads.cleanup();expect(await fs.readdir(root)).toEqual([]);
 });
 it('Cancel tombstone before an unknown create response prevents a late source allocation',async()=>{
  const request=intent();await uploads.cancelRequest(actor,request.requestKey);
  await expect(uploads.create(actor,request)).rejects.toMatchObject({status:409});
  expect((await uploads.lookup(actor,request.requestKey)).state).toBe('CANCELLED');expect(await fs.readdir(root)).toEqual([]);
 });
 it('Revocation during streaming stops writes, and cleanup removes unreferenced stale permissions',async()=>{
  const request=intent(),upload=await uploads.create(actor,request),input=new Readable({read(){}}),stream=uploads.content(actor,upload.id,input,64);
  const failed=expect(stream).rejects.toMatchObject({status:400});
  for(let index=0;index<100&&(await uploads.get(actor,upload.id)).state!=='UPLOADING';index++)await new Promise(resolve=>setTimeout(resolve,5));
  await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor.email]);await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actor.email]);
  await failed;await uploads.cleanup();expect((await uploads.get(actor,upload.id)).state).toBe('CANCELLED');expect(await fs.readdir(root)).toEqual([]);
 });
 it('Concurrent streams reserve capacity for cancellation and status queries instead of exhausting the PG pool',async()=>{
  const rows=await Promise.all([0,1,2,3].map(()=>uploads.create(actor,intent()))),streams=rows.slice(0,3).map(row=>uploads.content(actor,row.id,new Readable({read(){}}),64));
  const failures=streams.map(stream=>expect(stream).rejects.toMatchObject({status:400}));
  for(let index=0;index<100&&(await uploads.get(actor,rows[0].id)).state!=='UPLOADING';index++)await new Promise(resolve=>setTimeout(resolve,5));
  await expect(uploads.content(actor,rows[3].id,Readable.from([executable()]),64)).rejects.toThrow('три файла');
  await Promise.all(rows.slice(0,3).map(row=>uploads.cancel(actor,row.id)));await Promise.all(failures);
 });
 it('A disconnected response after the complete durable body still settles READY for exact UUID recovery',async()=>{
  const metadata=(await ready()).upload.metadata!;let entered!:()=>void,release!:()=>void;
  const inspecting=new Promise<void>(resolve=>{entered=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
  uploads=new SourceUploads(pool,root,async()=>{entered();await finish;return metadata;});
  const bytes=executable(),request=intent(bytes),upload=await uploads.create(actor,request),connection=new AbortController();
  const receiving=uploads.content(actor,upload.id,Readable.from([bytes]),bytes.length,connection.signal);
  await inspecting;connection.abort();release();expect((await receiving).state).toBe('READY');
  expect((await uploads.lookup(actor,request.requestKey)).state).toBe('READY');expect(await fs.readFile(uploads.files.filename(upload.id))).toEqual(bytes);
 });
 it('Explicit cancellation during inspection removes durable bytes and cannot settle late READY',async()=>{
  const metadata=(await ready()).upload.metadata!;let entered!:()=>void,release!:()=>void;
  const inspecting=new Promise<void>(resolve=>{entered=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
  uploads=new SourceUploads(pool,root,async()=>{entered();await finish;return metadata;});
  const bytes=executable(),upload=await uploads.create(actor,intent(bytes)),receiving=uploads.content(actor,upload.id,Readable.from([bytes]),bytes.length);
  const failed=expect(receiving).rejects.toMatchObject({status:400});await inspecting;await uploads.cancel(actor,upload.id);release();await failed;
  expect((await uploads.get(actor,upload.id)).state).toBe('CANCELLED');await expect(fs.stat(uploads.files.filename(upload.id))).rejects.toMatchObject({code:'ENOENT'});
 });

});
