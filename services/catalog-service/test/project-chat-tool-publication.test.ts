import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import type {ModuleRef} from '@nestjs/core';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {AgentToolsService} from '../src/agent-tools/agent-tools.service';
import type {AgentToolStepRow} from '../src/agent-tools/agent-tools.types';
import {ChatSearchService} from '../src/chat-search/chat-search.service';
import {ProjectChatInferenceService} from '../src/project-chat-inference/project-chat-inference.service';
import {ProjectChatRunner} from '../src/project-chat/project-chat.runner';
import type {ProjectChatRepository} from '../src/project-chat/project-chat.repository';
import type {ProjectChatDb,ProjectChatJob,ProjectChatMessageRow,ProjectChatRoomRow} from '../src/project-chat/project-chat.types';
import type {ModelsService} from '../src/models/models.service';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {IModel} from '../src/models/model.types';
import {currentModelUsage} from '../src/model-usage/model-usage.context';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

/** Actual runner → inference → bounded tools; only durable storage/provider and public-search domain are controlled fixtures. */
describe.sequential('Project tools remain authorized at final owner publication',()=>{
 async function fixture(point:'none'|'before-owner'|'after-update',enabled=true,planner:'json'|'fenced'|'length'|'plain'='json'){
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','publication-fixture');vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())))));
  const project='prj-publication',roomId=randomUUID(),generation=randomUUID(),jobId=randomUUID(),sentinel='PUBLIC SOURCE MUST NOT SURVIVE REVOCATION';
  const actor={email:'developer@fixture.test',activeRole:'Разработчик'},req={headers:{}} as Request;
  const model={id:'model-chat',name:'Chat',capability:'chat',runtime:'ollama',model:'fixture',manifestSha256:'a'.repeat(64),dimension:null,revision:1} as IModel;
  const embedding={...model,id:'model-embedding',capability:'embedding',dimension:3} as IModel;
  const snapshot={agentId:'agent-planner',name:'Planner',slug:'nc-planner',definition:{description:'Plan',prompt:'Plan',mode:'primary',permission:{edit:'deny'}},modelId:model.id,modelPin:projectEmbeddingPin(model),sha256:'b'.repeat(64)};
  const grant={protocol:'json-actions-v1' as const,rag:false,publicChats:{modelId:embedding.id,expectedModelPin:projectEmbeddingPin(embedding),consent:true as const}};
  const source={id:randomUUID(),project_id:project,room_id:roomId,author_email:actor.email,author_role:actor.activeRole,kind:'user',content:'Find context',generation,status:'running',agent_tools_request:enabled?grant:null} as ProjectChatMessageRow;
  let response={id:randomUUID(),project_id:project,room_id:roomId,source_message_id:source.id,kind:'agent',content:'',status:'running',generation,snapshot} as ProjectChatMessageRow;
  const room={id:roomId,project_id:project,revision:1,visibility:'PUBLIC',agent_ids:[snapshot.agentId],model_id:model.id,model_pin:projectEmbeddingPin(model)} as ProjectChatRoomRow;
  const reached=deferred(),release=deferred();let visible=true,acked=false,barrier=false,insideOwner=false;
  const read=async(sql:string)=>({rows:sql.includes('FROM project_chat_rooms')?[room]:sql.includes('SELECT 1 FROM project_chat_messages')?[{one:1}]:sql.includes('FROM projects')?[{id:project,name:'Project',state:'ACTIVE'}]:sql.includes('FROM model_catalog')?[{id:embedding.id,name:embedding.name,descriptor:embedding,revision:1,created_at:'2026-10-26',updated_at:'2026-10-26'}]:[],rowCount:1});
  const db={query:vi.fn(async(sql:string,args?:unknown[])=>{
   if(sql.includes("SET status='done',content=$4")){response={...response,status:'done',content:String(args![3])};if(point==='after-update')visible=false;}
   if(sql.includes("SET status='failed',error=$4"))response={...response,status:'failed',error:String(args![3])};
   return read(sql);
  })} as unknown as ProjectChatDb;
  const modelPool={options:{max:1},query:vi.fn(async(sql:string)=>{if(insideOwner)throw Error('Final tool fence borrowed an already-owned pool');return read(sql);})};
  const models={pool:modelPool,actor:async()=>({...actor,claims:{email:actor.email,userRoles:[actor.activeRole],projects:[{projectId:project,role:actor.activeRole}],pluginIds:[],skillPaths:[]}}),resolveProject:async()=>({id:project}),getUsable:async(id:string)=>id===embedding.id?embedding:model} as unknown as ModelsService;
  const hit={messageId:randomUUID(),content:sentinel},search={create:vi.fn(async()=>({id:jobId,state:'SUCCEEDED'})),get:vi.fn(async(_req:unknown,_project:unknown,_id:unknown,existingDb?:ProjectChatDb)=>{if(insideOwner)expect(existingDb).toBe(db);return {id:jobId,state:'SUCCEEDED',results:visible?[hit]:[]};}),cancel:vi.fn()};
  let planned=0;const runtime={infer:vi.fn(async(_model:unknown,_endpoint:unknown,body:{messages:unknown})=>{
   await currentModelUsage().beforeInference?.();if(currentModelUsage().purpose==='research'){
    const content=JSON.stringify(planned++===0?{action:'public_chat_search',query:'context'}:{action:'finish'});
    return {message:{role:'assistant',content:planner==='plain'?'Привет! private-provider-text':planner==='json'?content:'```json\n'+content+'\n```'},done_reason:planner==='length'?'length':'stop'};
   }
   expect(JSON.stringify(body.messages)).toContain(enabled?sentinel:'Find context');acked=true;return {message:{role:'assistant',content:enabled?sentinel:'No tools answer'},done_reason:'stop'};
  })} as unknown as ModelRuntime;
  const tools=new AgentToolsService(models,runtime,{get:(token:unknown)=>{if(token!==ChatSearchService)throw Error('Unexpected service');return search;}} as unknown as ModuleRef),steps=new Map<string,AgentToolStepRow>();
  vi.spyOn(tools.repository,'reserve').mockImplementation(async(owner,sequence,action,input,_deadline,authorize)=>{await authorize(db);const row={id:randomUUID(),sequence,action,input,state:'queued',output:null,...{owner_email:owner.ownerEmail}} as AgentToolStepRow;steps.set(row.id,row);return row;});
  vi.spyOn(tools.repository,'dispatch').mockImplementation(async(id,authorize)=>{await authorize(db);const row=steps.get(id)!;row.state='dispatched';return row;});
  vi.spyOn(tools.repository,'complete').mockImplementation(async(id,output,authorize)=>{await authorize(db);const row=steps.get(id)!;row.state='succeeded';row.output=output;return row;});
  vi.spyOn(tools.repository,'reference').mockImplementation(async()=>{});vi.spyOn(tools.repository,'interrupted').mockImplementation(async()=>{});
  const inference=new ProjectChatInferenceService(models,runtime,tools);
  vi.spyOn(inference,'assert').mockImplementation(async()=>{});
  vi.spyOn(inference,'transport').mockResolvedValue('server');
  const internals=inference as unknown as {base:()=>Promise<IModel>;settings:()=>Promise<unknown>;groups:{learning:{prepare:()=>Promise<unknown>}}};
  vi.spyOn(internals,'base').mockResolvedValue(model);vi.spyOn(internals,'settings').mockResolvedValue({contextWindowTokens:32768,reservedOutputTokens:1024});
  internals.groups.learning.prepare=async()=>({messages:[],receipt:{status:'empty',projectId:project,agentId:snapshot.agentId,entries:[]},requiredFeatures:[],beforeInference:async()=>{},assertAuthorized:async()=>{}});
  const scoped=async(_project:unknown,_actor:unknown,_level:unknown,write:unknown,work:(db:ProjectChatDb,room:ProjectChatRoomRow)=>Promise<unknown>)=>{
   if(write&&acked&&!barrier&&point==='before-owner'){barrier=true;reached.resolve();await release.promise;}
   const prior=structuredClone(response);insideOwner=true;try{return await work(db,room);}catch(error){response=prior;throw error;}finally{insideOwner=false;}
  };
  let claimed=false;const job={projectId:project,source,actor,generation} as ProjectChatJob;
  const repository={pool:modelPool,policy:{request:()=>req},claim:async()=>{if(claimed)return;claimed=true;return job;},children:async()=>[response],scoped,assertRunning:async()=>{},bump:async()=>{},transaction:async(work:(db:ProjectChatDb)=>Promise<unknown>)=>work(db),room:async()=>room} as unknown as ProjectChatRepository;
  const runner=new ProjectChatRunner(repository,inference);runner.schedule(project,roomId);
  return {runner,tools,reached,release,revoke:()=>{visible=false;},response:()=>response,runtime,search,sentinel};
 }
 it.each(['before-owner','after-update'] as const)('does not publish a revoked public source at %s',async point=>{
  const f=await fixture(point);try{if(point==='before-owner'){await f.reached.promise;f.revoke();f.release.resolve();}await f.runner.waitIdle();
   expect(f.response().status).toBe('failed');expect(f.response().content).not.toContain(f.sentinel);expect(f.search.create).toHaveBeenCalledOnce();expect(f.runtime.infer).toHaveBeenCalledTimes(3);
  }finally{f.release.resolve();await f.runner.stop();await f.tools.onModuleDestroy();}
 });
 it.each([true,false])('retains a valid answer and the own done-recipient transition, tools=%s',async enabled=>{
  const f=await fixture('none',enabled);try{await f.runner.waitIdle();expect(f.response().status).toBe('done');expect(f.response().content).toBe(enabled?f.sentinel:'No tools answer');expect(f.runtime.infer).toHaveBeenCalledTimes(enabled?3:1);}
  finally{await f.runner.stop();await f.tools.onModuleDestroy();}
 });
 it('publishes a normal answer after complete fenced planner actions without extra requests',async()=>{
  const f=await fixture('none',true,'fenced');try{
   await f.runner.waitIdle();expect(f.response().status).toBe('done');expect(f.response().content).toBe(f.sentinel);
   expect(f.runtime.infer).toHaveBeenCalledTimes(3);expect(f.search.create).toHaveBeenCalledOnce();
  }finally{await f.runner.stop();await f.tools.onModuleDestroy();}
 });
 it.each(['length','plain'] as const)('stops on a %s planner response without dispatching a tool or another model request',async planner=>{
  const f=await fixture('none',true,planner);try{
   await f.runner.waitIdle();expect(f.response().status).toBe('failed');expect(f.response().content).toBe('');
   expect(f.response().error).toContain(planner==='length'?'Модель не завершила выбор инструмента':'Модель вернула ответ не в формате JSON');
   expect(f.response().error).not.toContain('private-provider-text');expect(f.runtime.infer).toHaveBeenCalledOnce();expect(f.search.create).not.toHaveBeenCalled();
  }finally{await f.runner.stop();await f.tools.onModuleDestroy();}
 });
});

