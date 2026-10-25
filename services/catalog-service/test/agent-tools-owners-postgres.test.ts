import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import type {ModuleRef} from '@nestjs/core';
import {describe,expect,it,vi} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {chatLearningFixture,projectId,reply,req} from './chat-learning.fixture';
import {main} from './agent-postgres.fixture';
import {AgentToolsService} from '../src/agent-tools/agent-tools.service';
import {ModelChatService} from '../src/model-chat/chat.service';
import {ProjectChatService} from '../src/project-chat/project-chat.service';
import {ProjectChatInferenceService} from '../src/project-chat-inference/project-chat-inference.service';
import {currentModelUsage} from '../src/model-usage/model-usage.context';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import type {ModelsService} from '../src/models/models.service';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {ChatMessage} from '../src/model-chat/chat.types';
import {initialGeneration} from '../src/models/project-embedding.repository';

const connection=process.env.AGENT_TOOL_TEST_ADMIN_URL;
const modules={get:()=>({list:async()=>({items:[{slug:'getting-started',title:'Работа с проектом',summary:'Контекст проекта'}]}),
 read:async()=>({slug:'getting-started',title:'Работа с проектом',revision:'fixture',content:'Проверьте источники и подключение проекта.'})})} as unknown as ModuleRef;
/** Actual private/group/team admission, source owners, agent snapshots and SQL receipts; provider and help text are fixtures. */
describe.skipIf(!connection).sequential('Agent tools through actual chat owners on owned PostgreSQL16',()=>{
 async function setup(){
  const disk=await statfs(process.cwd());if(disk.bavail*disk.bsize<4*1024**3)throw Error('Owned PostgreSQL fixture requires4GiB free.');
  expect(ownedTestPostgresAdmin(process.env.CATALOG_TEST_PG_URL!).href).toBe(ownedTestPostgresAdmin(connection!).href);
  const f=await chatLearningFixture();try{await f.setup(32768);}catch(error){await f.cleanup();await f.close();throw error;}
  const tools=new AgentToolsService(f.models as unknown as ModelsService,f.runtime as unknown as ModelRuntime,modules);
  const messages:ChatMessage[][]=[];let planning=0;
  f.runtime.infer.mockImplementation(async(_model,_endpoint,body)=>{
   await currentModelUsage().beforeInference?.();messages.push(structuredClone(body.messages as ChatMessage[]));
   if(currentModelUsage().purpose==='research')return reply(JSON.stringify(planning++===0?{action:'request_system_role',roleId:'agent-ai-admin',instruction:'Какой контекст и состояние доступны?'}:{action:'finish'}));
   return reply('Ответ с проверенными источниками проекта.');
  });
  return {f,tools,messages};
 }
 it.each(['model','group'] as const)('executes tools through %s chat and does not run the old research loop',async mode=>{
  const {f,tools,messages}=await setup();let service:ModelChatService|undefined;
  try{
   service=new ModelChatService(f.models as unknown as ModelsService,f.runtime as unknown as ModelRuntime,tools);service.pool.options.max=1;service.projectContext=f.service.projectContext;
   const card=mode==='group'?await f.agent('Planner'):undefined,model=await f.models.getUsable();
   const detail=await service.create(req(),{modelId:model.id,projectId,expectedModelPin:projectEmbeddingPin(model),mode,...(card?{agentIds:[card.id]}:{})});
   const result=await service.send(req(),detail.conversation.id,{requestId:randomUUID(),expectedRevision:detail.conversation.revision,expectedModelPin:detail.conversation.modelPin,prompt:'Какой контекст доступен?',attachmentIds:[],
    ...(card?{targetAgentIds:[card.id]}:{}),agentTools:{protocol:'json-actions-v1',rag:false,systemRoles:true}},new AbortController().signal);
   const turn=result.turns.at(-1)!;expect(turn.status,JSON.stringify(turn)).toBe('done');expect(turn.agentTools).toEqual({protocol:'json-actions-v1',rag:false,systemRoles:true});
   expect(card?turn.responses?.[0].answer?.content:turn.answer?.content).toBe('Ответ с проверенными источниками проекта.');
   const rows=(await f.pool.query('SELECT action,state,agent_id FROM agent_tool_steps WHERE turn_id=$1 ORDER BY sequence',[turn.id])).rows;
   expect(rows.map(row=>row.action)).toEqual(['planner','request_system_role','planner']);expect(rows.every(row=>row.state==='succeeded')).toBe(true);
   expect(rows[1].agent_id).toBe(card?.id??null);expect(JSON.stringify(messages.at(-1))).toContain('guidance:queue-learning');
   expect((await f.pool.query('SELECT count(*)::int AS count FROM model_chat_research_steps WHERE turn_id=$1',[turn.id])).rows[0].count).toBe(0);
  }finally{await service?.onApplicationShutdown();await tools.onModuleDestroy();await f.cleanup();await f.close();}
 },60000);
 it('executes real tools for a project-room agent with the initiating developer rights',async()=>{
  const {f,tools,messages}=await setup();let service:ProjectChatService|undefined;
  try{
   const card=await f.agent('Planner'),models=f.models as unknown as ModelsService,model=await f.models.getUsable();
   service=new ProjectChatService(models,new ProjectChatInferenceService(models,f.runtime as unknown as ModelRuntime,tools));
   const admin={headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN,'x-bridge-actor':encodeURIComponent(JSON.stringify(main))}} as unknown as Parameters<ProjectChatService['read']>[0];
   const current=await service.read(admin,projectId);await service.participants(admin,projectId,{expectedRevision:current.room.revision,agentIds:[card.id],modelId:model.id,expectedModelPin:projectEmbeddingPin(model)});
   const deviceId=randomUUID(),privateCapability='private-device-sentinel',owner=(await f.models.actor(req())).email;
   await f.pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,last_seen,report) VALUES($1,$2,$3,$4,$5,$6,now(),$7::jsonb)',
    [deviceId,owner,'Разработчик','Personal device sentinel','d'.repeat(32),randomUUID(),JSON.stringify({protocolVersion:2,buildId:'d'.repeat(64),capabilities:[privateCapability]})]);
   await f.pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,message) VALUES($1,$2,$3,'Разработчик',$4,'uninstall','{}',$5,$6,'Private queued action')",
    [randomUUID(),deviceId,owner,projectId,randomUUID(),'e'.repeat(64)]);
   const observed: string[]=[],query=f.pool.query.bind(f.pool) as (sql:string,values?:unknown[])=>Promise<unknown>;
   vi.spyOn(f.pool,'query').mockImplementation(((sql:string,values?:unknown[])=>{observed.push(sql);return query(sql,values);}) as never);
   const sent=await service.send(req(),projectId,{requestKey:randomUUID(),prompt:'Какой контекст доступен?',targetAgentIds:[card.id],agentTools:{protocol:'json-actions-v1',rag:false,systemRoles:true}});
   await service.runner.waitIdle();const detail=await service.read(req(),projectId),answer=detail.messages.find(row=>row.kind==='agent');
   expect(answer?.status).toBe('done');expect(answer?.content).toContain('проверенными источниками');expect(sent.message.agentTools).toEqual({protocol:'json-actions-v1',rag:false,systemRoles:true});
   const steps=(await f.pool.query('SELECT owner_kind,actor_role,state FROM agent_tool_steps WHERE turn_id=$1 ORDER BY sequence',[sent.message.id])).rows;
   expect(steps).toHaveLength(3);expect(steps.every(row=>row.owner_kind==='project-chat'&&row.actor_role==='Разработчик'&&row.state==='succeeded')).toBe(true);
   expect(JSON.stringify(messages.at(-1))).toContain('guidance:project-learning');expect((await f.pool.query('SELECT count(*)::int AS count FROM system_role_runs')).rows[0].count).toBe(0);
   expect(JSON.stringify(messages)).not.toContain(deviceId);expect(JSON.stringify(messages)).not.toContain(privateCapability);
   expect(observed.some(sql=>sql.includes('FROM bridge_devices WHERE email='))).toBe(false);expect(observed.some(sql=>sql.includes('FROM bridge_jobs WHERE project_id='))).toBe(false);
   const helper=(await f.pool.query("SELECT id FROM agent_tool_steps WHERE turn_id=$1 AND action='request_system_role'",[sent.message.id])).rows[0];
   expect(JSON.stringify(await tools.detail(req(),helper.id))).not.toContain(deviceId);expect(JSON.stringify(await tools.detail(req(),helper.id))).not.toContain(privateCapability);
  }finally{await service?.onApplicationShutdown();await tools.onModuleDestroy();await f.cleanup();await f.close();}
 },60000);
 it('cancels an actual personal owner while a ledger dispatch holds its row, with both pools limited to one',async()=>{
  const {f,tools}=await setup();let service:ModelChatService|undefined,release!:()=>void,running:Promise<unknown>|undefined;
  const held=new Promise<void>(yes=>{release=yes;}),ready=(()=>{let signal!:()=>void;const promise=new Promise<void>(yes=>{signal=yes;});return{promise,signal};})();
  const bounded=async<T,>(work:Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_yes,no)=>{timer=setTimeout(()=>no(Error('Owned cancellation barrier timed out')),3000);})]);}finally{if(timer)clearTimeout(timer);}};
  try{
   service=new ModelChatService(f.models as unknown as ModelsService,f.runtime as unknown as ModelRuntime,tools);service.pool.options.max=1;service.projectContext=f.service.projectContext;
   const model=await f.models.getUsable(),detail=await service.create(req(),{modelId:model.id,projectId,expectedModelPin:projectEmbeddingPin(model)}),dispatch=tools.repository.dispatch.bind(tools.repository);
   vi.spyOn(tools.repository,'dispatch').mockImplementationOnce((id,authorize)=>dispatch(id,async db=>{ready.signal();await held;await authorize(db);}));
   running=service.send(req(),detail.conversation.id,{requestId:randomUUID(),expectedRevision:detail.conversation.revision,expectedModelPin:detail.conversation.modelPin,prompt:'Проверь состояние',attachmentIds:[],agentTools:{protocol:'json-actions-v1',rag:false,systemRoles:true}},new AbortController().signal).catch(error=>({error}));
   await bounded(ready.promise);const current=await service.read(req(),detail.conversation.id),turn=current.turns.at(-1)!;
   const cancelled=await bounded(service.cancel(req(),detail.conversation.id,turn.id,{expectedRevision:current.conversation.revision}));expect(cancelled.turns.at(-1)?.status).toBe('cancelled');
   release();await bounded(running);expect(f.runtime.infer).not.toHaveBeenCalled();expect(tools.repository.pool.options.max).toBe(1);
   const row=(await f.pool.query('SELECT state,output FROM agent_tool_steps WHERE turn_id=$1',[turn.id])).rows[0];expect(row).toEqual({state:'cancelled',output:null});
  }finally{release();await running;await service?.onApplicationShutdown();await tools.onModuleDestroy();await f.cleanup();await f.close();}
 },60000);
 it('reuses the initial RAG search for the same query instead of paying for a second embedding',async()=>{
  const {f,tools}=await setup();let service:ModelChatService|undefined;
  try{
   const search=await f.configureRag(),generation=initialGeneration(projectId),snapshot='b'.repeat(64);
   search.mockImplementation(async()=>({generation,snapshot,sources:[{id:'fixture-source',path:'src/feature.ts',score:0.9,excerpt:'Confirmed project context.'}]}));
   service=new ModelChatService(f.models as unknown as ModelsService,f.runtime as unknown as ModelRuntime,tools);service.pool.options.max=1;service.projectContext=f.service.projectContext;let planners=0,embeddings=0;
   f.runtime.infer.mockImplementation(async(_model,endpoint,body)=>{
    await currentModelUsage().beforeInference?.();if(endpoint==='embed'){embeddings++;return{embeddings:[[1,2,3]]};}
    if(currentModelUsage().purpose==='research')return reply(JSON.stringify(planners++===0?{action:'rag_search',query:'Question'}:planners===2?{action:'rag_read',sourceId:'fixture-source'}:{action:'finish'}));
    expect(JSON.stringify(body.messages)).toContain('Confirmed project context.');return reply('Ответ с источником.');
   });
   const model=await f.models.getUsable(),detail=await service.create(req(),{modelId:model.id,projectId,expectedModelPin:projectEmbeddingPin(model)});
   const result=await service.send(req(),detail.conversation.id,{requestId:randomUUID(),expectedRevision:detail.conversation.revision,expectedModelPin:detail.conversation.modelPin,prompt:'Question',attachmentIds:[],agentTools:{protocol:'json-actions-v1',rag:true}},new AbortController().signal);
   expect(result.turns.at(-1)?.status).toBe('done');expect(embeddings).toBe(1);expect(search).toHaveBeenCalledOnce();expect(planners).toBe(3);
  }finally{await service?.onApplicationShutdown();await tools.onModuleDestroy();await f.cleanup();await f.close();}
 },60000);
 it('does not spend an initial embedding when RAG is explicitly off for the message',async()=>{
  const {f,tools}=await setup();let service:ModelChatService|undefined;
  try{
   const search=await f.configureRag();service=new ModelChatService(f.models as unknown as ModelsService,f.runtime as unknown as ModelRuntime,tools);service.pool.options.max=1;service.projectContext=f.service.projectContext;
   f.runtime.infer.mockImplementation(async(_model,endpoint)=>{if(endpoint==='embed')throw Error('RAG OFF must not dispatch an embedding');return reply(currentModelUsage().purpose==='research'?'{"action":"finish"}':'Ответ без поиска по знаниям.');});
   const model=await f.models.getUsable(),detail=await service.create(req(),{modelId:model.id,projectId,expectedModelPin:projectEmbeddingPin(model)});
   const result=await service.send(req(),detail.conversation.id,{requestId:randomUUID(),expectedRevision:detail.conversation.revision,expectedModelPin:detail.conversation.modelPin,prompt:'Question',attachmentIds:[],agentTools:{protocol:'json-actions-v1',rag:false,systemRoles:true}},new AbortController().signal);
   expect(result.turns.at(-1)?.status).toBe('done');expect(search).not.toHaveBeenCalled();expect(f.runtime.infer.mock.calls.some(([,endpoint])=>endpoint==='embed')).toBe(false);
  }finally{await service?.onApplicationShutdown();await tools.onModuleDestroy();await f.cleanup();await f.close();}
 },60000);
});
