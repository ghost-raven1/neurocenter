import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceCodexService} from '../src/models/device-codex.service';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {SystemRoleRunner} from '../src/system-roles/system-role.runner';
import {roleDefinitionPin} from '../src/system-roles/system-role.definitions';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {DEVICE_CODEX_PROTOCOL} from '../../shared/device-codex-inference.cjs';
import {normalizeRoleMcpTool,roleMcpToolKey} from '../../shared/system-role-mcp.cjs';
import type {IModel} from '../src/models/model.types';
import type {RoleRunRow} from '../src/system-roles/system-role.types';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
beforeEach(()=>{
 const flags={...defaultFeatureFlags(),system_ai_admin:true,codex_connector:true,device_codex_inference:true};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags(flags)))));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const final={kind:'diagnosis',summary:'Already dispatched Codex answer retained',findings:[],changes:[],nextSteps:[]};

/** Real DeviceCodex polling/admission and role runner; the database/device authority boundary is controlled. */
function fixture(mode:'dispatched'|'queued'|'dispatch-wins'|'stop-unknown'|'old-bridge'|'worker-denied'|'human-cancel'='dispatched'){
 const model:IModel={id:'model-codex',name:'Codex',description:'',runtime:'device-codex',capability:'chat',model:'codex',modelVersion:'codex',
  manifestSha256:null,verificationSha256:'b'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:''};
 const target={runtime:'server' as const,assetId:'selected',version:1,manifest:'a'.repeat(64),discoveryId:'00000000-0000-0000-0000-000000000003',tools:[]};
 const tool={...normalizeRoleMcpTool({name:'selected_action',inputSchema:{type:'object'}}),toolKey:roleMcpToolKey(target,'selected_action')};
 const selected={...target,tools:[{name:tool.name,schemaDigest:tool.schemaDigest}]};
 const selection={projectId:'project',instruction:'Inspect accepted context',diagnostics:[],targets:[],mcp:[selected]};
 const row={id:'00000000-0000-0000-0000-000000000001',agent_id:'agent-ai-admin',project_id:'project',actor:'owner@example.test',actor_role:'Главный админ',
  state:'running',phase:'queued',lease_token:'lease',calls_started:0,result:null,facts:[],
  request:{...selection,consentDigest:'digest',expectedDefinitionPin:roleDefinitionPin('agent-ai-admin'),modelId:model.id,expectedModelPin:projectEmbeddingPin(model)},
  snapshot:{selection,consentDigest:'digest',definitionPin:roleDefinitionPin('agent-ai-admin'),preview:'Accepted context',targets:[],mcp:[{target:selected,tools:[tool]}]}}as unknown as RoleRunRow;
 const control={available:true,polls:0};let jobId='',callId='',cancelProof=false;const enqueued:string[]=[],cancelled:string[]=[],payloads:Record<string,unknown>[]=[],messages:string[]=[];
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
  if(sql.startsWith('INSERT INTO bridge_jobs')){jobId=String(args[0]);enqueued.push(jobId);payloads.push(JSON.parse(String(args[6])));}
  if(sql.startsWith('INSERT INTO device_model_calls'))callId=String(args[0]);
  if(sql.startsWith('UPDATE device_model_calls SET cancelled_at'))cancelled.push(String(args[0]));
  if(sql.startsWith('SELECT id,kind,state,project_id,email,message FROM bridge_jobs'))return {rows:[{id:jobId,kind:'infer-device-codex',state:mode==='worker-denied'?'failed':mode==='human-cancel'?'cancelled':'running',project_id:row.project_id,email:row.actor}]};
  if(sql.startsWith('SELECT dispatched_at,result,cancelled_at FROM device_model_calls')){
   if(mode==='stop-unknown')throw new Error('unknown cancellation acknowledgement');
   cancelProof=true;return {rows:[{dispatched_at:mode==='dispatch-wins'?new Date():null,result:mode==='worker-denied'?{protocol:DEVICE_CODEX_PROTOCOL,callId,error:{code:'authorization'}}:null,cancelled_at:null}]};
  }
  if(sql.startsWith('SELECT c.*,j.state')){
   const first=control.polls++===0;control.available=false;
   return {rows:[{id:callId,job_id:jobId,model_id:model.id,device_id:'device',owner_email:row.actor,actor_role:row.actor_role,project_id:row.project_id,
    model_pin:projectEmbeddingPin(model),connection_revision:1,deadline_at:new Date(Date.now()+60000),state:first&&mode==='worker-denied'?'failed':'running',lease:'lease',dispatched_at:first&&mode!=='dispatched'?null:new Date(Date.now()-10),cancelled_at:first&&mode==='human-cancel'?new Date():null,
    result:first?(mode==='worker-denied'?{protocol:DEVICE_CODEX_PROTOCOL,callId,error:{code:'authorization'}}:null):{protocol:DEVICE_CODEX_PROTOCOL,callId,response:{done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(final)}}}}]};
  }
  return {rows:[],rowCount:1};
 });
 const models={pool:{query,connect:async()=>({query,release:vi.fn()})},get:vi.fn(async()=>model)};
 const admission=new ModelApiAdmission({acquire:vi.fn(async(_model,_signal,beforeAttempt)=>beforeAttempt())}as never);
 const device=new DeviceCodexService(models as never,{}as never,{}as never,admission);
 const connections=(device as unknown as {connections:{read:()=>Promise<unknown>;assertCurrent:()=>Promise<unknown>}}).connections;
 vi.spyOn(connections,'read').mockResolvedValue({model_id:model.id,device_id:'device',revision:1,source:{scope:'global'},options:{store:false}});
 vi.spyOn(connections,'assertCurrent').mockResolvedValue({report:{capabilities:mode==='old-bridge'?['device-codex-inference-v1']:['device-codex-inference-v1','device-codex-dispatch-features-v1']}});
 const pollAuthority=vi.spyOn(device as unknown as {assertCall:()=>Promise<void>},'assertCall').mockResolvedValue(undefined);
 const cancel=vi.spyOn(device,'cancel');
 const repository={pool:{},fenced:async(_id:unknown,_lease:unknown,work:Function)=>work({},row),
  change:async(_db:unknown,current:RoleRunRow,state:RoleRunRow['state'],phase:string,message:string,patch:unknown)=>{messages.push(message);return Object.assign(current,{state,phase},patch);},
  reserveCall:async(_id:unknown,_lease:unknown,authorize:Function)=>{await authorize({},row);row.calls_started++;return row;}};
 const policy={models,current:vi.fn(async()=>model)},targets={prepare:async()=>({consentDigest:'digest',targets:[]}),replacement:()=>{}};
 const mcp={canContinueTools:vi.fn(async()=>control.available),call:vi.fn(),close:vi.fn(async()=>{})};
 const infer=vi.fn(device.infer.bind(device));
 const runner=new SystemRoleRunner(repository as never,policy as never,targets as never,{infer},async()=>{},async()=>{},async()=>undefined as never,mcp as never);
 return {row,enqueued,cancelled,payloads,messages,pollAuthority,cancel,mcp,infer,cancelProof:()=>cancelProof,run:()=>runner.run({}as never,row,new AbortController().signal)};
}

