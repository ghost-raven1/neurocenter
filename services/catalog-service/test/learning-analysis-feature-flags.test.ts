import 'reflect-metadata';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {LearningAnalysisService} from '../src/learning/learning-analysis.service';
import type {LearningService} from '../src/learning/learning.service';
import type {ModelsService} from '../src/models/models.service';
import type {IModel} from '../src/models/model.types';
import type {AnalysisRow} from '../src/learning/learning-analysis.types';
import {analysisRequestHash} from '../src/learning/learning-analysis.repository';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {requiredFeatureFlags} from '../../api-gateway/src/features/feature-flag-gate';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn()}));
const instances:LearningAnalysisService[]=[];
const actor={email:'owner@example.test',activeRole:'Разработчик'},projectId='prj-learning-flags',req={headers:{}} as Request;
const model:IModel={id:'model-learning-flags',name:'QA',description:'QA',runtime:'ollama',capability:'chat',model:'qa:flags',manifestSha256:'a'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:''};
const denied=()=>new ForbiddenException('Функция «Хостинг моделей» отключена главным администратором.');
let enabled=true;
function fixture(){
 const experience={id:randomUUID(),projectId,title:'Наблюдение',summary:'Повторяемый тест выявил ошибку.',outcome:'failed',evidence:[{kind:'test',status:'failed',summary:'Тест упал.'}],context:{},origin:'human',device:null,createdBy:actor.email,createdAt:new Date().toISOString()};
 const input={requestKey:randomUUID(),expectedRevision:1,experienceIds:[experience.id],modelId:model.id},now=new Date();
 const row:AnalysisRow={id:randomUUID(),project_id:projectId,actor_email:actor.email,actor_role:actor.activeRole,request_key:input.requestKey,mutation_key:randomUUID(),request_hash:analysisRequestHash(projectId,input),model_epoch:randomUUID(),model_id:model.id,model_pin:projectEmbeddingPin(model),source_revision:1,input,experiences:[experience as never],state:'queued',hypothesis_ids:[],error_code:null,error_message:null,worker_id:randomUUID(),lease_until:new Date(Date.now()+120000),created_at:now,updated_at:now,started_at:null,finished_at:null};
 const models={actor:vi.fn(async()=>actor),resolveProject:vi.fn(async()=>({id:projectId})),getUsable:vi.fn(async()=>model)};
 const learning={analysisInput:vi.fn(async()=>({actor,projectId,revision:1,experiences:[experience]})),recordAnalysis:vi.fn(async(_req,_id,_input,authorize)=>{await authorize({});return {result:{hypotheses:[{id:randomUUID()}]}};})};
 const runtime={infer:vi.fn(async()=>({done:true,done_reason:'stop',message:{content:JSON.stringify({hypotheses:[{subject:'project',title:'Гипотеза',statement:'Ранний тест обнаруживает сбой.',rationale:'Есть отрицательный результат.',verificationPlan:'Повторить проверку до и после изменения.',experienceIds:input.experienceIds}]})}}))};
 const service=new LearningAnalysisService(learning as unknown as LearningService,models as unknown as ModelsService,runtime);instances.push(service);
 const repository=service.repository;
 vi.spyOn(repository,'byKey').mockResolvedValue(null);vi.spyOn(repository,'enqueue').mockResolvedValue(row);vi.spyOn(repository,'recoverExpired').mockResolvedValue();
 vi.spyOn(repository,'claim').mockImplementation(async()=>{if(row.state!=='queued')return null;row.state='running';return row;});
 vi.spyOn(repository,'current').mockResolvedValue();vi.spyOn(repository,'authorizeResult').mockResolvedValue();vi.spyOn(repository,'complete').mockImplementation(async()=>{row.state='completed';return true;});
 vi.spyOn(repository,'fail').mockImplementation(async(_row,state,code,message)=>{row.state=state;row.error_code=code;row.error_message=message;});vi.spyOn(repository,'reconcile').mockResolvedValue(false);
 return {service,repository,row,input,models,learning,runtime,work:()=> (service as unknown as {work():Promise<void>}).work()};
}
beforeEach(()=>{enabled=true;vi.mocked(requireFeaturesEnabled).mockImplementation(async()=>{if(!enabled)throw denied();});});
afterEach(async()=>{for(const service of instances.splice(0))await service.pool.end();vi.restoreAllMocks();vi.mocked(requireFeaturesEnabled).mockReset();});

