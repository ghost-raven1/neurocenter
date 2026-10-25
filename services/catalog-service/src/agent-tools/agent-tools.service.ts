import {BadRequestException,ConflictException,ForbiddenException,Injectable,type OnModuleDestroy} from '@nestjs/common';
import {ModuleRef} from '@nestjs/core';
import type {Request} from 'express';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {projectChatModels} from '../project-chat-inference/project-chat-models';
import {ModelsService} from '../models/models.service';
import {createPool} from '../database/pool';
import {ModelRuntime} from '../models/model-runtime';
import {modelInferenceBody} from '../models/inference.controller';
import {automaticModelOptions} from '../models/model-runtime-options';
import {withModelUsage} from '../model-usage/model-usage.context';
import {projectEmbeddingPin,assertProjectEmbeddingModel} from '../models/project-embedding.validation';
import {ModelChatProjectContext} from '../model-chat/chat-project-context';
import type {PreparedProjectContext,ChatProjectSource} from '../model-chat/chat-project-context.types';
import {ChatSearchService} from '../chat-search/chat-search.service';
import {HelpService} from '../help/help.service';
import {SystemRoleGuidance} from '../system-roles/system-role.guidance';
import {projectLevel} from '../access/access.model';
import {systemRole} from '../system-roles/system-role.definitions';
import {assertProjectChatRoomAccess} from '../project-chat/project-chat-room-access';
import type {ProjectChatRoomRow} from '../project-chat/project-chat.types';
import {requireFeatureEnabled,requireFeaturesEnabled} from '../features/require-feature-enabled';
import {readFeatures} from '../../../shared/feature-client.cjs';
import {CHAT_SEARCH_FEATURES} from '../chat-search/chat-search.types';
import {AgentToolsRepository} from './agent-tools.repository';
import {AgentToolsLoop} from './agent-tools.loop';
import {AGENT_TOOL_LIMITS,type AgentToolGrant,type AgentToolScope,type AgentToolStepRow,type AgentToolCapabilities} from './agent-tools.types';

