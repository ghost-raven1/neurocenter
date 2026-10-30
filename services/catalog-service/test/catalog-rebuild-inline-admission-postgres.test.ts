import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import type {Request} from 'express';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {AccessDb} from '../src/access/access-db';
import {AssetSourcesController} from '../src/asset-sources/asset-sources.controller';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {AssetSourceSnapshots} from '../src/asset-sources/source-snapshots';
import {AssetImportRepository} from '../src/asset-sources/import-repository';
import {readBundledCatalog} from '../../shared/bundled-catalog.cjs';

const {FEATURE_FLAG_KEYS,evaluateFeatureFlags}=createRequire(import.meta.url)('../../shared/feature-flags.cjs');
const connection=process.env.INLINE_ADMISSION_TEST_ADMIN_PG_URL;
const email='inline-admission-owner@example.test',keeper='inline-admission-keeper@example.test';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
type Gate={entered:ReturnType<typeof deferred>;resume:ReturnType<typeof deferred>};

describe.skipIf(!connection).sequential('Inline source admission rechecks current Main rights before durable queue effects',()=>{
 let admin:Pool,pool:Pool,controller:AssetSourcesController,source:AssetSourcesService,commit:string,assetId:string,database:string,created=false,gate:Gate|undefined;
 const kick=vi.fn(),token=randomUUID();let externalCalls=0,sourcesEnabled=true;
 const receipt={database:'',systemIdentifier:'',poolMaximum:2,sessionsBeforeDrop:-1,dropped:false,externalCalls:0,observed:[] as unknown[]};
 const req={headers:{'x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole:'Главный админ'}))}} as unknown as Request;
 beforeAll(async()=>{
  const url=callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:connection}),expected=process.env.INLINE_ADMISSION_TEST_SYSTEM_IDENTIFIER;
  if(!expected||!/^\d+$/.test(expected))throw Error('Explicit owned PostgreSQL system identifier is required.');
  admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
  receipt.systemIdentifier=(await admin.query<{id:string}>('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  expect(receipt.systemIdentifier).toBe(expected);
  database='nc_inline_admit_'+randomUUID().replaceAll('-','');receipt.database=database;
  await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
  pool=new Pool({connectionString:url.href,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
  await ensureCatalogSchema(pool);
  await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true),($2,true,true)',[email,keeper]);
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);vi.stubEnv('FEATURE_FLAGS_SERVICE_URL','http://inline-admission-qa.invalid');
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
   const target=typeof input==='string'?input:input instanceof URL?input.href:input.url;
   if(target!=='http://inline-admission-qa.invalid/internal/feature-flags/evaluated'){externalCalls++;throw Error('Unexpected external request in inline admission fixture.');}
   const waiting=gate;if(waiting){gate=undefined;waiting.entered.resolve();await waiting.resume.promise;}
   return Response.json(evaluateFeatureFlags(Object.fromEntries(FEATURE_FLAG_KEYS.map((key:string)=>[key,key!=='asset_sources'||sourcesEnabled]))));
  }));
  const bundle=await readBundledCatalog(),sources=new AssetSourceSnapshots(pool,async()=>bundle.pin);
  const snapshot=await sources.refresh();commit=snapshot.pin.commit;
  const selected=snapshot.assets.find(row=>row.current&&['agent','skill'].includes(row.asset.kind));
  if(!selected)throw Error('Current bundled inline metadata is required.');assetId=selected.asset.id;
  const access=Object.assign(Object.create(AccessDb.prototype),{pool}) as AccessDb;
  source=Object.assign(Object.create(AssetSourcesService.prototype),{pool,access,sources,jobs:new AssetImportRepository(pool),worker:{kick}}) as AssetSourcesService;
  controller=new AssetSourcesController(source);
 },30000);
 afterAll(async()=>{
  gate?.resume.resolve();
  try{
   await pool?.end();
   if(admin&&created){
    receipt.sessionsBeforeDrop=Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].count);
    await admin.query('DROP DATABASE '+database);receipt.dropped=!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount;
   }
  }finally{
   await admin?.end();receipt.externalCalls=externalCalls;
   if(process.env.INLINE_ADMISSION_TEST_RECEIPT_FILE)await writeFile(process.env.INLINE_ADMISSION_TEST_RECEIPT_FILE,JSON.stringify(receipt,null,2)+'\n');
   vi.unstubAllGlobals();vi.unstubAllEnvs();
  }
 },15000);
 const input=()=>({requestKey:randomUUID(),commit,ids:[assetId]});
 async function durableState(){
  return {jobs:(await pool.query('SELECT * FROM asset_source_jobs ORDER BY id')).rows,audit:(await pool.query("SELECT * FROM security_events WHERE action='asset.import.request' ORDER BY event_id")).rows,
   native:(await pool.query('SELECT * FROM ai_plugins ORDER BY id')).rows,receipts:(await pool.query('SELECT * FROM asset_source_receipts ORDER BY repository,external_id')).rows};
 }

 it('Positive control accepts and replays exactly one real inline request while the actor remains Main',async()=>{
  expect(await source.actor(req)).toBe(email);const body=input(),before=await durableState();kick.mockClear();
  const accepted=await controller.start(req,body),replayed=await controller.start(req,body),after=await durableState();
  expect(accepted.state).toBe('QUEUED');expect(replayed.id).toBe(accepted.id);
  expect(after.jobs).toHaveLength(before.jobs.length+1);expect(after.audit).toHaveLength(before.audit.length+1);
  expect(after.native).toEqual(before.native);expect(after.receipts).toEqual(before.receipts);expect(externalCalls).toBe(0);
  receipt.observed.push({case:'authorized-positive-control',accepted:true,state:accepted.state,replaySameId:replayed.id===accepted.id,newJobs:after.jobs.length-before.jobs.length});
 });

 it.each(['main-role','account-enabled'] as const)('Rejects %s revoked after the initial Main check and before the flag response; no queue or audit is written',async revoked=>{
  await pool.query('UPDATE platform_users SET is_main_admin=true,enabled=true WHERE email=$1',[email]);
  const writer=await pool.connect(),writerPid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const waiting={entered:deferred(),resume:deferred()};gate=waiting;
  const before=await durableState(),body=input();kick.mockClear();
  const outcome=controller.start(req,body).then(job=>({accepted:true,status:201,id:job.id,state:job.state}),error=>({accepted:false,status:typeof error.getStatus==='function'?error.getStatus():0,message:String(error.message)}));
  let observed:Awaited<typeof outcome>;
  try{
   await Promise.race([waiting.entered.promise,outcome.then(()=>{throw Error('Initial actor check did not reach the controlled feature boundary.');})]);
   // writer holds one real session; actor reads used the other pool session before flags were held.
   expect(pool.totalCount).toBe(2);
   await writer.query(revoked==='main-role'?'UPDATE platform_users SET is_main_admin=false WHERE email=$1':'UPDATE platform_users SET enabled=false WHERE email=$1',[email]);
   waiting.resume.resolve();observed=await outcome;
  }finally{waiting.resume.resolve();writer.release();}
  const after=await durableState();
  receipt.observed.push({case:revoked,initialMainPassed:true,flagBarrierReached:true,writerPid,poolSessions:pool.totalCount,outcome:observed,newJobs:after.jobs.length-before.jobs.length,newImportAudits:after.audit.length-before.audit.length,kickCalls:kick.mock.calls.length,nativePreserved:JSON.stringify(before.native)===JSON.stringify(after.native),receiptPreserved:JSON.stringify(before.receipts)===JSON.stringify(after.receipts)});
  expect.soft(observed).toMatchObject({accepted:false,status:403});
  expect.soft(after.jobs).toEqual(before.jobs);expect.soft(after.audit).toEqual(before.audit);expect.soft(kick).not.toHaveBeenCalled();
  expect(after.native).toEqual(before.native);expect(after.receipts).toEqual(before.receipts);expect(externalCalls).toBe(0);
 });

 it('Rejects asset_sources disabled after the initial flag check while the real source snapshot read is held',async()=>{
  await pool.query('UPDATE platform_users SET is_main_admin=true,enabled=true WHERE email=$1',[email]);sourcesEnabled=true;
  const entered=deferred(),resume=deferred(),read=source.sources.get.bind(source.sources);
  const snapshot=vi.spyOn(source.sources,'get').mockImplementationOnce(async(...args)=>{const value=await read(...args);entered.resolve();await resume.promise;return value;});
  const before=await durableState(),body=input();kick.mockClear();
  const outcome=controller.start(req,body).then(job=>({accepted:true,status:201,id:job.id,state:job.state}),error=>({accepted:false,status:typeof error.getStatus==='function'?error.getStatus():0,message:String(error.message)}));
  let observed:Awaited<typeof outcome>;
  try{
   await Promise.race([entered.promise,outcome.then(()=>{throw Error('Initial flags did not admit the actual source-snapshot boundary.');})]);
   sourcesEnabled=false;resume.resolve();observed=await outcome;
  }finally{resume.resolve();snapshot.mockRestore();sourcesEnabled=true;}
  const after=await durableState();
  receipt.observed.push({case:'asset-sources-disabled-after-source-read',initialMainPassed:true,initialFlagPassed:true,realSnapshotRead:true,outcome:observed,newJobs:after.jobs.length-before.jobs.length,newImportAudits:after.audit.length-before.audit.length,kickCalls:kick.mock.calls.length,nativePreserved:JSON.stringify(before.native)===JSON.stringify(after.native),receiptPreserved:JSON.stringify(before.receipts)===JSON.stringify(after.receipts)});
  expect.soft(observed.accepted).toBe(false);expect.soft([403,409]).toContain(observed.status);
  expect.soft(after.jobs).toEqual(before.jobs);expect.soft(after.audit).toEqual(before.audit);expect.soft(kick).not.toHaveBeenCalled();
  expect(after.native).toEqual(before.native);expect(after.receipts).toEqual(before.receipts);expect(externalCalls).toBe(0);
 });

 it('Rechecks asset_sources after an actual queue-advisory SQL wait before INSERT',async()=>{
  await pool.query('UPDATE platform_users SET is_main_admin=true,enabled=true WHERE email=$1',[email]);sourcesEnabled=true;
  const before=await durableState(),body=input(),writer=await pool.connect();kick.mockClear();
  const writerPid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await writer.query('BEGIN');await writer.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-import-queue',0))");
  const outcome=controller.start(req,body).then(job=>({accepted:true,status:201,id:job.id,state:job.state}),error=>({accepted:false,status:typeof error.getStatus==='function'?error.getStatus():0,message:String(error.message)}));
  let observed:Awaited<typeof outcome>,waiter:{pid:number;blocked_by:number[]}|undefined;
  try{
   const deadline=Date.now()+3000;
   while(Date.now()<deadline){
    waiter=(await admin.query<{pid:number;blocked_by:number[]}>("SELECT pid,pg_blocking_pids(pid) AS blocked_by FROM pg_stat_activity WHERE datname=$1 AND pid<>$2 AND wait_event_type='Lock' AND lower(wait_event)='advisory' AND $2=ANY(pg_blocking_pids(pid))",[database,writerPid])).rows[0];
    if(waiter)break;
   }
   expect(waiter,'Actual request must be observed waiting on the exact own advisory-lock holder').toBeTruthy();
   sourcesEnabled=false;await writer.query('COMMIT');observed=await outcome;
  }finally{await writer.query('ROLLBACK');writer.release();await outcome;sourcesEnabled=true;}
  const after=await durableState();
  receipt.observed.push({case:'asset-sources-disabled-during-actual-queue-lock',initialMainPassed:true,initialFlagPassed:true,actualQueueAdvisoryWait:waiter,writerPid,outcome:observed,newJobs:after.jobs.length-before.jobs.length,newImportAudits:after.audit.length-before.audit.length,kickCalls:kick.mock.calls.length,nativePreserved:JSON.stringify(before.native)===JSON.stringify(after.native),receiptPreserved:JSON.stringify(before.receipts)===JSON.stringify(after.receipts)});
  expect.soft(observed.accepted).toBe(false);expect.soft([403,409]).toContain(observed.status);
  expect.soft(after.jobs).toEqual(before.jobs);expect.soft(after.audit).toEqual(before.audit);expect.soft(kick).not.toHaveBeenCalled();
  expect(after.native).toEqual(before.native);expect(after.receipts).toEqual(before.receipts);expect(externalCalls).toBe(0);
 });
});
