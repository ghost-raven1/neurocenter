import {describe,expect,it,vi} from 'vitest';
import {ConflictException} from '@nestjs/common';
import {SystemRoleRunner} from '../src/system-roles/system-role.runner';
import {roleCallBudget,roleDefinitionPin} from '../src/system-roles/system-role.definitions';
import {currentModelUsage} from '../src/model-usage/model-usage.context';
import {normalizeRoleMcpTool,roleMcpToolKey,type RoleMcpReceipt} from '../../shared/system-role-mcp.cjs';
import type {RoleRunRow} from '../src/system-roles/system-role.types';

const final={kind:'diagnosis',summary:'Saved tool evidence retained',answer:'The saved tool evidence remains available. New tools are unavailable. No changes were applied. Review the saved evidence and check the connection before a new explicit task.',findings:[],changes:[],nextSteps:[]};
function fixture(actor='owner@example.test',device=false){
 const target={runtime:device?'device':'server',assetId:'selected',version:1,manifest:'a'.repeat(64),
  ...(device?{deviceId:'00000000-0000-0000-0000-000000000002',bindingId:'binding',instanceId:'instance',configurationRevisions:[]}:{}),
  discoveryId:'00000000-0000-0000-0000-000000000003',tools:[]};
 const tool={...normalizeRoleMcpTool({name:'selected_action',description:'Selected fixture action',inputSchema:{type:'object',properties:{}}}),toolKey:roleMcpToolKey(target as never,'selected_action')};
 const selected={...target,tools:[{name:tool.name,schemaDigest:tool.schemaDigest}]};
 const selection={projectId:'project',instruction:'Inspect the explicitly selected target',diagnostics:[],targets:[],mcp:[selected]};
 const row={id:'00000000-0000-0000-0000-000000000001',agent_id:'agent-ai-admin',project_id:'project',actor,actor_role:'Главный админ',
  state:'running',phase:'queued',lease_token:'lease',calls_started:0,facts:[],result:null,
  request:{...selection,consentDigest:'digest',modelId:'server-model',expectedModelPin:'b'.repeat(64),expectedDefinitionPin:roleDefinitionPin('agent-ai-admin')},
  snapshot:{selection,definitionPin:roleDefinitionPin('agent-ai-admin'),consentDigest:'digest',targets:[],mcp:[{target:selected,tools:[tool]}],preview:JSON.stringify({instruction:selection.instruction,mcp:[{tools:[tool]}]})}}as unknown as RoleRunRow;
 const control={available:true,role:true,flipAfterTool:true,terminalFromPlanning:false,offAfterPlanning:false,waitFirst:false};
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const physical:Array<{planning:boolean;messages:unknown;features:unknown}>=[];let attempts=0;
 const features=vi.fn(async()=>{if(!control.role)throw new Error('role feature disabled');});
 const model={id:'server-model',runtime:'ollama',capability:'chat',manifestSha256:'b'.repeat(64)};
 const policy={models:{pool:{query:async()=>({rows:[]})}},current:async()=>model};
 const targets={prepare:async()=>({consentDigest:'digest',targets:[]}),replacement:()=>{}};
 const repository={pool:{},fenced:async(_id:unknown,_lease:unknown,work:Function)=>{if(row.state!=='running')throw new ConflictException('lease fenced');return work({},row);},
  change:async(_db:unknown,current:RoleRunRow,state:RoleRunRow['state'],phase:string,_message:string,patch:unknown)=>Object.assign(current,{state,phase},patch),
  reserveCall:async(_id:unknown,_lease:unknown,authorize:Function)=>{await authorize({},row);if(row.calls_started>=roleCallBudget(row.agent_id,true))throw new Error('call budget');row.calls_started++;return row;}};
 const mcp={canContinueTools:vi.fn(async()=>control.available),close:vi.fn(async()=>{}),
  call:vi.fn(async():Promise<RoleMcpReceipt>=>{if(control.flipAfterTool)control.available=false;return {id:'receipt',toolKey:tool.toolKey,name:tool.name,state:'succeeded',message:'Saved',at:'2026-10-25',output:{text:'KNOWN_SAVED_EVIDENCE',isError:false,truncated:false}};})};
 const infer=vi.fn(async(_model:unknown,_endpoint:unknown,body:{messages:Array<{role:string;content:string}>})=>{
  const attempt=attempts++;if(control.waitFirst&&attempt===0){entered();await waiting;}
  const usage=currentModelUsage();await usage.beforeInference?.();await usage.beforeDispatch?.();
  const planning=body.messages.some(message=>message.role==='system'&&message.content.includes('Когда нужен инструмент'));
  physical.push({planning,messages:body.messages,features:usage.requiredFeatures});
  let content=JSON.stringify(final);
  if(attempt===0&&planning){
   if(control.terminalFromPlanning)control.available=false;
   else {content=JSON.stringify({kind:'tool',toolKey:tool.toolKey,arguments:{}});if(control.offAfterPlanning)control.available=false;}
  }
  return {done_reason:'stop',message:{role:'assistant',content}};
 });
 const runner=new SystemRoleRunner(repository as never,policy as never,targets as never,{infer},async()=>{},features,async()=>undefined as never,mcp as never);
 return {row,control,physical,mcp,infer,started,release,run:()=>runner.run({}as never,row,new AbortController().signal)};
}