describe('Public result reader inside an existing owner transaction',()=>{
 it.each([true,false])('uses only the supplied connection and current public visibility=%s',async visible=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','publication-reader');const actor={email:'developer@fixture.test',activeRole:'Разработчик'},project='prj-reader',id=randomUUID();
  const req={headers:{'x-neurocenter-internal':'publication-reader','x-bridge-actor':encodeURIComponent(JSON.stringify(actor))}} as unknown as Request;
  const hit={messageId:randomUUID(),revision:'1',chunk:0,score:1,content:'Current public data'};
  const connect=vi.fn(()=>{throw Error('The final owner already holds the single pool connection');});
  const db={query:vi.fn(async(sql:string)=>({rows:sql.includes('FROM platform_users')?[{enabled:true,display_name:'Developer'}]
   :sql.includes('FROM project_members')?[{project_id:project,role:actor.activeRole}]:sql.includes('FROM projects')?[{state:'ACTIVE'}]
    :sql.includes('FROM chat_search_jobs')?[{id,project_id:project,actor:actor.email,kind:'search',state:'SUCCEEDED',model_id:'model-embedding',model_pin:'a'.repeat(64),result:{hits:[hit]}}]
     :sql.includes('FROM jsonb_to_recordset')?(visible?[hit]:[]):[]}))} as unknown as ProjectChatDb;
  const service=new ChatSearchService({pool:{connect}} as unknown as ModelsService,{} as ModelRuntime);
  try{const result=await service.get(req,project,id,db);expect(result.results).toEqual(visible?[hit]:[]);expect(connect).not.toHaveBeenCalled();}
  finally{await service.onModuleDestroy();}
 });
});
