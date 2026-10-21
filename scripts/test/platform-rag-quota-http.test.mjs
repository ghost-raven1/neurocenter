import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';

const adminUrl=process.env.MODEL_CHAT_TEST_ADMIN_URL;
test('Platform RAG quotas traverse Gateway, fresh main-admin authorization and actual durable RAG storage',{
 skip:!adminUrl?'Set an explicit disposable local MODEL_CHAT_TEST_ADMIN_URL.':false,timeout:180000,
},async t=>{
 const f=await startSkillPackagingFixture({adminUrl}),require=createRequire(new URL('../../services/rag-sync-service/package.json',import.meta.url));
 const {RagDb}=require('./dist/rag/rag-db.js'),{ProjectDatabases}=require('./dist/rag/project-databases.js');
 const {PlatformQuotaController}=require('./dist/rag/quota/platform-quota.controller.js'),{Module}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core');
 const url=new URL(adminUrl);url.pathname='/'+f.database;const db=new RagDb({url:url.href,scope:'base'});let app;
 t.after(async()=>{try{if(app)await app.close();await db.close();}finally{await f.close();}});
 await db.setup();
 class QuotaFixture{}Module({controllers:[PlatformQuotaController],providers:[{provide:ProjectDatabases,useValue:{platformQuota:(...args)=>db.platformQuota(...args)}}]})(QuotaFixture);
 app=await NestFactory.create(QuotaFixture,{logger:false,abortOnError:false});
 app.use((req,res,next)=>{if(req.headers['x-neurocenter-internal']!==process.env.NEUROCENTER_INTERNAL_TOKEN)return res.status(403).json({message:'Internal token required.'});next();});
 await app.listen(0,'127.0.0.1');const base='http://127.0.0.1:'+app.getHttpServer().address().port;process.env.RAG_SERVICE_URL=base;
 const route='/api/maintenance/rag-quota-policy';
 await t.test('non-admin and direct internal requests cannot inspect or change the platform policy',async()=>{
  await f.request('developer',route,{status:403});await f.request('developer',route,{method:'PATCH',body:{defaultBytes:1,maximumBytes:2,expectedRevision:0},status:403});
  assert.equal((await fetch(base+'/internal/platform-rag-quota')).status,403);
 });
 let saved;
 await t.test('admin can exceed the old 16 GiB cap, restart preserves the setting and existing project budgets',async()=>{
  const before=await f.request('main',route),oldBudget=await db.quota(f.projectId);
  saved=await f.request('main',route,{method:'PATCH',body:{defaultBytes:2*1024**3,maximumBytes:64*1024**3,expectedRevision:before.revision}});
  assert.equal(saved.maximumBytes,64*1024**3);assert.equal(saved.updatedBy,f.actors.main.email);
  const second=new RagDb({url:url.href,scope:'base'});try{await second.setup();assert.deepEqual(await second.platformQuota(),saved);}finally{await second.close();}
  await db.configureQuota(saved);assert.equal((await db.quota(f.projectId)).limitBytes,oldBudget.limitBytes);assert.equal((await db.quota('new-owned-project')).limitBytes,saved.defaultBytes);
 });
 await t.test('CAS, malformed values and response replay cannot reset another admin update',async()=>{
  await f.request('main',route,{method:'PATCH',body:{defaultBytes:1,maximumBytes:128*1024**3,expectedRevision:saved.revision-1},status:409});
  for(const body of [{defaultBytes:0,maximumBytes:1,expectedRevision:saved.revision},{defaultBytes:2,maximumBytes:1,expectedRevision:saved.revision},
   {defaultBytes:1,maximumBytes:2,expectedRevision:saved.revision,actor:'forged'}])await f.request('main',route,{method:'PATCH',body,status:400});
  assert.deepEqual(await f.request('main',route),saved);
  assert.deepEqual(await f.request('main',route,{method:'PATCH',body:{defaultBytes:saved.defaultBytes,maximumBytes:saved.maximumBytes,expectedRevision:saved.revision-1}}),saved);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM rag_platform_quota_events')).rows[0].n,1);
 });
});