describe('MCP planning admission is distinct from already dispatched Codex polling',()=>{
 it('retains the first delayed paid output after MCP OFF without cancelling or enqueueing another call',async()=>{
  const f=fixture();await f.run();expect(f.row).toMatchObject({state:'succeeded',result:final,calls_started:1});
  expect(f.enqueued).toHaveLength(1);expect(f.cancel).not.toHaveBeenCalled();expect(f.cancelled).toHaveLength(0);expect(f.infer).toHaveBeenCalledOnce();expect(f.pollAuthority).toHaveBeenCalled();expect(f.mcp.call).not.toHaveBeenCalled();
 });
 it('allows a plain finish only after locked cancellation proves a queued planning request was never dispatched',async()=>{
  const f=fixture('queued');await f.run();expect(f.row.result).toEqual(final);expect(f.cancelProof()).toBe(true);
  expect(f.enqueued).toHaveLength(2);expect(f.cancelled).toHaveLength(1);expect(f.infer).toHaveBeenCalledTimes(2);
  expect(f.payloads[0].dispatchOnlyFeatures).toEqual(['system_role_mcp','tool_catalog']);expect(f.payloads[1]).not.toHaveProperty('dispatchOnlyFeatures');
 });
 it('keeps the first response when native dispatch wins the race with a pre-dispatch cancellation',async()=>{
  const f=fixture('dispatch-wins');await f.run();expect(f.cancelProof()).toBe(true);expect(f.row.result).toEqual(final);
  expect(f.enqueued).toHaveLength(1);expect(f.cancelled).toHaveLength(0);expect(f.infer).toHaveBeenCalledOnce();
 });
 it('does not buy a new response after an unknown cancellation acknowledgement',async()=>{
  const f=fixture('stop-unknown');await expect(f.run()).rejects.toThrow('unknown cancellation acknowledgement');
  expect(f.enqueued).toHaveLength(1);expect(f.infer).toHaveBeenCalledOnce();expect(f.row.result).toBeNull();
 });
 it('accepts a terminal worker denial as no-dispatch proof without overwriting its receipt',async()=>{
  const f=fixture('worker-denied');await f.run();expect(f.row.result).toEqual(final);expect(f.cancelProof()).toBe(true);
  expect(f.enqueued).toHaveLength(2);expect(f.cancelled).toHaveLength(0);
 });
 it('does not reinterpret a human cancellation as permission for another model call',async()=>{
  const f=fixture('human-cancel');await expect(f.run()).rejects.toThrow('отменён');expect(f.enqueued).toHaveLength(1);expect(f.infer).toHaveBeenCalledOnce();expect(f.row.result).toBeNull();
 });
 it('keeps the legacy payload for an old bridge and explains that tool planning requires an update before enqueueing',async()=>{
  const f=fixture('old-bridge');await f.run();expect(f.row.result).toEqual(final);expect(f.enqueued).toHaveLength(1);
  expect(f.payloads[0]).not.toHaveProperty('dispatchOnlyFeatures');expect(JSON.stringify(f.infer.mock.calls[1][2])).toContain('Обновите');expect(f.messages.some(message=>message.includes('Обновите'))).toBe(true);
 });
});
