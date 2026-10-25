import {describe,expect,it,vi} from 'vitest';
import {SystemRoleRunner} from '../src/system-roles/system-role.runner';
import {SystemRoleTargets} from '../src/system-roles/system-role.targets';
import {currentModelUsage} from '../src/model-usage/model-usage.context';
import {normalizeRoleMcpTool,roleMcpToolKey} from '../../shared/system-role-mcp.cjs';
import type {RoleRunRow,RoleSelection} from '../src/system-roles/system-role.types';

const final={kind:'diagnosis',summary:'Accepted evidence retained',findings:[],changes:[],nextSteps:[]};
/** Actual target preparation and runner checkpoints; domain authority is controlled without network or SQL. */
async function fixture(failure:string){
 const target={runtime:'server' as const,assetId:'selected',version:1,manifest:'a'.repeat(64),discoveryId:'00000000-0000-0000-0000-000000000003',tools:[]};
 const tool={...normalizeRoleMcpTool({name:'selected_action',inputSchema:{type:'object',properties:{}}}),toolKey:roleMcpToolKey(target,'selected_action')};
 const selected={...target,tools:[{name:tool.name,schemaDigest:tool.schemaDigest}]};
 const control={failed:false,secondTool:false,knownLoss:true},physical:boolean[]=[],model={id:'server-model',runtime:'ollama',capability:'chat',manifestSha256:'b'.repeat(64)};
 const actor={email:'owner@example.test',activeRole:'Главный админ'};
 const policy={actor:vi.fn(async()=>{if(control.failed&&failure==='actor')throw new Error('actor revoked');return actor;}),
  current:vi.fn(async()=>{if(control.failed&&['project','source','model'].includes(failure))throw new Error(failure+' revoked');return model;}),models:{pool:{query:async()=>({rows:[]})}}};
 const card={id:'selected-agent',version:1,definition:{prompt:'Accepted prompt'}},assignment={agentId:card.id,removed:false,card,effective:card.definition};
 const agents={list:vi.fn(async()=>({items:[card],assignments:[assignment],revision:control.failed&&failure==='non-MCP context'?2:1}))};
 let effects=0;
 const mcp={prepare:vi.fn(async()=>{if(control.failed&&failure.startsWith('MCP '))throw new Error(failure);return [{target:selected,tools:[tool]}];}),
  canContinueTools:vi.fn(async()=>!(control.knownLoss&&control.failed&&failure.startsWith('MCP '))),close:vi.fn(async()=>{}),call:vi.fn(async()=>{
   if(control.failed&&failure.startsWith('MCP '))throw new Error(failure);effects++;control.failed=true;
   return {id:'receipt',toolKey:tool.toolKey,name:tool.name,state:'succeeded' as const,message:'Saved',at:'2026-10-25',output:{text:'KNOWN_ACCEPTED_EVIDENCE',isError:false,truncated:false}};
  })};
 const targets=new SystemRoleTargets(policy as never,agents as never,{}as never,{}as never,undefined,undefined,mcp as never);
 const selection:RoleSelection={projectId:'project',instruction:'Inspect the accepted target',diagnostics:[],targets:[{kind:'agent',id:card.id}],mcp:[selected]};
 const snapshot=await targets.prepare({}as never,'agent-ai-admin',selection);
 const row={id:'00000000-0000-0000-0000-000000000001',agent_id:'agent-ai-admin',project_id:'project',actor:actor.email,actor_role:actor.activeRole,
  state:'running',phase:'queued',lease_token:'lease',calls_started:0,result:null,facts:[],snapshot,
  request:{...selection,consentDigest:snapshot.consentDigest,expectedDefinitionPin:snapshot.definitionPin,modelId:model.id,expectedModelPin:'b'.repeat(64)}}as unknown as RoleRunRow;
 const repository={pool:{},fenced:async(_id:unknown,_lease:unknown,work:Function)=>work({},row),
  change:async(_db:unknown,current:RoleRunRow,state:RoleRunRow['state'],phase:string,_message:string,patch:unknown)=>Object.assign(current,{state,phase},patch),
  reserveCall:async(_id:unknown,_lease:unknown,authorize:Function)=>{await authorize({},row);row.calls_started++;return row;}};
 const infer=vi.fn(async(_model:unknown,_endpoint:unknown,body:{messages:Array<{content:string}>})=>{
  await currentModelUsage().beforeInference?.();await currentModelUsage().beforeDispatch?.();
  physical.push(body.messages.some(message=>message.content.includes('Когда нужен инструмент')));
  const content=infer.mock.calls.length===1||control.secondTool&&infer.mock.calls.length===2?JSON.stringify({kind:'tool',toolKey:tool.toolKey,arguments:{}}):JSON.stringify(final);
  if(content===JSON.stringify(final))expect(JSON.stringify(body.messages)).toContain('KNOWN_ACCEPTED_EVIDENCE');
  return {done_reason:'stop',message:{role:'assistant',content}};
 });
 const runner=new SystemRoleRunner(repository as never,policy as never,targets,{infer},async()=>{},async()=>{},async()=>undefined as never,mcp as never);
 return {row,control,physical,mcp,infer,effects:()=>effects,targets,selection,run:()=>runner.run({}as never,row,new AbortController().signal)};
}

describe('Accepted MCP receipts do not depend on current tool target readiness',()=>{
 it.each(['MCP device revoked','MCP device expired','MCP offline','MCP binding changed','MCP configuration changed','MCP assignment removed'])('%s preserves synthesis from an accepted snapshot',async failure=>{
  const f=await fixture(failure);await f.run();expect(f.row).toMatchObject({state:'succeeded',result:final});expect(f.effects()).toBe(1);
  expect(f.mcp.prepare).toHaveBeenCalledOnce();expect(f.infer).toHaveBeenCalledTimes(2);expect(f.physical).toEqual([true,false]);
  await expect(f.targets.prepare({}as never,'agent-ai-admin',f.selection)).rejects.toThrow(failure);
 });
 it('keeps fresh tool admission when a target changes after the last availability decision and does not repeat its physical effect',async()=>{
  const f=await fixture('MCP binding changed');f.control.secondTool=true;f.control.knownLoss=false;await f.run();expect(f.row.result).toEqual(final);
  expect(f.mcp.call).toHaveBeenCalledTimes(2);expect(f.effects()).toBe(1);expect(f.infer).toHaveBeenCalledTimes(3);
 });
 it.each(['actor','project','source','model','non-MCP context'])('still fences ordinary synthesis after %s changes',async failure=>{
  const f=await fixture(failure);await expect(f.run()).rejects.toThrow(failure==='non-MCP context'?'контекст':failure);
  expect(f.row.result).toBeNull();expect(f.infer).toHaveBeenCalledOnce();expect(f.effects()).toBe(1);
 });
});