/** Ordinary chat tools keep the caller's authority and use real domain owners for paid work. */
@Injectable()
export class AgentToolsService implements OnModuleDestroy {
 readonly repository:AgentToolsRepository;
 private readonly loop:AgentToolsLoop;
 private readonly project:ModelChatProjectContext;
 constructor(private readonly models:ModelsService,private readonly runtime:ModelRuntime,private readonly modules:ModuleRef){
  // Fresh owner checks may borrow the model pool while the ledger holds a transaction; keep the two bounded pools independent.
  this.repository=new AgentToolsRepository(createPool({...models.pool.options,max:1},'agent-tools'));this.loop=new AgentToolsLoop(this.repository);this.project=new ModelChatProjectContext(models,runtime);
 }
 async onModuleDestroy():Promise<void>{await this.repository.pool.end();}
 /** Per-message RAG OFF retains free project metadata and never creates an embedding request. */
 async metadataProject(req:Request,projectId:string,signal:AbortSignal,authorize:()=>Promise<unknown>):Promise<PreparedProjectContext>{
  signal.throwIfAborted();const current=async()=>{signal.throwIfAborted();await authorize();signal.throwIfAborted();},metadata=await this.project.overview(req,projectId);
  const evidence={...metadata,status:'metadata' as const,sources:[],message:'Поиск по знаниям проекта выключен для этого сообщения.'};await current();
  return {messages:[],evidence,requiredFeatures:[],assertCurrent:current,beforeInference:current,fit:messages=>({messages,evidence})};
 }
 async admit(req:Request,projectId:string,grant:AgentToolGrant):Promise<void>{
  await requireFeatureEnabled('project_agent_tools');await this.models.resolveProject(req,projectId,2);
  if(grant.rag)await requireFeatureEnabled('project_search');
  if(grant.systemRoles)await requireFeatureEnabled('system_role_guidance');
  if(grant.publicChats)await requireFeaturesEnabled(CHAT_SEARCH_FEATURES);
  if(grant.publicChats){const model=await this.models.getUsable(grant.publicChats.modelId,req,projectId);assertProjectEmbeddingModel(model,model.dimension??0);
   if(projectEmbeddingPin(model)!==grant.publicChats.expectedModelPin)throw new ConflictException('Embedding-модель публичного поиска изменилась. Подтвердите актуальную версию.');}
 }
 async capabilities(req:Request,projectId:string):Promise<AgentToolCapabilities>{
  const actor=await this.models.actor(req);await this.models.resolveProject(req,projectId,1);
  const off={available:false},base:AgentToolCapabilities={protocol:'json-actions-v1',available:false,rag:off,publicChats:{available:false,models:[]},systemRoles:off,
   mcp:{available:false,reason:'MCP для обычных агентов пока недоступен. Используйте только подтверждённые инструменты ниже.'},limits:{steps:AGENT_TOOL_LIMITS.steps,deadlineMs:AGENT_TOOL_LIMITS.deadlineMs}};
  if(projectLevel(actor.claims,actor.activeRole,projectId)<2)return {...base,reason:'Ваша роль разрешает просмотр. Для инструментального ответа нужен разработчик проекта.'};
  let flags;try{flags=(await readFeatures(process.env,globalThis.fetch)).flags;}catch{return {...base,reason:'Не удалось проверить доступность инструментов. Обновите состояние.'};}
  if(!flags.project_agent_tools)return {...base,reason:'Инструменты агентов выключены. История прежних шагов сохраняется.'};
  const models:AgentToolCapabilities['publicChats']['models']=[],enabledSearch=CHAT_SEARCH_FEATURES.every(key=>flags[key]);
  if(enabledSearch){const list=await this.models.list(req,projectId),assigned=new Set(list.assignedModelIds);
   for(const card of list.items){if(!assigned.has(card.id)||card.archivedAt||card.capability!=='embedding')continue;
    try{const model=await this.models.getUsable(card.id,req,projectId);assertProjectEmbeddingModel(model,model.dimension??0);models.push({id:model.id,name:model.name,pin:projectEmbeddingPin(model),dimension:model.dimension!});}catch{/* Ineligible cards are not offered as available tools. */}
   }
  }
  return {...base,available:true,rag:{available:flags.project_search,...(!flags.project_search?{reason:'Поиск по знаниям проекта выключен.'}:{})},
   publicChats:{available:enabledSearch&&models.length>0,models,...(!enabledSearch||!models.length?{reason:'Назначьте проекту проверенную embedding-модель и включите поиск публичных чатов.'}:{})},
   systemRoles:{available:flags.system_role_guidance&&(flags.system_ai_admin||flags.system_autoconfigurator||flags.system_indexer),...(!flags.system_role_guidance?{reason:'Системная справка и диагностика выключены.'}:{})}};
 }
 async run(req:Request,scope:Omit<AgentToolScope,'execute'|'infer'>,initial:PreparedProjectContext,initialQuery:string){
  const callerSignal=scope.signal;
  scope={...scope,signal:AbortSignal.any([scope.signal,AbortSignal.timeout(120000)])};
  const found=new Map(initial.evidence.sources.map(source=>[source.id,source])),checks:Array<(db?:Parameters<AgentToolScope['assertCurrent']>[0])=>Promise<void>>=[];
  const assertCurrent:AgentToolScope['assertCurrent']=async db=>{await scope.assertCurrent(db);await initial.assertCurrent(db);for(const check of checks)await check(db);};
  const tools:AgentToolScope={...scope,assertCurrent,
   infer:async(messages,current)=>{
    const model=await this.models.getUsable(scope.owner.modelId,req,scope.owner.projectId);
    if(projectEmbeddingPin(model)!==scope.owner.modelPin)throw new ConflictException('Модель агента изменилась.');
    const room=scope.owner.kind==='project-chat'?(await this.models.pool.query<ProjectChatRoomRow>('SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2',[scope.owner.projectId,scope.owner.originId])).rows[0]:undefined;
    const response=await withModelUsage({purpose:'research',actorEmail:scope.owner.ownerEmail,actorRole:scope.owner.actorRole,projectId:scope.owner.projectId,
     agentId:scope.owner.agentId??undefined,turnId:scope.owner.turnId,operationId:scope.owner.generation,...(room?.visibility==='PRIVATE'?{privateProjectChatRoomId:scope.owner.originId}:{}),
     requiredFeatures:['project_agent_tools'],beforeInference:current},()=>this.runtime.infer(model,'chat',modelInferenceBody('chat',{messages,stream:false,
      options:automaticModelOptions(model,{num_predict:Math.min(1024,scope.settings.reservedOutputTokens??1024)})}),scope.signal));
    const message=response.message as {role?:unknown;content?:unknown}|undefined;
    if(message?.role!=='assistant'||typeof message.content!=='string'||response.done_reason!=='stop')throw new BadRequestException('Модель не завершила выбор инструмента. Автоматического повтора нет.');return message.content;
   },
   observe:async(action,value)=>{
    if(!value||typeof value!=='object')return;
    if(action.action==='rag_search'){
     const result=value as {sources?:ChatProjectSource[];generation?:string;snapshot?:string;contextIdentity?:string};
     const check=async(db?:Parameters<AgentToolScope['assertCurrent']>[0])=>{if(result.sources?.length){if(!result.contextIdentity)throw new ConflictException('Источники не содержат подтверждённый снимок.');await this.project.assertIdentity(req,scope.owner.projectId,result.contextIdentity,callerSignal,db);}};
     await check();checks.push(check);for(const source of result.sources??[])found.set(source.id,source);
    }
   },
   present:async(action,value)=>{
    if(action.action!=='public_chat_search'||!value||typeof value!=='object')return value;
    const ref=value as {jobId?:string;status?:string};if(!ref.jobId||ref.status!=='ready')return value;
    const search=this.modules.get(ChatSearchService,{strict:false}),job=await search.get(req,scope.owner.projectId,ref.jobId);
    if(job.state!=='SUCCEEDED')throw new ConflictException('Прежний поиск публичного чата больше недоступен.');
    const results=job.results??[],check=async(db?:Parameters<AgentToolScope['assertCurrent']>[0])=>{
     const selected=scope.owner.grant.publicChats!,model=await (db?projectChatModels(this.models,db):this.models).getUsable(selected.modelId,req,scope.owner.projectId);
     if(projectEmbeddingPin(model)!==selected.expectedModelPin)throw new ConflictException('Embedding-модель публичного поиска изменилась.');
     const current=await search.get(req,scope.owner.projectId,ref.jobId!,db);if(current.state!=='SUCCEEDED'||!isDeepStrictEqual(current.results??[],results))throw new ConflictException('Публичный источник изменён, удалён или закрыт. Прежний текст не отправлен модели.');
    };
    await check();checks.push(check);return {...ref,results};
   },
   execute:async(action,step,reference)=>{
    if(action.action==='rag_search'){
     const result=action.query.trim()===initialQuery.trim()?initial:await this.project.prepare(req,scope.owner.projectId,action.query,scope.signal,()=>assertCurrent());
     if(!['ready','empty'].includes(result.evidence.status))return {status:'unavailable',message:result.evidence.message??'Индекс проекта недоступен.',sources:[]};
     const captured=await this.project.capture(req,scope.owner.projectId,callerSignal);await result.assertCurrent();
     return {status:result.evidence.status,contextIdentity:captured.identity,generation:result.evidence.generation,snapshot:result.evidence.snapshot,sources:result.evidence.sources};
    }
    if(action.action==='rag_read'){
     const source=found.get(action.sourceId);if(!source)throw new BadRequestException('Читайте только источники, найденные текущим запросом проекта.');
     await assertCurrent();return {source};
    }
    if(action.action==='public_chat_search'){
     const grant=scope.owner.grant.publicChats!;await this.admit(req,scope.owner.projectId,scope.owner.grant);
     const search=this.modules.get(ChatSearchService,{strict:false});
     let job=await search.create(req,scope.owner.projectId,'search',{...grant,requestKey:step.id,query:action.query,limit:3});
     try{
      await reference({kind:'public-chat-search',jobId:job.id});
      while(job.state==='RUNNING'){await delay(150,undefined,{signal:scope.signal});await assertCurrent();job=await search.get(req,scope.owner.projectId,job.id);}
      if(job.state!=='SUCCEEDED')return {status:'unavailable',message:job.error??'Поиск не завершён.',jobId:job.id};
      // The durable ledger retains only a live domain receipt. PUBLIC text is hydrated after current visibility/revision filters.
      return {status:'ready',jobId:job.id};
     }finally{if(job.state==='RUNNING')await search.cancel(req,scope.owner.projectId,job.id).catch(()=>undefined);}
    }
    const definition=systemRole(action.roleId),help=this.modules.get(HelpService,{strict:false});
    try{await requireFeatureEnabled(definition.flag);}catch{scope.signal.throwIfAborted();return {status:'unavailable',roleId:definition.id,message:'Эта системная роль выключена или её доступность пока не подтверждена. Справка не запускалась.'};}
    const guidance=await new SystemRoleGuidance(this.models,help).collect(req,scope.owner.projectId,action.instruction,scope.signal,()=>assertCurrent(),scope.owner.kind==='project-chat'?'project-shared':'private-owner');
    await reference({kind:'system-role-help',roleId:definition.id,checkedAt:guidance.evidence.checkedAt});
    const actor=await this.models.actor(req);
    return {status:guidance.evidence.status,roleId:definition.id,mode:'read-only-assistance',sources:guidance.evidence,
     data:JSON.parse(guidance.content),actions:guidance.actions,
     task:{status:projectLevel(actor.claims,actor.activeRole,scope.owner.projectId)>=3?'available_on_user_request':'needs_permission',
      message:'Справка и диагностика выполнены в пределах вашего проекта. Изменения не применялись. Полная системная задача запускается пользователем отдельно с собственными правами.'}};
   }};
  const messages=await this.loop.run(tools);
  return {messages,assertCurrent:async(db?:Parameters<AgentToolScope['assertCurrent']>[0])=>{await (scope.assertAuthorized?scope.assertAuthorized(db):scope.assertCurrent(db));await initial.assertCurrent(db);for(const check of checks)await check(db);}};
 }
 async history(req:Request,projectId:string,turnId:string){
  const actor=await this.models.actor(req);await this.models.resolveProject(req,projectId,1);
  const rows=await this.repository.list(actor.email,projectId,turnId);for(const row of rows)await this.historyAccess(req,actor.email,row);
  return {steps:rows.map(({input:_input,output:_output,grant_snapshot:_grant,input_hash:_hash,...row})=>row)};
 }
 async detail(req:Request,id:string){
  const actor=await this.models.actor(req),row=await this.repository.get(actor.email,id);await this.models.resolveProject(req,row.project_id,1);await this.historyAccess(req,actor.email,row);
  if(row.action==='public_chat_search'&&row.state==='succeeded'){
   const ref=row.output as {jobId?:string;status?:string}|null;
   if(ref?.jobId&&ref.status==='ready'){const current=await this.modules.get(ChatSearchService,{strict:false}).get(req,row.project_id,ref.jobId);return {step:{...row,output:{...ref,results:current.state==='SUCCEEDED'?current.results??[]:[],state:current.state}}};}
  }
  return {step:row};
 }
 private async historyAccess(req:Request,owner:string,row:AgentToolStepRow):Promise<void>{
  if(row.owner_kind==='model-chat'){
   const current=(await this.models.pool.query<{model_id:string}>('SELECT c.model_id FROM model_chat_conversations c JOIN model_chat_turns t ON t.conversation_id=c.id WHERE c.id=$1 AND t.id=$2 AND c.owner_email=$3 AND c.project_id=$4 AND t.removed_at IS NULL',[row.origin_id,row.turn_id,owner,row.project_id])).rows[0];
   if(!current)throw new ForbiddenException('Исходный диалог недоступен.');await this.models.getUsable(current.model_id,req,row.project_id);
  }else{
   const room=(await this.models.pool.query<ProjectChatRoomRow>('SELECT * FROM project_chat_rooms WHERE project_id=$1 AND id=$2',[row.project_id,row.origin_id])).rows[0];
   if(!room)throw new ForbiddenException('Исходный диалог недоступен.');await assertProjectChatRoomAccess(this.models.pool,room,owner);
  }
 }
}