describe('Learning analysis respects inference feature policy',()=>{
 it('gateway guards only new analyses and preserves status and recovery reads',()=>{
  expect(requiredFeatureFlags('POST',`/api/projects/${projectId}/learning/analyses`,{})).toEqual(['project_learning','model_hosting']);
  expect(requiredFeatureFlags('POST',`/api/projects/${projectId}/learning/%61nalyses/`,{})).toEqual(['project_learning','model_hosting']);
  for(const path of [`/api/projects/${projectId}/learning/analyses/${randomUUID()}`,`/api/projects/${projectId}/learning/analyses/requests/${randomUUID()}`])expect(requiredFeatureFlags('GET',path,undefined)).toEqual([]);
 });
 it('disabled flag rejects direct enqueue before reading expensive snapshots or calling a model',async()=>{
  const f=fixture();enabled=false;await expect(f.service.create(req,projectId,f.input)).rejects.toHaveProperty('status',403);
  expect(f.learning.analysisInput).not.toHaveBeenCalled();expect(f.repository.enqueue).not.toHaveBeenCalled();expect(f.runtime.infer).not.toHaveBeenCalled();
 });
 it('disable during snapshot preparation is rechecked immediately before enqueue',async()=>{
  const f=fixture(),snapshot=await f.learning.analysisInput();f.learning.analysisInput.mockImplementationOnce(async()=>{enabled=false;return snapshot;});
  await expect(f.service.create(req,projectId,f.input)).rejects.toHaveProperty('status',403);expect(f.repository.enqueue).not.toHaveBeenCalled();
 });
 it('a queued job cannot bypass a later disable, and re-enable never silently retries failed work',async()=>{
  const f=fixture();enabled=false;await f.work();expect(f.runtime.infer).not.toHaveBeenCalled();expect(f.row).toMatchObject({state:'failed',error_code:'FEATURE_DISABLED'});
  enabled=true;await f.work();expect(f.runtime.infer).not.toHaveBeenCalled();expect(f.learning.recordAnalysis).not.toHaveBeenCalled();
 });
 it('recovery of an existing request stays available while off without creating new work',async()=>{
  const f=fixture();enabled=false;vi.mocked(f.repository.byKey).mockResolvedValue(f.row);
  expect((await f.service.create(req,projectId,f.input)).id).toBe(f.row.id);expect(requireFeaturesEnabled).not.toHaveBeenCalled();expect(f.repository.enqueue).not.toHaveBeenCalled();
 });
 it('a completed paid call survives a later flag disable while ACL and source checks still run',async()=>{
  const f=fixture(),result=await f.runtime.infer();f.runtime.infer.mockClear();f.runtime.infer.mockImplementationOnce(async()=>{enabled=false;return result;});
  await f.work();expect(f.row.state).toBe('completed');expect(f.runtime.infer).toHaveBeenCalledOnce();expect(f.learning.recordAnalysis).toHaveBeenCalledOnce();expect(f.repository.authorizeResult).toHaveBeenCalledOnce();
  expect(requireFeaturesEnabled).toHaveBeenCalledOnce();
 });
 it('revoked project/model access after inference cannot publish hypotheses even if the flag is enabled',async()=>{
  const f=fixture();f.models.getUsable.mockResolvedValueOnce(model).mockRejectedValueOnce(new ForbiddenException('Доступ отозван'));
  await f.work();expect(f.runtime.infer).toHaveBeenCalledOnce();expect(f.learning.recordAnalysis).not.toHaveBeenCalled();expect(f.row.error_code).toBe('ACCESS_CHANGED');
 });
 it('a missing flag service never permits enqueue or a saved worker payload to infer',async()=>{
  const f=fixture();vi.mocked(requireFeaturesEnabled).mockRejectedValue(new ServiceUnavailableException('Флаги недоступны'));
  await expect(f.service.create(req,projectId,f.input)).rejects.toHaveProperty('status',503);await f.work();expect(f.runtime.infer).not.toHaveBeenCalled();expect(f.repository.enqueue).not.toHaveBeenCalled();
 });
 it('an explicit fresh request after re-enable can enqueue and infer once',async()=>{
  const f=fixture();enabled=false;await expect(f.service.create(req,projectId,f.input)).rejects.toThrow();enabled=true;
  expect((await f.service.create(req,projectId,f.input)).state).toBe('queued');await f.work();expect(f.runtime.infer).toHaveBeenCalledOnce();expect(f.row.state).toBe('completed');
 });
});
