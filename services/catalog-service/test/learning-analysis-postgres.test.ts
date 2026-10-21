import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import type {Pool} from 'pg';
import {database,reset,main,connection} from './agent-postgres.fixture';
import {LearningService} from '../src/learning/learning.service';
import {LearningAnalysisService} from '../src/learning/learning-analysis.service';
import {LearningAnalysisRepository} from '../src/learning/learning-analysis.repository';
import {ModelsService} from '../src/models/models.service';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import type {IModel} from '../src/models/model.types';
import {assertLearningAnalysisSchema} from '../src/learning/learning-analysis-schema-verification';
import {requireRetirementIdle} from '../src/retired-rag/retirement-guards';
import {RemoteModelClient} from '../src/models/remote-model-client';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));

const projectId='prj-agents';
const request={headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify(main))}} as unknown as Request;
const sample={title:'Повторяемый сбой',summary:'После изменения обнаружена ошибка.',outcome:'failed' as const,evidence:[{kind:'test' as const,status:'failed' as const,summary:'Проверка выявила несовпадение.'}],context:{}};
const baseModel:IModel={id:'model-learning',name:'Fixture model',description:'',runtime:'remote-openai',capability:'chat',model:'fixture',modelVersion:'v1',manifestSha256:null,verificationSha256:'a'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
type InternalWorker={work:()=>Promise<void>;pending:Promise<void>|undefined};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};
describe.skipIf(!connection)('Durable analysis jobs — disposable PostgreSQL',()=>{
 let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,learning:LearningService,service:LearningAnalysisService,repository:LearningAnalysisRepository;
 let model:IModel,available:boolean,modelCalls:number,infer:ReturnType<typeof vi.fn>;
 const worker=()=>service as unknown as InternalWorker;
 const count=async(table:string)=>Number((await pool.query('SELECT count(*) AS n FROM '+table)).rows[0].n);
 const revision=()=>learning.repository.revision(projectId);
 const experience=async()=>{
  const result=await learning.repository.addExperience(main,projectId,{requestKey:randomUUID(),expectedRevision:await revision(),...sample},{origin:'human',device:null});return result.result.experience;
 };
 const create=async()=>{const exp=await experience();return service.create(request,projectId,{requestKey:randomUUID(),expectedRevision:await revision(),experienceIds:[exp.id],modelId:model.id});};
 const resultFor=async()=>({done:true,done_reason:'stop',message:{content:JSON.stringify({hypotheses:[{subject:'agent',title:'Уточнить проверку',statement:'Ранний тест может обнаружить сбой до сборки.',rationale:'Есть воспроизводимый неуспех.',verificationPlan:'Сравнить на одинаковом исходном состоянии.',experienceIds:(await pool.query('SELECT id FROM project_learning_experiences WHERE project_id=$1 ORDER BY created_at,id LIMIT 1',[projectId])).rows.map(row=>row.id)}]})}});
 beforeAll(async()=>{fixture=await database();pool=fixture.pool;});
 afterAll(async()=>{await fixture?.close();});
 beforeEach(async()=>{
  vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);
  await reset(pool);model={...baseModel};available=true;modelCalls=0;
  await pool.query('TRUNCATE model_catalog CASCADE');
  const {id,name,revision:_revision,createdAt:_created,updatedAt:_updated,...descriptor}=baseModel;
  await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)',[id,name,JSON.stringify(descriptor)]);
  await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[projectId,id,main.email]);
  const models={ready:async()=>{},actor:async()=>({...main,claims:{email:main.email,userRoles:['Главный админ'],projects:[],pluginIds:[],skillPaths:[]}}),
   resolveProject:async(_req:Request,id:string)=>{const row=(await pool.query('SELECT id FROM projects WHERE id=$1',[id])).rows[0];if(!row)throw new ForbiddenException();return row;},
   getUsable:async()=>{if(!available)throw new ForbiddenException();return {...model};}} as unknown as ModelsService;
  infer=vi.fn(async()=>{modelCalls++;return resultFor();});
  const original=process.env.CATALOG_PG_URL;process.env.CATALOG_PG_URL=String(pool.options.connectionString);
  try{learning=new LearningService(models);service=new LearningAnalysisService(learning,models,{infer:(...args)=>infer(...args)});}finally{if(original===undefined)delete process.env.CATALOG_PG_URL;else process.env.CATALOG_PG_URL=original;}
  repository=service.repository;
 });
 afterEach(async()=>{await service.onApplicationShutdown();await learning.onApplicationShutdown();vi.restoreAllMocks();});
 it('disabled hosting refuses a new analysis before a durable enqueue',async()=>{
  vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('Функция «Хостинг моделей» отключена главным администратором.'));
  await expect(create()).rejects.toHaveProperty('status',403);expect(await count('project_learning_analyses')).toBe(0);expect(modelCalls).toBe(0);
 });
 it('a saved queued payload is denied after disable and is not silently inferred when re-enabled',async()=>{
  const job=await create();vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('Функция «Хостинг моделей» отключена главным администратором.'));
  await worker().work();expect((await service.get(request,projectId,job.id))).toMatchObject({state:'failed',error:{code:'FEATURE_DISABLED'}});expect(modelCalls).toBe(0);
  expect((await service.byKey(request,projectId,job.requestKey)).id).toBe(job.id);
  vi.mocked(requireFeaturesEnabled).mockResolvedValue(undefined);await worker().work();expect(modelCalls).toBe(0);expect(await count('project_learning_hypotheses')).toBe(0);
 });
 it('a flag change during an already paid call preserves its checked result without a second inference',async()=>{
  const job=await create(),answer=await resultFor();infer.mockImplementationOnce(async()=>{modelCalls++;vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ForbiddenException('Функция «Хостинг моделей» отключена главным администратором.'));return answer;});
  await worker().work();expect((await service.get(request,projectId,job.id)).state).toBe('completed');expect(modelCalls).toBe(1);expect(await count('project_learning_hypotheses')).toBe(1);
 });
 it('runs once, persists only hypotheses with exact model/source provenance and leaves context inactive',async()=>{
  const job=await create();expect(job.state).toBe('queued');await worker().work();
  const done=await service.get(request,projectId,job.id);expect(done.state).toBe('completed');expect(done.hypothesisIds).toHaveLength(1);expect(modelCalls).toBe(1);
  const overview=await learning.overview(request,projectId);expect(overview.hypotheses[0]).toMatchObject({status:'open',origin:'llm',model:{modelId:model.id,modelPin:projectEmbeddingPin(model),sourceRevision:job.sourceRevision,analysisId:job.id}});
  expect((await learning.context(request,projectId)).entries).toEqual([]);
 });
 it.each([undefined,{temperature:0.7,topP:0.8,maxOutputTokens:8192}])('uses remote OpenAI connection defaults in the durable learning flow: %j',async options=>{
  let providerBody:Record<string,unknown>|undefined;
  const client=new RemoteModelClient({fetch:vi.fn(async(_url,init)=>{
   providerBody=JSON.parse(String(init?.body));const answer=await resultFor();
   return new Response(JSON.stringify({model:model.model,choices:[{index:0,finish_reason:'stop',message:answer.message}]}),{headers:{'content-type':'application/json'}});
  }) as typeof fetch});
  infer.mockImplementationOnce(async(card:IModel,endpoint:'chat',body:Record<string,unknown>,signal:AbortSignal)=>{
   modelCalls++;expect(body.options).toEqual({});
   return client.infer(card,{modelId:card.id,revision:1,baseUrl:'http://127.0.0.1:1/v1',requestDimensions:false,options},endpoint,body,signal);
  });
  const job=await create();await worker().work();
  expect((await service.get(request,projectId,job.id)).state).toBe('completed');expect(modelCalls).toBe(1);
  expect(providerBody).not.toHaveProperty('num_ctx');expect(providerBody).not.toHaveProperty('contextWindow');
  if(options)expect(providerBody).toMatchObject({temperature:0.7,top_p:0.8,max_tokens:8192});
  else{expect(providerBody).not.toHaveProperty('temperature');expect(providerBody).not.toHaveProperty('max_tokens');}
 });
 it('recovers a lost create reply by the same key after learning revision changes, without a new model call',async()=>{
  const exp=await experience(),body={requestKey:randomUUID(),expectedRevision:await revision(),experienceIds:[exp.id],modelId:model.id};
  const job=await service.create(request,projectId,body);await worker().work();await experience();
  expect((await service.create(request,projectId,body)).id).toBe(job.id);expect((await service.byKey(request,projectId,body.requestKey)).state).toBe('completed');
  await worker().work();expect(modelCalls).toBe(1);expect(await count('project_learning_analyses')).toBe(1);
 });
 it('rejects changed payload under a used request key',async()=>{
  const exp=await experience(),body={requestKey:randomUUID(),expectedRevision:await revision(),experienceIds:[exp.id],modelId:model.id};await service.create(request,projectId,body);
  await expect(service.create(request,projectId,{...body,modelId:'other-model'})).rejects.toThrow('Ключ запроса');expect(await count('project_learning_analyses')).toBe(1);
 });
 it('coalesces concurrent same-key create calls and blocks a second active project job',async()=>{
  const exp=await experience(),body={requestKey:randomUUID(),expectedRevision:await revision(),experienceIds:[exp.id],modelId:model.id};
  const [a,b]=await Promise.all([service.create(request,projectId,body),service.create(request,projectId,body)]);expect(a.id).toBe(b.id);
  await expect(service.create(request,projectId,{...body,requestKey:randomUUID()})).rejects.toThrow('уже выполняется');expect(modelCalls).toBe(0);
 });
 it('rejects stale source revision before queueing',async()=>{
  const exp=await experience();await expect(service.create(request,projectId,{requestKey:randomUUID(),expectedRevision:0,experienceIds:[exp.id],modelId:model.id})).rejects.toThrow('изменился');expect(await count('project_learning_analyses')).toBe(0);
 });
 it('rejects evidence from another project and device attempts to generate or approve knowledge',async()=>{
  const exp=await experience();await expect(service.create(request,'prj-other',{requestKey:randomUUID(),expectedRevision:0,experienceIds:[exp.id],modelId:model.id})).rejects.toThrow('другому проекту');
  await expect(service.create({headers:{authorization:'Bearer device'}} as Request,projectId,{})).rejects.toThrow('человек');expect(await count('project_learning_analyses')).toBe(0);
 });
 it('rechecks model pin before spending inference and denies unavailable access',async()=>{
  const job=await create();model={...model,modelVersion:'v2'};await worker().work();expect((await service.get(request,projectId,job.id)).error?.code).toBe('SOURCE_CHANGED');expect(modelCalls).toBe(0);
 });
 it('discards a late answer after project/model access is revoked',async()=>{
  const job=await create(),started=deferred<void>(),reply=deferred<Record<string,unknown>>();infer.mockImplementationOnce(async()=>{modelCalls++;started.resolve();return reply.promise;});
  const running=worker().work();await started.promise;available=false;reply.resolve(await resultFor());await running;
  expect((await service.get(request,projectId,job.id)).error?.code).toBe('ACCESS_CHANGED');expect(await count('project_learning_hypotheses')).toBe(0);
 });
 it('does not invalidate a snapshot when independent observations arrive during inference',async()=>{
  const job=await create(),started=deferred<void>(),reply=deferred<Record<string,unknown>>();infer.mockImplementationOnce(async()=>{modelCalls++;started.resolve();return reply.promise;});
  const running=worker().work();await started.promise;await experience();reply.resolve(await resultFor());await running;
  expect((await service.get(request,projectId,job.id)).state).toBe('completed');expect(modelCalls).toBe(1);
 });
 it('refuses hallucinated evidence IDs without saving partial hypotheses',async()=>{
  const job=await create();infer.mockResolvedValueOnce({done:true,done_reason:'stop',message:{content:JSON.stringify({hypotheses:[{subject:'project',title:'x',statement:'x',rationale:'x',verificationPlan:'x',experienceIds:[randomUUID()]}]})}});
  await worker().work();expect((await service.get(request,projectId,job.id)).state).toBe('failed');expect(await count('project_learning_hypotheses')).toBe(0);
 });
 it('recovers an expired worker from a committed learning receipt without rerunning the model',async()=>{
  const job=await create(),row=await repository.claim(randomUUID());expect(row).not.toBeNull();
  const body=JSON.parse((await resultFor()).message.content);await learning.recordAnalysis(request,projectId,{requestKey:row!.mutation_key,expectedRevision:job.sourceRevision,hypotheses:body.hypotheses,model:{modelId:job.modelId,modelPin:job.modelPin,analysisId:job.id}});
  await pool.query("UPDATE project_learning_analyses SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);await repository.recoverExpired();
  const done=await service.get(request,projectId,job.id);expect(done.state).toBe('completed');expect(done.hypothesisIds).toHaveLength(1);await worker().work();expect(modelCalls).toBe(0);
 });
 it('marks an expired worker unknown and never automatically repeats inference',async()=>{
  const job=await create();await repository.claim(randomUUID());await pool.query("UPDATE project_learning_analyses SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  await worker().work();expect((await service.get(request,projectId,job.id)).state).toBe('unknown');await worker().work();expect(modelCalls).toBe(0);
 });
 it('checks the lease inside the hypothesis commit and rejects a late expired answer',async()=>{
  const job=await create(),row=await repository.claim(randomUUID());await pool.query("UPDATE project_learning_analyses SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  const body=JSON.parse((await resultFor()).message.content);await expect(learning.recordAnalysis(request,projectId,{requestKey:row!.mutation_key,expectedRevision:job.sourceRevision,hypotheses:body.hypotheses,model:{modelId:job.modelId,modelPin:job.modelPin,analysisId:job.id}},db=>repository.authorizeLease(db,row!))).rejects.toThrow('Аренда');
  expect(await count('project_learning_hypotheses')).toBe(0);
 });
 it('retries only acknowledgement after a transient post-commit failure',async()=>{
  const job=await create();vi.spyOn(repository,'complete').mockRejectedValueOnce(new Error('lost db acknowledgement'));await worker().work();
  expect((await service.get(request,projectId,job.id)).state).toBe('completed');expect(await count('project_learning_hypotheses')).toBe(1);expect(modelCalls).toBe(1);
 });
 it('resolves a lost learning COMMIT acknowledgement from its private exact receipt',async()=>{
  const job=await create(),record=learning.recordAnalysis.bind(learning);
  vi.spyOn(learning,'recordAnalysis').mockImplementationOnce(async(...args)=>{await record(...args);throw new Error('COMMIT acknowledgement lost');});
  await worker().work();expect((await service.get(request,projectId,job.id)).state).toBe('completed');expect(await count('project_learning_hypotheses')).toBe(1);expect(modelCalls).toBe(1);
 });
 it('leaves an uncertain failed commit lookup running for later exact-receipt recovery',async()=>{
  const job=await create(),record=learning.recordAnalysis.bind(learning);
  vi.spyOn(learning,'recordAnalysis').mockImplementationOnce(async(...args)=>{await record(...args);throw new Error('COMMIT acknowledgement lost');});
  vi.spyOn(repository,'reconcile').mockRejectedValueOnce(new Error('database temporarily unavailable'));
  await worker().work();expect((await service.get(request,projectId,job.id)).state).toBe('running');
  await pool.query("UPDATE project_learning_analyses SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);await worker().work();
  expect((await service.get(request,projectId,job.id)).state).toBe('completed');expect(modelCalls).toBe(1);
 });
 it('does not confuse a user mutation with an analysis receipt or poison the recovery queue',async()=>{
  const job=await create(),row=await repository.claim(randomUUID());
  await learning.recordExperience(request,projectId,{...sample,requestKey:job.id,expectedRevision:await revision()});
  expect(row!.mutation_key).not.toBe(job.id);await pool.query("UPDATE project_learning_analyses SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
  await expect(repository.recoverExpired()).resolves.toBeUndefined();expect((await service.get(request,projectId,job.id)).state).toBe('unknown');
 });
 it('uses actual lease time after a transaction has already started',async()=>{
  const job=await create(),row=await repository.claim(randomUUID()),client=await pool.connect();
  try{await client.query("UPDATE project_learning_analyses SET lease_until=clock_timestamp()+interval '0.2 seconds' WHERE id=$1",[job.id]);
   await client.query('BEGIN');expect((await client.query('SELECT now()<lease_until AS valid FROM project_learning_analyses WHERE id=$1',[job.id])).rows[0].valid).toBe(true);
   await client.query('SELECT pg_sleep(0.25)');await expect(repository.authorizeLease(client,row!)).rejects.toThrow('Аренда');
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('skips a live committing learning transaction during expired recovery',async()=>{
  const job=await create(),row=await repository.claim(randomUUID()),entered=deferred<void>(),release=deferred<void>();
  await pool.query("UPDATE project_learning_analyses SET lease_until=clock_timestamp()+interval '0.2 seconds' WHERE id=$1",[job.id]);
  const body=JSON.parse((await resultFor()).message.content);
  const commit=learning.recordAnalysis(request,projectId,{requestKey:row!.mutation_key,expectedRevision:job.sourceRevision,hypotheses:body.hypotheses,model:{modelId:job.modelId,modelPin:job.modelPin,analysisId:job.id}},async db=>{await repository.authorizeResult(db,row!);entered.resolve();await release.promise;});
  try{await entered.promise;await pool.query('SELECT pg_sleep(0.25)');await repository.recoverExpired();expect((await repository.get(projectId,job.id)).state).toBe('running');}
  finally{release.resolve();await commit;}
  await repository.recoverExpired();expect((await repository.get(projectId,job.id)).state).toBe('completed');expect(modelCalls).toBe(0);
 });
 it('rejects unassignment and reassignment of the same model pin during inference',async()=>{
  const job=await create(),started=deferred<void>(),reply=deferred<Record<string,unknown>>();infer.mockImplementationOnce(async()=>{modelCalls++;started.resolve();return reply.promise;});
  const running=worker().work();await started.promise;await pool.query('DELETE FROM project_models WHERE project_id=$1 AND model_id=$2',[projectId,model.id]);
  await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[projectId,model.id,main.email]);reply.resolve(await resultFor());await running;
  expect((await service.get(request,projectId,job.id)).error?.code).toBe('SOURCE_CHANGED');expect(await count('project_learning_hypotheses')).toBe(0);
 });
 it('locks and rechecks model assignment inside the final hypothesis transaction',async()=>{
  const job=await create(),record=learning.recordAnalysis.bind(learning);
  vi.spyOn(learning,'recordAnalysis').mockImplementationOnce(async(...args)=>{await pool.query('DELETE FROM project_models WHERE project_id=$1 AND model_id=$2',[projectId,model.id]);return record(...args);});
  await worker().work();expect((await service.get(request,projectId,job.id)).error?.code).toBe('ACCESS_CHANGED');expect(await count('project_learning_hypotheses')).toBe(0);
 });
 it('does not run a queued analysis after account revocation',async()=>{
  const job=await create();await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[main.email]);await worker().work();
  expect((await repository.get(projectId,job.id)).state).toBe('failed');expect(modelCalls).toBe(0);
 });
 it('enforces provenance/terminal immutability and detects a weakened physical schema',async()=>{
  const job=await create();await expect(pool.query("UPDATE project_learning_analyses SET model_pin=$2 WHERE id=$1",[job.id,'b'.repeat(64)])).rejects.toThrow('immutable');
  await expect(pool.query('DELETE FROM project_learning_analyses WHERE id=$1',[job.id])).rejects.toThrow('immutable');await worker().work();
  await expect(pool.query("UPDATE project_learning_analyses SET state='queued',finished_at=NULL,hypothesis_ids='[]'::jsonb WHERE id=$1",[job.id])).rejects.toThrow('cannot restart');
  await assertLearningAnalysisSchema(pool);const client=await pool.connect();try{await client.query('BEGIN');await client.query('DROP INDEX project_learning_one_analysis');await expect(assertLearningAnalysisSchema(client)).rejects.toThrow('не готова');await client.query('ROLLBACK');}finally{client.release();}
 });
 it('blocks retirement while analysis is queued and permits terminal job cascade cleanup',async()=>{
  const job=await create();const client=await pool.connect();try{await expect(requireRetirementIdle(client,projectId)).rejects.toThrow('Анализ');}finally{client.release();}
  await worker().work();await pool.query('DELETE FROM projects WHERE id=$1',[projectId]);expect(await count('project_learning_analyses')).toBe(0);expect(await count('project_learning_hypotheses')).toBe(0);expect(job.projectId).toBe(projectId);
 });
});
