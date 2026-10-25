import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import {Pool,type PoolClient} from 'pg';
import type {Request} from 'express';
import type {ModuleRef} from '@nestjs/core';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {migrateCatalog} from '../src/database/migrations';
import {assertCurrentCatalogSchema} from '../src/database/current-schema-verification';
import {AgentToolsRepository} from '../src/agent-tools/agent-tools.repository';
import {AgentToolsService} from '../src/agent-tools/agent-tools.service';
import type {AgentToolOwner,AgentToolGrant} from '../src/agent-tools/agent-tools.types';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import type {ModelsService} from '../src/models/models.service';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {IModel} from '../src/models/model.types';
import {ChatSearchService} from '../src/chat-search/chat-search.service';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';

const connection=process.env.AGENT_TOOL_TEST_ADMIN_URL,email='ordinary-agent@fixture.test',role='Разработчик';
const req={headers:{}} as Request,grant:AgentToolGrant={protocol:'json-actions-v1',rag:true};
const fixtureModel=():IModel=>({id:'model-tools-'+randomUUID(),name:'Fixture '+randomUUID(),description:'No provider calls',capability:'chat',runtime:'ollama',model:'fixture-only',
 manifestSha256:'a'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'2026-10-25',updatedAt:'2026-10-25'});
describe.skipIf(!connection).sequential('Agent tools on explicitly owned PostgreSQL16',()=>{
 let admin:Pool,pool:Pool,database:string,repository:AgentToolsRepository;const application='nc-agent-tools-'+randomUUID(),instances=new Set<AgentToolsService>(),extraPools=new Set<Pool>();
 beforeAll(async()=>{
  const disk=await statfs(process.cwd());if(disk.bavail*disk.bsize<4*1024**3)throw Error('Owned PostgreSQL fixture requires4GiB free.');
  const url=ownedTestPostgresAdmin(connection!);admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000});
  expect(Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)/10000)).toBe(16);
  database='nc_agent_tools_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;
  pool=new Pool({connectionString:url.href,max:8,statement_timeout:15000,application_name:application});await migrateCatalog(pool,CATALOG_MIGRATIONS);await assertCurrentCatalogSchema(pool);repository=new AgentToolsRepository(pool);
 },60000);
 afterEach(async()=>{for(const tools of instances)await tools.onModuleDestroy();instances.clear();for(const extra of extraPools)await extra.end();extraPools.clear();vi.unstubAllGlobals();});
 afterAll(async()=>{await pool?.end();if(admin){try{if(database)await admin.query('DROP DATABASE '+database);}finally{await admin.end();}}});
 async function source(kind:'model-chat'|'project-chat'='model-chat',group=false,selected:AgentToolGrant=grant){
  const model=fixtureModel(),pin=projectEmbeddingPin(model),project='prj-tools-'+randomUUID(),origin=randomUUID(),turn=randomUUID(),recipient=kind==='model-chat'&&!group?turn:randomUUID(),generation=randomUUID();
  await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)',[project]);
  await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)',[model.id,model.name,JSON.stringify(model)]);
  const snapshot={agentId:'agent-fixture',modelId:model.id,modelPin:pin,name:'Read only planner',slug:'nc-planner',definition:{description:'Readonly',prompt:'Read only',mode:'primary',permission:{edit:'deny',bash:'deny'}}};
  if(kind==='model-chat'){
   await pool.query('INSERT INTO model_chat_conversations(id,owner_email,project_id,model_id,model_pin,title,mode,agent_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[origin,email,project,model.id,pin,'Fixture',group?'group':'model',group?['agent-fixture']:[]]);
   await pool.query(`INSERT INTO model_chat_turns(id,conversation_id,request_id,request_ids,request_hash,prompt,attachment_ids,input_text,status,lease_until,target_agent_ids,agent_tools_request)
    VALUES($1,$2,$3,ARRAY[$3::uuid],$4,'Question','{}','Question','pending',now()+interval '10 minutes',$5,$6::jsonb)`,[turn,origin,generation,'b'.repeat(64),group?['agent-fixture']:[],JSON.stringify(selected)]);
   if(group)await pool.query("INSERT INTO model_chat_agent_responses(id,conversation_id,turn_id,agent_id,snapshot,request_id,status) VALUES($1,$2,$3,'agent-fixture',$4::jsonb,$5,'pending')",[recipient,origin,turn,JSON.stringify(snapshot),generation]);
  }else{
   await pool.query("INSERT INTO project_chat_rooms(project_id,id,title,visibility,creator_email,agent_ids,model_id,model_pin,create_request_key,create_request_hash) VALUES($1,$2,'Fixture','PUBLIC',$3,ARRAY['agent-fixture'],$4,$5,$2,$6)",[project,origin,email,model.id,pin,'b'.repeat(64)]);
   await pool.query(`INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,target_agent_ids,generation,lease_until,agent_tools_request)
    VALUES($1,$2,$3,'user','Question',$4,'Fixture',$5,'running',$6,$7,ARRAY['agent-fixture'],$8,now()+interval '10 minutes',$9::jsonb)`,[turn,project,origin,email,role,randomUUID(),'b'.repeat(64),generation,JSON.stringify(selected)]);
   await pool.query("INSERT INTO project_chat_messages(id,project_id,room_id,kind,source_message_id,status,snapshot,generation,lease_until) VALUES($1,$2,$3,'agent',$4,'running',$5::jsonb,$6,now()+interval '10 minutes')",[recipient,project,origin,turn,JSON.stringify(snapshot),generation]);
  }
  const owner:AgentToolOwner={kind,originId:origin,turnId:turn,recipientId:recipient,generation,ownerEmail:email,actorRole:role,projectId:project,agentId:kind==='project-chat'||group?'agent-fixture':null,modelId:model.id,modelPin:pin,grant:selected};
  return {owner,model};
 }
 const reserve=(owner:AgentToolOwner)=>repository.reserve(owner,1,'planner',{messageDigest:'fixture'},Date.now()+90000,async()=>{});
 it('has the full0..42 ledger and fails readiness after losing the one-send guard',async()=>{
  expect((await pool.query('SELECT version FROM catalog_schema_migrations ORDER BY version')).rows.map(row=>row.version)).toEqual(CATALOG_MIGRATIONS.map(row=>row.version));
  await pool.query('BEGIN');try{await pool.query('ALTER TABLE agent_tool_steps DISABLE TRIGGER agent_tool_step_guard');await expect(assertCurrentCatalogSchema(pool)).rejects.toThrow();}finally{await pool.query('ROLLBACK');}
  await assertCurrentCatalogSchema(pool);
 });
 it.each([['model-chat',false],['model-chat',true],['project-chat',false]] as const)('binds %s group=%s to its actual accepted recipient and grant',async(kind,group)=>{
  const {owner}=await source(kind,group);const row=await reserve(owner);expect(row.state).toBe('queued');
  await expect(repository.reserve({...owner,recipientId:randomUUID()},2,'planner',{},Date.now()+90000,async()=>{})).rejects.toThrow('owner or accepted grant');
  const table=kind==='model-chat'?'model_chat_turns':'project_chat_messages';await expect(pool.query(`UPDATE ${table} SET agent_tools_request=$2::jsonb WHERE id=$1`,[owner.turnId,JSON.stringify({...grant,systemRoles:true})])).rejects.toThrow('grant is immutable');
  await expect(pool.query('UPDATE agent_tool_steps SET model_pin=$2 WHERE id=$1',[row.id,'c'.repeat(64)])).rejects.toThrow('identity is immutable');
 });
 it('allows one concurrent dispatch and retains an unknown receipt without another dispatch',async()=>{
  const {owner}=await source(),row=await reserve(owner),effects=vi.fn();
  const results=await Promise.allSettled([1,2].map(async()=>{await repository.dispatch(row.id,async()=>{});effects();}));
  expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(effects).toHaveBeenCalledOnce();
  await repository.interrupted(row.id,'ACK lost');await expect(repository.dispatch(row.id,async()=>{})).rejects.toThrow('Автоматического повтора');
  expect((await repository.get(email,row.id)).state).toBe('unknown');await expect(repository.complete(row.id,{late:'output'},async()=>{})).rejects.toThrow('Поздний');
  expect((await repository.get(email,row.id)).output).toBeNull();
 });
 it('uses one PostgreSQL timestamp even when the caller clock is ahead',async()=>{
  const {owner}=await source(),row=await repository.reserve(owner,1,'planner',{},Date.now()+125000,async()=>{});
  const measured=(await pool.query('SELECT extract(epoch FROM deadline_at-created_at)*1000 AS lifetime FROM agent_tool_steps WHERE id=$1',[row.id])).rows[0];
  expect(Number(measured.lifetime)).toBeGreaterThan(0);expect(Number(measured.lifetime)).toBeLessThanOrEqual(120000);
 });
 it('checks authority after waiting for the dispatch lock',async()=>{
  const {owner}=await source(),row=await reserve(owner);let locker:PoolClient|undefined,holding=false,permitted=true,pending:Promise<unknown>|undefined;
  try{
   locker=await pool.connect();await locker.query('BEGIN');holding=true;await locker.query('SELECT id FROM agent_tool_steps WHERE id=$1 FOR UPDATE',[row.id]);
   pending=repository.dispatch(row.id,async()=>{if(!permitted)throw Error('Role revoked while waiting');}).then(value=>({value}),error=>({error}));
   const until=Date.now()+2000;let blocked=false;while(Date.now()<until){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[application])).rowCount){blocked=true;break;}await new Promise(done=>setTimeout(done,10));}
   expect(blocked).toBe(true);permitted=false;await locker.query('COMMIT');holding=false;expect(await pending).toHaveProperty('error.message','Role revoked while waiting');expect((await repository.get(email,row.id)).state).toBe('queued');
  }finally{if(holding)await locker?.query('ROLLBACK');await pending;locker?.release();}
 });
 it('gives a developer actual read-only system evidence without calling privileged role admission',async()=>{
  const {owner,model}=await source('project-chat',false,{protocol:'json-actions-v1',rag:false,systemRoles:true});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())))));
  const actor={email,activeRole:role,claims:{email,userRoles:[role],projects:[{projectId:owner.projectId,role}],pluginIds:[],skillPaths:[]}};
  const authorityPool=new Pool({connectionString:String(pool.options.connectionString),max:1,connectionTimeoutMillis:500});extraPools.add(authorityPool);
  const models={pool:authorityPool,ready:async()=>{},actor:async()=>actor,resolveProject:async()=>({id:owner.projectId,name:'Fixture',state:'ACTIVE',headRevision:1}),getUsable:async()=>model} as unknown as ModelsService;
  const infer=vi.fn().mockResolvedValueOnce({message:{role:'assistant',content:JSON.stringify({action:'request_system_role',roleId:'agent-ai-admin',instruction:'Почему нет опыта?'})},done_reason:'stop'})
   .mockResolvedValueOnce({message:{role:'assistant',content:'{"action":"finish"}'},done_reason:'stop'});
  const modules={get:vi.fn(()=>({list:async()=>({items:[{slug:'getting-started',title:'Начало',summary:'Проект'}]}),read:async()=>({slug:'getting-started',title:'Начало',revision:'fixture',content:'Подключите проект и проверьте источники.'})}))} as unknown as ModuleRef;
  const tools=new AgentToolsService(models,{infer} as unknown as ModelRuntime,modules),none={status:'none' as const,sources:[]};instances.add(tools);
  const result=await tools.run(req,{owner,messages:[{role:'user',content:'Какой контекст доступен?'}],settings:{contextWindowTokens:32768,reservedOutputTokens:1024},signal:new AbortController().signal,assertCurrent:async()=>{await authorityPool.query('SELECT 1');}},
   {messages:[],evidence:none,requiredFeatures:[],assertCurrent:async()=>{},beforeInference:async()=>{},fit:messages=>({messages,evidence:none})},'Question');
  const saved=(await repository.list(email,owner.projectId,owner.turnId)).find(row=>row.action==='request_system_role')!;
  expect(saved.state).toBe('succeeded');expect(saved.output).toMatchObject({mode:'read-only-assistance',roleId:'agent-ai-admin',task:{status:'needs_permission'}});
  expect(JSON.stringify(result.messages)).toContain('project-learning');expect(JSON.stringify(result.messages)).toContain('help:getting-started:fixture');
  expect(infer).toHaveBeenCalledTimes(2);expect(modules.get).toHaveBeenCalledTimes(1);expect((await pool.query('SELECT count(*)::int AS count FROM system_role_runs WHERE project_id=$1',[owner.projectId])).rows[0].count).toBe(0);
 });
 it('stores only public-search references and hydrates history through current visibility',async()=>{
  const {owner,model}=await source('project-chat',false,{protocol:'json-actions-v1',rag:false,publicChats:{modelId:'model-embed',expectedModelPin:'d'.repeat(64),consent:true}});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())))));
  const embedding={...model,id:'model-embed',capability:'embedding' as const,dimension:3},selectedPin=projectEmbeddingPin(embedding);owner.grant.publicChats!.expectedModelPin=selectedPin;
  // A new fixture holds the exact accepted grant; it is never rewritten after dispatch.
  const current=await source('project-chat',false,owner.grant),actualOwner=current.owner;let visible=true;
  const actor={email,activeRole:role,claims:{email,userRoles:[role],projects:[{projectId:actualOwner.projectId,role}],pluginIds:[],skillPaths:[]}};
  const models={pool,ready:async()=>{},actor:async()=>actor,resolveProject:async()=>({id:actualOwner.projectId}),getUsable:async(id:string)=>id==='model-embed'?embedding:current.model} as unknown as ModelsService;
  const jobId=randomUUID(),search={create:vi.fn(async()=>({id:jobId,state:'SUCCEEDED'})),get:vi.fn(async()=>({id:jobId,state:'SUCCEEDED',results:visible?[{messageId:randomUUID(),content:'public text only while visible'}]:[]})),cancel:vi.fn()};
  const hit={messageId:randomUUID(),content:'public text only while visible'};search.get.mockImplementation(async()=>({id:jobId,state:'SUCCEEDED',results:visible?[hit]:[]}));
  const infer=vi.fn().mockResolvedValueOnce({message:{role:'assistant',content:'{"action":"public_chat_search","query":"context"}'},done_reason:'stop'}).mockResolvedValueOnce({message:{role:'assistant',content:'{"action":"finish"}'},done_reason:'stop'});
  const modules={get:(token:unknown)=>{if(token!==ChatSearchService)throw Error('Unexpected privileged service');return search;}} as unknown as ModuleRef;
  const tools=new AgentToolsService(models,{infer} as unknown as ModelRuntime,modules),none={status:'none' as const,sources:[]};instances.add(tools);
  const result=await tools.run(req,{owner:actualOwner,messages:[{role:'user',content:'Find public context'}],settings:{contextWindowTokens:32768,reservedOutputTokens:1024},signal:new AbortController().signal,assertCurrent:async()=>{await pool.query('SELECT 1');}},
   {messages:[],evidence:none,requiredFeatures:[],assertCurrent:async()=>{},beforeInference:async()=>{},fit:messages=>({messages,evidence:none})},'Question');
  const row=(await repository.list(email,actualOwner.projectId,actualOwner.turnId)).find(row=>row.action==='public_chat_search')!;expect(row.output).toEqual({status:'ready',jobId});expect(JSON.stringify(result.messages)).toContain(hit.content);
  visible=false;await expect(result.assertCurrent()).rejects.toThrow('закрыт');const history=await tools.detail(req,row.id);expect(history.step.output).toMatchObject({results:[]});expect(JSON.stringify(history)).not.toContain(hit.content);expect(search.create).toHaveBeenCalledOnce();
 });
});
