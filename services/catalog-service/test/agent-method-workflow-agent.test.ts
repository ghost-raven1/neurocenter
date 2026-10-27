import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {createProjectAgentsPayload,compileProjectAgents,PROJECT_AGENTS_NOTE} from '../../shared/project-agents.cjs';
import {agentMethodWorkflowAgentIdentity} from '../../shared/agent-method-workflow.cjs';
import {agentManifest} from '../src/agents/agent-validation';
import {modelFromRow,type IModelRow} from '../src/models/model-history';
import type {Device} from '../src/devices/device-store';
import {agentMethodJobPayload,assertAgentMethodJob,assertAgentMethodResult,assertAgentMethodCompletionAccess} from '../src/agent-method-workflows/jobs';

const bindingId='a'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111',requestKey='22222222-2222-4222-8222-222222222222';
function fixture(){
 const definition={description:'Owned fixture',prompt:'Implement the accepted task.',mode:'primary' as const,permission:{read:'allow' as const,edit:'allow' as const,bash:'allow' as const},model:'neurocenter/model-owned'};
 const agent={id:'agent-owned',slug:'nc-owned',version:1,enabled:true,...definition};
 const model:IModelRow={id:'model-owned',name:'Owned model',descriptor:{description:'',runtime:'remote-openai',model:'owned-upstream',modelVersion:'v1',capability:'chat',source:'custom',dimension:null,manifestSha256:null,verificationSha256:'d'.repeat(64)},revision:1,created_at:new Date(0),updated_at:new Date(0),archived_at:null};
 const mapping={agentId:agent.id,provider:'owned',configKey:'native-alias',runtime:'remote-openai' as const,model:'owned-upstream',baseUrl:'http://127.0.0.1:19091/v1',options:{temperature:0},capability:'chat' as const};
 const desired=createProjectAgentsPayload({schemaVersion:2,projectId:'prj-owned',bindingId,instanceId,revision:1,agents:[agent],modelRequirements:[{kind:'catalog',agentId:agent.id,catalogModelId:model.id,modelPin:modelFromRow(model).modelPin!,runtime:'remote-openai',runtimeModel:mapping.model,baseUrl:mapping.baseUrl,options:mapping.options,capability:'chat'}]});
 const compilation=compileProjectAgents(desired,[mapping]),payload={...desired,compilation};
 const result={schemaVersion:2,projectId:'prj-owned',bindingId,instanceId,revision:1,manifestSha256:desired.manifestSha256,compiledManifestSha256:compilation.manifestSha256,agents:compilation.agents,changed:true,readiness:'configured',checkedAt:'2026-10-27T00:00:00.000Z',note:PROJECT_AGENTS_NOTE};
 const state={revision:1,enabled:true,removed:false,archived:false,modelUsable:true,connection:true,overrides:{} as Record<string,unknown>,delivery:{id:'33333333-3333-4333-8333-333333333333',state:'succeeded',payload,result},options:{temperature:0} as Record<string,number>};
 const device={id:'device-owned',email:'owner@fixture.test',role:'Админ проекта',report:{capabilities:['workspace-instance-v1','agent-method-workflow-v1','agent-method-selected-agent-v1'],bindings:[{projectId:'prj-owned',bindingId,instanceId,valid:true}]}} as unknown as Device;
 const query=vi.fn(async(sql:string)=>{
  let rows:unknown[];
  if(sql.includes('SELECT revision FROM project_agent_sets'))rows=[{revision:state.revision}];
  else if(sql.includes('SELECT s.revision'))rows=[{revision:state.revision,items:state.removed?[]:[{...agent,name:'Owned agent',definition,overrides:state.overrides,enabled:state.enabled,manifest:agentManifest({id:agent.id,slug:agent.slug,name:'Owned agent',version:agent.version,definition})}]}];
  else if(sql.includes('FROM agent_catalog WHERE'))rows=[{id:agent.id,archived_at:state.archived?'2026-10-27T00:00:00Z':null}];
  else if(sql.includes('FROM model_catalog'))rows=state.modelUsable?[model]:[];
  else if(sql.includes('FROM model_remote_connections'))rows=state.connection?[{base_url:mapping.baseUrl,options:state.options}]:[];
  else if(sql.includes('FROM bridge_jobs'))rows=[state.delivery];
  else if(sql.includes('FROM bridge_devices'))rows=[device];
  else if(sql.includes('FROM platform_users'))rows=[{enabled:true,is_main_admin:false}];
  else if(sql.includes('FROM project_members'))rows=[{role:'Админ проекта'}];
  else throw Error('Unexpected selected-agent fixture query: '+sql);
  return {rows,rowCount:rows.length};
 });
 const db={query} as unknown as PoolClient;
 const input={kind:'run-agent-method-workflow',projectId:'prj-owned',deviceId:device.id,requestKey,expectedBindingId:bindingId,expectedInstanceId:instanceId,
  workflow:{method:'openspec' as const,instruction:'Implement only the owned task.',checks:[{command:'npm',args:['test']}],agentId:agent.id,expectedAgentsRevision:1}};
 return {state,device,db,input,mapping,compilation,desired};
}