describe('MCP finish-only transition preserves ordinary role finalization',()=>{
 it('retains a tool result after OFF and performs one plain final response without another tool-planning inference',async()=>{
  const f=fixture();await f.run();expect(f.row).toMatchObject({state:'succeeded',result:final});expect(f.mcp.call).toHaveBeenCalledOnce();
  expect(f.physical.map(call=>call.planning)).toEqual([true,false]);expect(JSON.stringify(f.physical[1].messages)).toContain('KNOWN_SAVED_EVIDENCE');
  expect(JSON.stringify(f.physical[1].messages)).not.toContain('Явно выбранные возможности MCP');expect(f.mcp.close).toHaveBeenCalledOnce();
 });
 it('switches to a plain finish when OFF occurs while tool planning waits for model admission, before physical dispatch',async()=>{
  const f=fixture();f.control.waitFirst=true;const running=f.run();await f.started;f.control.available=false;f.release();await running;
  expect(f.infer).toHaveBeenCalledTimes(2);expect(f.physical.map(call=>call.planning)).toEqual([false]);expect(f.mcp.call).not.toHaveBeenCalled();
  expect(f.row).toMatchObject({state:'succeeded',result:final});expect(f.row.calls_started).toBeLessThanOrEqual(roleCallBudget('agent-ai-admin',true));
 });
 it('retains an already dispatched terminal model result when only MCP availability changes',async()=>{
  const f=fixture();f.control.terminalFromPlanning=true;await f.run();expect(f.physical).toHaveLength(1);expect(f.row.result).toEqual(final);expect(f.mcp.call).not.toHaveBeenCalled();
 });
 it('does not execute a tool chosen by an already dispatched model response after OFF',async()=>{
  const f=fixture();f.control.offAfterPlanning=true;await f.run();expect(f.physical.map(call=>call.planning)).toEqual([true,false]);
  expect(f.mcp.call).not.toHaveBeenCalled();expect(f.row.result).toEqual(final);
 });
 it('keeps role/source admission authoritative even when MCP has transitioned to finish-only',async()=>{
  const f=fixture();f.mcp.call.mockImplementation(async()=>{f.control.role=false;f.control.available=false;return {id:'receipt',toolKey:'key',name:'selected_action',state:'succeeded',message:'Saved',at:'2026-10-25'};});
  await expect(f.run()).rejects.toThrow('role feature disabled');expect(f.physical).toHaveLength(1);expect(f.row.result).toBeNull();
 });
 it('isolates unavailable MCP from a different actor and from a server model with a device tool target',async()=>{
  const unavailable=fixture('first@example.test',true),available=fixture('second@example.test');unavailable.control.available=false;available.control.flipAfterTool=false;
  await Promise.all([unavailable.run(),available.run()]);expect(unavailable.physical.map(call=>call.planning)).toEqual([false]);
  expect(unavailable.mcp.call).not.toHaveBeenCalled();expect(unavailable.physical[0].features).toEqual(['system_ai_admin']);
  expect(available.mcp.call).toHaveBeenCalledOnce();expect(available.row.state).toBe('succeeded');expect(unavailable.row.state).toBe('succeeded');
 });
 it('does not reclassify an authority failure as local tool unavailability or buy a plain response',async()=>{
  const f=fixture();f.mcp.canContinueTools.mockRejectedValue(new Error('authority revoked'));
  await expect(f.run()).rejects.toThrow('authority revoked');expect(f.infer).not.toHaveBeenCalled();expect(f.mcp.call).not.toHaveBeenCalled();
 });
});
