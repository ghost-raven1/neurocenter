import 'reflect-metadata';
import {Controller,Get,Module,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {Pool} from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {AccessDb} from '../src/access/access-db';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {SourceUploadController} from '../src/source-upload/source-upload.controller';
import {SourceUploads,SourceUploadService} from '../src/source-upload/source-upload.service';
import {ownedAccessTestAdminUrl} from './access-write-postgres.fixture';
import {executable,intent} from './source-upload.fixture';

const connection=process.env.CATALOG_TEST_PG_URL,actor={email:'upload-owner@example.test',activeRole:'Главный админ'};
const token='owned-upload-bootstrap-fixture',route='/api/tool-builds/uploads';
class Metadata {read(){return {ok:true,name:'independent metadata'};}}
Controller('metadata')(Metadata);Get()(Metadata.prototype,'read',Object.getOwnPropertyDescriptor(Metadata.prototype,'read')!);

/** Real Nest lifecycle, authorization/schema SQL and owned files; no application database or storage is used. */
describe.skipIf(!connection)('Optional source-upload storage bootstrap',()=>{
 let admin:Pool,pool:Pool,database:string,url:string,root:string,storage:string,access:AccessDb,uploads:SourceUploadService,app:INestApplication|undefined;
 const headers=()=>({'content-type':'application/json','x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))});
 async function request(base:string,suffix:string,method='GET',body?:unknown){const response=await fetch(base+route+suffix,{method,headers:headers(),...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
 async function application(){
  access=new AccessDb();uploads=new SourceUploadService(access);
  Reflect.defineMetadata('design:paramtypes',[SourceUploadService],SourceUploadController);
  class Fixture{}Module({controllers:[Metadata,SourceUploadController],providers:[{provide:SourceUploadService,useValue:uploads}]})(Fixture);
  app=await NestFactory.create(Fixture,{logger:false,bodyParser:false});
  const express=(await import('express')).default;
  app.use((req:import('express').Request,res:import('express').Response,next:import('express').NextFunction)=>req.method==='PUT'?next():express.json()(req,res,next));
  return app;
 }
 beforeAll(async()=>{
  const parsed=ownedAccessTestAdminUrl(connection!);admin=new Pool({connectionString:parsed.href,max:1});database='nc_upload_bootstrap_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);parsed.pathname='/'+database;url=parsed.href;
  pool=new Pool({connectionString:url,max:4});await ensureCatalogSchema(pool);await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true)',[actor.email]);
 });
 beforeEach(async()=>{
  await pool.query('TRUNCATE tool_source_uploads');root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-upload-bootstrap-'));storage=path.join(root,'.source-uploads');
  vi.stubEnv('CATALOG_PG_URL',url);vi.stubEnv('RUNTIME_ARTIFACT_DIR',root);vi.stubEnv('SSO_DISABLE','false');vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);vi.stubEnv('CAPACITY_REQUIRED','false');
  const original=setTimeout;vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:Parameters<typeof setTimeout>[0],delay?:number,...args:unknown[])=>original(callback,[30000,60000].includes(delay??0)?20:delay,...args)) as typeof setTimeout);
 });
 afterEach(async()=>{await app?.close();app=undefined;await access?.onModuleDestroy();vi.restoreAllMocks();vi.unstubAllEnvs();if(root)await fs.rm(root,{recursive:true,force:true});});
 afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP DATABASE '+database);await admin.end();}});
 it('serves metadata and retained upload history with an invalid storage path, then recovers without restart or rewriting retained bytes',async()=>{
  const previous=new SourceUploads(pool,storage);await previous.setup();const bytes=executable(),oldIntent=intent(bytes),old=await previous.create(actor,oldIntent);await previous.content(actor,old.id,Readable.from([bytes]),bytes.length);
  const retained=storage+'-retained';await fs.rename(storage,retained);await fs.writeFile(storage,'owned non-directory fault');
  const starting=await application();await expect(starting.listen(0,'127.0.0.1')).resolves.toBeDefined();const base=await starting.getUrl();
  expect((await fetch(base+'/metadata')).status).toBe(200);expect((await request(base,'/'+old.id)).body).toMatchObject({id:old.id,state:'READY'});
  const next=intent(bytes);expect(await request(base,'','POST',next)).toMatchObject({status:503});
  expect((await pool.query('SELECT count(*)::int AS count FROM tool_source_uploads')).rows[0].count).toBe(1);
  expect(await fs.readFile(path.join(retained,old.id+'.source'))).toEqual(bytes);
  await fs.rm(storage);await fs.rename(retained,storage);
  await expect.poll(async()=>(await request(base,'','POST',next)).status,{timeout:2000,interval:10}).toBe(201);
  const created=await request(base,'','POST',next);expect(created.status).toBe(201);const id=created.body.id as string;
  const send=()=>fetch(base+route+'/'+id+'/content',{method:'PUT',headers:{...headers(),'content-type':'application/octet-stream'},body:bytes});
  expect((await send()).status).toBe(200);const before=await fs.stat(path.join(storage,id+'.source'));expect((await send()).status).toBe(200);const after=await fs.stat(path.join(storage,id+'.source'));
  expect(after.ino).toBe(before.ino);expect(after.mtimeMs).toBe(before.mtimeMs);expect(await fs.readFile(path.join(storage,old.id+'.source'))).toEqual(bytes);
  expect((await pool.query('SELECT count(*)::int AS count FROM tool_source_uploads WHERE request_key=$1',[next.requestKey])).rows[0].count).toBe(1);
 });
 it('keeps cancellation durable and discoverable while the storage directory cannot be opened',async()=>{
  const previous=new SourceUploads(pool,storage);await previous.setup();const created=await previous.create(actor,intent());await fs.rm(storage,{recursive:true});await fs.writeFile(storage,'owned non-directory fault');
  const starting=await application();await expect(starting.listen(0,'127.0.0.1')).resolves.toBeDefined();const base=await starting.getUrl();
  expect(await request(base,'/'+created.id,'DELETE')).toMatchObject({status:200,body:{state:'CANCELLED'}});
  expect(await request(base,'/requests/'+created.requestKey)).toMatchObject({status:200,body:{state:'CANCELLED'}});
  expect((await pool.query('SELECT cleaned_at FROM tool_source_uploads WHERE id=$1',[created.id])).rows[0].cleaned_at).toBeNull();
 });
 it('keeps mandatory access initialization fail-closed before listening',async()=>{
  const starting=await application();vi.spyOn(access,'ready').mockRejectedValue(new Error('owned access bootstrap unavailable'));
  await expect(starting.init()).rejects.toThrow('owned access bootstrap unavailable');
 });
 it('does not await optional cleanup to listen, and shutdown waits for its owned cleanup without rescheduling',async()=>{
  const starting=await application();let entered!:()=>void,release!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const cleanup=vi.spyOn(uploads,'cleanup').mockImplementation(async()=>{entered();await held;});const listening=starting.listen(0,'127.0.0.1');
  try{
   await active;expect(await Promise.race([listening.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))])).toBe(true);
   let closed=false;const closing=starting.close().then(()=>{closed=true;});await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);release();await closing;app=undefined;expect(cleanup).toHaveBeenCalledOnce();
   await new Promise(resolve=>setTimeout(resolve,60));expect(cleanup).toHaveBeenCalledOnce();
  }finally{release();await listening.catch(()=>undefined);}
 });
});
