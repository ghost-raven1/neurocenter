import {afterEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {DeviceCodexService} from '../src/models/device-codex.service';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {DEVICE_CODEX_PROTOCOL} from '../../shared/device-codex-inference.cjs';
import type {IModel} from '../src/models/model.types';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
afterEach(()=>vi.restoreAllMocks());
/** Actual context/authorization/dispatch methods with controlled SQL responses; no live database or native worker. */
function fixture(dispatched=false){
 const model:IModel={id:'model-codex',name:'Codex',description:'',runtime:'device-codex',capability:'chat',model:'codex',modelVersion:'codex',
  manifestSha256:null,verificationSha256:'b'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:''};
 const jobId='00000000-0000-0000-0000-000000000001',callId='00000000-0000-0000-0000-000000000002',lease='00000000-0000-0000-0000-000000000003';
 const device={id:'00000000-0000-0000-0000-000000000004',email:'owner@example.test'};
 const payload={protocol:DEVICE_CODEX_PROTOCOL,callId,modelId:model.id,modelPin:projectEmbeddingPin(model),connectionRevision:1,source:{scope:'global'},
  deadlineAt:new Date(Date.now()+60000).toISOString(),dispatchOnlyFeatures:['system_role_mcp','tool_catalog']};
 const call={id:callId,job_id:jobId,model_id:model.id,device_id:device.id,owner_email:device.email,actor_role:'Главный админ',project_id:null,
  model_pin:payload.modelPin,connection_revision:1,deadline_at:new Date(payload.deadlineAt),state:'running',lease,payload,
  dispatched_at:dispatched?new Date():null,cancelled_at:null,result:null,required_features:['device_codex_inference','system_ai_admin']};
 let writes=0;
 const query=vi.fn(async(sql:string)=>{
  if(sql.startsWith('SELECT c.*,j.state'))return {rows:[call],rowCount:1};
  if(sql.startsWith('UPDATE device_model_calls c SET dispatched_at')){writes++;return {rows:[{id:callId}],rowCount:1};}
  return {rows:[{id:jobId}],rowCount:1};
 });
 const models={pool:{query,connect:async()=>({query,release:vi.fn()})},get:async()=>model};
 const service=new DeviceCodexService(models as never,{}as never,{}as never,{}as never);
 const connections=(service as unknown as {connections:{read:()=>Promise<unknown>;assertCurrent:()=>Promise<unknown>}}).connections;
 vi.spyOn(connections,'read').mockResolvedValue({revision:1,source:payload.source});vi.spyOn(connections,'assertCurrent').mockResolvedValue({});
 const features=vi.mocked(requireFeaturesEnabled);features.mockImplementation(async keys=>{if(keys.includes('system_role_mcp'))throw new ForbiddenException('MCP off');});
 return {service,device,jobId,callId,lease,features,writes:()=>writes};
}

describe('Durable Codex dispatch-only feature fences',()=>{
 it.each(['context','authorize','dispatch'] as const)('blocks queued planning %s after OFF before a physical marker',async action=>{
  const f=fixture();const pending=action==='context'?f.service.context(f.device as never,{jobId:f.jobId,lease:f.lease}):action==='authorize'?
   f.service.authorizeJob(f.device as never,{id:f.jobId,kind:'infer-device-codex',lease:f.lease}):f.service.dispatch(f.device as never,{jobId:f.jobId,lease:f.lease,callId:f.callId});
  await expect(pending).rejects.toThrow('MCP off');expect(f.writes()).toBe(0);
 });
 it('does not reinterpret dispatch-only OFF as revoked ongoing authority after the marker',async()=>{
  const f=fixture(true);await expect(f.service.authorizeJob(f.device as never,{id:f.jobId,kind:'infer-device-codex',lease:f.lease})).resolves.toBeUndefined();
  expect(f.features).toHaveBeenCalledWith(['device_codex_inference','system_ai_admin']);expect(f.writes()).toBe(0);
 });
 it('keeps the model and role feature fences after dispatch',async()=>{
  const f=fixture(true);f.features.mockImplementation(async keys=>{if(keys.includes('device_codex_inference'))throw new ForbiddenException('Codex off');});
  await expect(f.service.authorizeJob(f.device as never,{id:f.jobId,kind:'infer-device-codex',lease:f.lease})).rejects.toThrow('Codex off');expect(f.writes()).toBe(0);
 });
});
