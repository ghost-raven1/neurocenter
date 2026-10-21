import 'reflect-metadata';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ExecutionContext} from '@nestjs/common';
import {defaultFeatureFlags,evaluateFeatureFlags,type FeatureFlagValues} from '../../shared/feature-flags.cjs';
import {ModelRuntime} from '../src/models/model-runtime';
import type {OllamaClient} from '../src/models/ollama-client';
import type {RemoteConnectionService} from '../src/models/remote-connection.service';
import type {ModelUsageService} from '../src/model-usage/model-usage.service';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import {FeaturePolicyGuard} from '../src/features/feature-policy.guard';
import {AssetImportWorker} from '../src/asset-sources/import-worker';
import {AgentsService} from '../src/agents/agents.service';
import {ProjectReindexService} from '../src/models/project-reindex.service';
import {SnapshotVerifier} from '../src/snapshots/snapshot-verifier';
import {RemoteConnectionService as RemoteService} from '../src/models/remote-connection.service';
import type {ModelsService} from '../src/models/models.service';
import type {IModel} from '../src/models/model.types';
import type {Pool,PoolClient} from 'pg';
import type {AssetImportRepository} from '../src/asset-sources/import-repository';
import type {IImportJob} from '../src/asset-sources/import-types';

let flags:FeatureFlagValues,fetch:ReturnType<typeof vi.fn>;
const model:IModel={id:'model-execution-flags',name:'QA',description:'',runtime:'ollama',capability:'chat',model:'qa:flags',dimension:null,manifestSha256:'a'.repeat(64),source:'custom',revision:1,createdAt:'',updatedAt:''};
beforeEach(()=>{flags=defaultFeatureFlags();fetch=vi.fn(async()=>Response.json(evaluateFeatureFlags(flags)));vi.stubGlobal('fetch',fetch);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','flags-execution-only');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
function runtime(){const local={infer:vi.fn(async()=>({message:{role:'assistant',content:'Paid answer'},done_reason:'stop'}))},remote={infer:vi.fn()},usage={observe:vi.fn(async(_model,_endpoint,action,signal)=>action(signal))};return {local,remote,usage,runtime:new ModelRuntime(local as unknown as OllamaClient,remote as unknown as RemoteConnectionService,usage as unknown as ModelUsageService)};}

describe('Fresh paid inference boundary',()=>{
 for(const [purpose,key]of [['chat','model_chat'],['agent','group_chat'],['compaction','model_chat'],['project-search','project_search'],['learning','project_learning'],['direct','model_hosting'],['verification','model_hosting']] as const)it(purpose+' cannot bypass '+key,async()=>{
  const f=runtime();flags[key]=false;
  await expect(withModelUsage({purpose},()=>f.runtime.infer(model,'chat',{}))).rejects.toHaveProperty('status',403);expect(f.local.infer).not.toHaveBeenCalled();expect(f.usage.observe).not.toHaveBeenCalled();
  flags[key]=true;await withModelUsage({purpose},()=>f.runtime.infer(model,'chat',{}));expect(f.local.infer).toHaveBeenCalledOnce();
 });
 it('An unavailable flags service cannot start a paid inference or ledger receipt',async()=>{const f=runtime();fetch.mockRejectedValue(Error('private-provider-secret'));await expect(f.runtime.infer(model,'chat',{})).rejects.toHaveProperty('status',503);expect(f.local.infer).not.toHaveBeenCalled();expect(f.usage.observe).not.toHaveBeenCalled();});
 it('A paid in-flight response is retained and the next call is blocked',async()=>{const f=runtime();f.local.infer.mockImplementationOnce(async()=>{flags.model_hosting=false;return {message:{role:'assistant',content:'Paid answer'},done_reason:'stop'};});expect(await f.runtime.infer(model,'chat',{})).toHaveProperty('message.content','Paid answer');await expect(f.runtime.infer(model,'chat',{})).rejects.toHaveProperty('status',403);expect(f.local.infer).toHaveBeenCalledOnce();});
 it('Nested retrieval retains the outer chat admission requirement',async()=>{const f=runtime();flags.group_chat=false;await expect(withModelUsage({purpose:'agent',requiredFeatures:['group_chat']},()=>withModelUsage({purpose:'project-search'},()=>f.runtime.infer(model,'embed',{})))).rejects.toHaveProperty('status',403);expect(f.local.infer).not.toHaveBeenCalled();});
 it('Usage report switch never disables mandatory operational recording',async()=>{const f=runtime();flags.model_usage=false;await f.runtime.infer(model,'chat',{});expect(f.usage.observe).toHaveBeenCalledOnce();});
 it('Already aborted work never dispatches',async()=>{const f=runtime(),abort=new AbortController();abort.abort();await expect(f.runtime.infer(model,'chat',{},abort.signal)).rejects.toBeDefined();expect(f.local.infer).not.toHaveBeenCalled();});
});

describe('Native API and saved worker boundaries',()=>{
 const guard=new FeaturePolicyGuard(),context=(method:string,path:string,body?:unknown,token='flags-execution-only')=>({switchToHttp:()=>({getRequest:()=>({method,path,body,headers:{'x-neurocenter-internal':token}})})}) as ExecutionContext;
 it('Native service repeats admission without relying on the browser or Gateway',async()=>{flags.agents=false;await expect(guard.canActivate(context('POST','/api/agents',{}))).rejects.toHaveProperty('status',403);flags.agents=true;await expect(guard.canActivate(context('POST','/api/agents',{}))).resolves.toBe(true);});
 it('Native recovery and historical reads work with no feature service',async()=>{fetch.mockRejectedValue(Error('offline'));for(const [method,path]of [['GET','/api/model-chats/id/history'],['DELETE','/api/agents/id'],['POST','/api/model-chats/id/turns/t/cancel'],['PATCH','/api/feature-flags/agents']])await expect(guard.canActivate(context(method,path))).resolves.toBe(true);expect(fetch).not.toHaveBeenCalled();});
 it('Native API authenticates the trusted transport before consulting feature service',async()=>{await expect(guard.canActivate(context('POST','/api/models',{},'wrong'))).rejects.toHaveProperty('status',403);expect(fetch).not.toHaveBeenCalled();});
 it('Saved imports cannot start preparation or downloads after asset_sources is disabled',async()=>{
  flags.asset_sources=false;const initial={id:'qa-import',actor:'owner',items:[],cancel_requested:false,state:'QUEUED'} as unknown as IImportJob;
  const jobs={get:vi.fn(async()=>initial),save:vi.fn(async(_client,job,state,message,items)=>({...job,state,message,items}))},sources={get:vi.fn()},blobs={importAsset:vi.fn()},client={query:vi.fn(async()=>({rows:[{enabled:true,is_main_admin:true}]}))};
  const worker=new AssetImportWorker({} as Pool,jobs as unknown as AssetImportRepository,sources as never,blobs as never,{} as never);
  await (worker as unknown as {process(job:IImportJob,client:PoolClient,signal:AbortSignal):Promise<void>}).process(initial,client as unknown as PoolClient,new AbortController().signal);
  expect(sources.get).not.toHaveBeenCalled();expect(blobs.importAsset).not.toHaveBeenCalled();expect(jobs.save).toHaveBeenCalledWith(client,initial,'FAILED',expect.stringContaining('отключена'),[]);
 });
 it('An external snapshot verifier cannot claim new work while disabled',async()=>{flags.project_snapshots=false;const query=vi.fn(async()=>({rows:[]})),repository={pool:{query}},verifier=new SnapshotVerifier({} as never,repository as never);await expect(verifier.claim({workerId:'f4d17a8b-e5ae-44ce-ae81-12723ab06217',sdkVersion:'0.29.0',imageDigest:'sha256:'+'a'.repeat(64)})).rejects.toHaveProperty('status',403);expect(query.mock.calls.some(([sql])=>String(sql).includes('SELECT * FROM project_snapshots'))).toBe(false);});
 it('Remote verification probes are gated before their external client is called',async()=>{flags.model_hosting=false;const service=new RemoteService({pool:{}} as ModelsService);vi.spyOn(service.repository,'head').mockResolvedValue({model_id:'remote',revision:1,base_url:'http://127.0.0.1:1/v1',credential_kind:'none',credential:null,credential_env:null,options:{},timeout_ms:90000,semantic_sha:null,verified_at:null,failure_message:null,revoked_at:null,request_dimensions:false});const infer=vi.spyOn((service as unknown as {client:{infer:()=>Promise<unknown>}}).client,'infer');await expect(service.check({...model,runtime:'remote-openai'},'owner',async()=>undefined)).rejects.toHaveProperty('status',403);expect(infer).not.toHaveBeenCalled();});
 it('Queued reindex preparation cannot start a new source operation while rag_sync is off',async()=>{
  flags.rag_sync=false;const query=vi.fn(async()=>({rows:[]})),models={resolveProject:vi.fn(async()=>({id:'p'})),pool:{query}},coordinator={client:{call:vi.fn()}};
  const service=new ProjectReindexService(models as never,coordinator as never,{} as never,{} as never),row={id:'r',project_id:'p',actor:'owner',active_role:'Разработчик',data:{context:{generation:null}}};
  await (service as unknown as {prepare(row:unknown):Promise<void>}).prepare(row);expect(coordinator.client.call).not.toHaveBeenCalled();expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE project_reindex_plans'),['r','failed',expect.any(String)]);
 });
 it('A saved reindex embedding request requires rag_sync even when model hosting remains enabled',async()=>{
  flags.rag_sync=false;const row={id:'r',project_id:'p',state:'building',approved:true,actor:'owner',active_role:'Разработчик',data:{profile:{model:'qa'},modelId:'m',modelPin:'a'.repeat(64)}},models={pool:{query:vi.fn(async()=>({rows:[row]}))},resolveProject:vi.fn(),isAssigned:vi.fn(async()=>true)},runtime={infer:vi.fn()};
  const service=new ProjectReindexService(models as never,{} as never,runtime as never,{} as never);await expect(service.embed({projectId:'p',planId:'r',profile:row.data.profile,input:['QA']})).rejects.toHaveProperty('status',403);expect(runtime.infer).not.toHaveBeenCalled();
 });

 it('Disabling an assigned agent remains available with its required idempotency key while agents is off',async()=>{
  flags.agents=false;const update=vi.fn(async()=>({ok:true})),access={actor:async()=>({email:'owner',activeRole:'Главный админ'}),resolveProject:async()=>({id:'p'})};
  const service=new AgentsService(access as never,{} as never);vi.spyOn(service.projects,'update').mockImplementation(update);vi.spyOn(service.pool,'end').mockResolvedValue();
  try{await service.configure({headers:{}} as never,'p','agent',{enabled:false,expectedRevision:1,requestKey:'9c9d082d-e349-4824-af61-6a3cac40fac4'});expect(update).toHaveBeenCalledOnce();expect(fetch.mock.calls.some(([url])=>String(url).includes('/internal/feature-flags'))).toBe(false);
   await expect(service.configure({headers:{}} as never,'p','agent',{enabled:false,expectedRevision:1,requestKey:'9c9d082d-e349-4824-af61-6a3cac40fac4',prompt:'new prompt'})).rejects.toHaveProperty('status',403);expect(update).toHaveBeenCalledOnce();
  }finally{await service.pool.end();}
 });

});
