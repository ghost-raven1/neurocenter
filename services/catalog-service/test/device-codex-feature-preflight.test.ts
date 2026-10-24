import {afterEach,describe,expect,it,vi} from 'vitest';
import {DeviceCodexService} from '../src/models/device-codex.service';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import {DEVICE_CODEX_PROTOCOL} from '../../shared/device-codex-inference.cjs';
import type {IModel} from '../src/models/model.types';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
afterEach(()=>vi.restoreAllMocks());
const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};

/** Real service transaction boundaries with a controlled feature transport and SQL/authority ports; no live database. */
function fixture(action:'dispatch'|'enqueue'|'authorize'){
 const model:IModel={id:'model-codex',name:'Codex',description:'',runtime:'device-codex',capability:'chat',model:'codex',modelVersion:'codex',
  manifestSha256:null,verificationSha256:'b'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:''};
 let jobId='00000000-0000-0000-0000-000000000001',callId='00000000-0000-0000-0000-000000000002';
 const lease='00000000-0000-0000-0000-000000000003',device={id:'00000000-0000-0000-0000-000000000004',email:'owner@example.test'};
 const payload={protocol:DEVICE_CODEX_PROTOCOL,callId,modelId:model.id,modelPin:projectEmbeddingPin(model),connectionRevision:1,source:{scope:'global'},deadlineAt:new Date(Date.now()+60000).toISOString()};
 const response={model:model.model,done:true,done_reason:'stop',message:{role:'assistant',content:'Saved answer'},prompt_eval_count:1,eval_count:2,usage_reported:true};
 const call={id:callId,job_id:jobId,model_id:model.id,device_id:device.id,owner_email:device.email,actor_role:'Главный админ',project_id:null,
  model_pin:payload.modelPin,connection_revision:1,deadline_at:new Date(payload.deadlineAt),state:'running',lease,payload,dispatched_at:null as Date|null,cancelled_at:null,result:null as unknown,
  required_features:['device_codex_inference']};
 const control={transaction:false,revoked:false,jobs:0,markers:0},started=deferred(),held=deferred();let featureCalls=0,heldInsideTransaction:boolean|undefined;
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
  if(sql==='BEGIN')control.transaction=true;if(sql==='COMMIT'||sql==='ROLLBACK')control.transaction=false;
  if(sql.startsWith('INSERT INTO bridge_jobs')){control.jobs++;jobId=String(args[0]);}
  if(sql.startsWith('INSERT INTO device_model_calls'))callId=String(args[0]);
  if(sql.startsWith('UPDATE device_model_calls c SET dispatched_at')){control.markers++;return {rows:[{id:callId}],rowCount:1};}
  if(sql.startsWith('SELECT c.*,j.state'))return {rows:[structuredClone({...call,id:callId,job_id:jobId,...(action==='enqueue'?{dispatched_at:new Date(),result:{protocol:DEVICE_CODEX_PROTOCOL,callId,response}}:{})})],rowCount:1};
  return {rows:[{id:jobId}],rowCount:1};
 });
 const models={pool:{query,connect:async()=>({query,release:vi.fn()})},get:async()=>model};
 const service=new DeviceCodexService(models as never,{}as never,{}as never,{run:async(_model:unknown,_signal:unknown,work:()=>Promise<unknown>)=>work()}as never);
 const connections=(service as unknown as {connections:{read:()=>Promise<unknown>;assertCurrent:(...args:unknown[])=>Promise<unknown>}}).connections;
 vi.spyOn(connections,'read').mockResolvedValue({model_id:model.id,device_id:device.id,revision:1,source:payload.source,options:{store:false}});
 const authority=vi.spyOn(connections,'assertCurrent').mockImplementation(async(...args)=>{if(args[4]&&control.revoked)throw new Error('current model/binding authority revoked');return {};});
 const features=vi.mocked(requireFeaturesEnabled);features.mockImplementation(async keys=>{
  if(!keys.includes('device_codex_inference'))return;
  if(++featureCalls===(action==='enqueue'?2:1)){heldInsideTransaction=control.transaction;started.release();await held.promise;}
 });
 const run=()=>action==='dispatch'?service.dispatch(device as never,{jobId,lease,callId}):action==='authorize'?
  service.authorizeJob(device as never,{id:jobId,kind:'infer-device-codex',lease}):
  withModelUsage({purpose:'direct',actorEmail:device.email,actorRole:'Главный админ'},()=>service.infer(model,'chat',{messages:[{role:'user',content:'Question'}]}));
 return {run,control,authority,features,started:started.promise,release:held.release,heldInsideTransaction:()=>heldInsideTransaction};
}

describe('Global feature availability never waits under a Codex transaction',()=>{
 it.each(['dispatch','enqueue']as const)('holds %s feature preflight before acquiring a transactional connection',async action=>{
  const f=fixture(action),pending=f.run();void pending.catch(()=>undefined);
  try{await f.started;const held=f.heldInsideTransaction();f.release();await pending;expect(held).toBe(false);}
  finally{f.release();await pending.catch(()=>undefined);}
 });
 it.each(['dispatch','enqueue']as const)('rechecks current model/binding authority after held %s flags return',async action=>{
  const f=fixture(action),pending=f.run(),outcome=pending.catch(error=>error);
  try{await f.started;f.control.revoked=true;f.release();expect(await outcome).toMatchObject({message:'current model/binding authority revoked'});
   expect(f.control.jobs).toBe(0);expect(f.control.markers).toBe(0);}
  finally{f.release();await pending.catch(()=>undefined);}
 });
 it('keeps ongoing authorization feature checks outside a transaction',async()=>{
  const f=fixture('authorize'),pending=f.run();void pending.catch(()=>undefined);
  try{await f.started;f.release();await pending;expect(f.heldInsideTransaction()).toBe(false);expect(f.features).toHaveBeenCalledWith(['device_codex_inference']);}
  finally{f.release();await pending.catch(()=>undefined);}
 });
});