describe('selected project agent method execution authority',()=>{
 it('captures the exact approved native agent and model, never browser prompt or default model',async()=>{
  const f=fixture(),saved=await agentMethodJobPayload(f.device,f.input,f.db);
  expect(saved).toMatchObject({agent:{agentId:'agent-owned',slug:'nc-owned',version:1,mode:'primary',agentsRevision:1,agentsManifestSha256:f.desired.manifestSha256,
   compiledManifestSha256:f.compilation.manifestSha256,fileSha256:f.compilation.agents[0].sha256,configurationJobId:f.state.delivery.id,model:f.mapping}});
 });
 it('does not dispatch a removed, disabled, archived or non-primary agent',async()=>{
  for(const patch of [{removed:true},{enabled:false},{archived:true},{overrides:{mode:'subagent'}},{overrides:{model:null}}]){
   const f=fixture();Object.assign(f.state,patch);await expect(agentMethodJobPayload(f.device,f.input,f.db)).rejects.toThrow();
  }
 });
 it('rechecks fresh model access and the latest configuration delivery for an accepted job',async()=>{
  const f=fixture(),payload=await agentMethodJobPayload(f.device,f.input,f.db),job={kind:f.input.kind,project_id:f.input.projectId,payload:{...payload}};
  await expect(assertAgentMethodJob(f.device,job,f.db)).resolves.toBeUndefined();
  f.state.connection=false;await expect(assertAgentMethodJob(f.device,job,f.db)).rejects.toThrow();
  f.state.connection=true;f.state.delivery.state='queued';await expect(assertAgentMethodJob(f.device,job,f.db)).rejects.toThrow();
 });
 it('never downgrades incomplete selection, unsupported capability or missing server context to legacy execution',async()=>{
  const f=fixture();
  await expect(agentMethodJobPayload(f.device,{...f.input,workflow:{...f.input.workflow,agentId:undefined}},f.db)).rejects.toThrow();
  await expect(agentMethodJobPayload(f.device,{...f.input,workflow:{...f.input.workflow,expectedAgentsRevision:undefined}},f.db)).rejects.toThrow();
  await expect(agentMethodJobPayload(f.device,f.input)).rejects.toThrow();
  await expect(agentMethodJobPayload({...f.device,report:{...f.device.report,capabilities:['workspace-instance-v1','agent-method-workflow-v1']}},f.input,f.db)).rejects.toThrow();
  await expect(agentMethodJobPayload(f.device,{...f.input,workflow:{...f.input.workflow,prompt:'Forged browser profile'}} as never,f.db)).rejects.toThrow();
 });
 it.each(['removed-model','revoked-connection','model-options','profile-edit','disabled-agent','archived-agent','delivery-shadow','invalid-receipt','corrupt-compilation'])('blocks %s before another command or completion can be authorized',async reason=>{
  const f=fixture(),payload=(await agentMethodJobPayload(f.device,f.input,f.db))!,job={kind:f.input.kind,project_id:f.input.projectId,payload:{...payload}};
  if(reason==='removed-model')f.state.modelUsable=false;
  if(reason==='revoked-connection')f.state.connection=false;
  if(reason==='model-options')f.state.options={temperature:1};
  if(reason==='profile-edit'){f.state.overrides={prompt:'Updated desired task profile'};f.state.revision++;}
  if(reason==='disabled-agent')f.state.enabled=false;
  if(reason==='archived-agent')f.state.archived=true;
  if(reason==='delivery-shadow')f.state.delivery={...f.state.delivery,id:'44444444-4444-4444-8444-444444444444'};
  if(reason==='invalid-receipt')f.state.delivery.result={...f.state.delivery.result,compiledManifestSha256:'f'.repeat(64)};
  if(reason==='corrupt-compilation')f.state.delivery.payload.compilation.manifestSha256='f'.repeat(64);
  await expect(assertAgentMethodJob(f.device,job,f.db)).rejects.toThrow();
  await expect(assertAgentMethodCompletionAccess(f.db,{...job,device_id:f.device.id,email:f.device.email,role:f.device.role})).rejects.toThrow();
 });
 it('accepts only the original selected identity in the final result, excluding private model metadata',async()=>{
  const f=fixture(),payload=(await agentMethodJobPayload(f.device,f.input,f.db))!,job={kind:f.input.kind,project_id:f.input.projectId,payload:{...payload}};
  const result={protocol:'agent-method-workflow-v1',workflowId:requestKey,method:'openspec',methodVersion:'1.15.0',runtime:'opencode',state:'succeeded',stage:'completed',codeChanged:true,
   changes:[{path:'src/owned.ts',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64)}],artifacts:[],checks:[{command:'npm',args:['test'],exitCode:0,signal:null,state:'passed'}],agent:agentMethodWorkflowAgentIdentity(payload.agent)};
  expect(()=>assertAgentMethodResult(job,result,false)).not.toThrow();
  expect(()=>assertAgentMethodResult(job,{...result,agent:{...result.agent,agentId:'agent-another'}},false)).toThrow();
  expect(()=>assertAgentMethodResult(job,{...result,agent:payload.agent},false)).toThrow();
  expect(()=>assertAgentMethodResult(job,{...result,agent:undefined},false)).toThrow();
 });
});
