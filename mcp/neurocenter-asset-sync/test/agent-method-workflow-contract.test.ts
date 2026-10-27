import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {normalizeAgentMethodWorkflowPayload,normalizeAgentMethodWorkflowResult,AGENT_METHOD_WORKFLOW_PROTOCOL} from '../src/features/agent-method-workflow/contract.js';
const payload=()=>({protocol:AGENT_METHOD_WORKFLOW_PROTOCOL,workflowId:randomUUID(),requestId:randomUUID(),projectId:'qa-project',bindingId:'a'.repeat(64),instanceId:randomUUID(),method:'openspec',methodVersion:'1.15.0',stage:'full-cycle',instruction:'Implement and verify the selected task.',deadlineAt:new Date().toISOString(),runtime:'opencode',checks:[{command:'npm',args:['test']}]});
describe('Agent method workflow wire contract',()=>{
 it('keeps exact method, checks and identity while cloning accepted argv',()=>{const source=payload(),result=normalizeAgentMethodWorkflowPayload(source);source.checks[0]!.args.push('changed');expect(result.checks[0]!.args).toEqual(['test']);});
 it('pins the combined method to both versions',()=>{expect(normalizeAgentMethodWorkflowPayload({...payload(),method:'combined',methodVersion:'bmad-6.12.4+openspec-1.15.0'}).method).toBe('combined');expect(()=>normalizeAgentMethodWorkflowPayload({...payload(),method:'combined'})).toThrow();});
 it.each([{methodVersion:'latest'},{runtime:'shell'},{command:'bash'},{stage:'apply'},{bindingId:'other'},{instruction:'\0'}])('rejects changed or unknown execution inputs %j',patch=>{expect(()=>normalizeAgentMethodWorkflowPayload({...payload(),...patch})).toThrow();});
 it.each(['npm;echo SECRET','/bin/bash','node\nprivate'])('rejects shell text or absolute command paths %s',command=>{expect(()=>normalizeAgentMethodWorkflowPayload({...payload(),checks:[{command,args:[]}]})).toThrow();});
 it('cannot claim passed checks from a failing real exit or wrong workflow',()=>{
  const input=payload(),result={protocol:input.protocol,workflowId:input.workflowId,method:input.method,methodVersion:input.methodVersion,runtime:'opencode',state:'succeeded',stage:'completed',codeChanged:false,changes:[],artifacts:[],checks:[{command:'npm',args:['test'],exitCode:7,signal:null,state:'passed'}]};
  expect(()=>normalizeAgentMethodWorkflowResult(result,input)).toThrow();result.checks[0]!.exitCode=0;expect(normalizeAgentMethodWorkflowResult(result,input).state).toBe('succeeded');
  expect(()=>normalizeAgentMethodWorkflowResult({...result,workflowId:randomUUID()},input)).toThrow();
 });
 it('forbids stdout and external paths in receipts',()=>{const input=payload(),result={protocol:input.protocol,workflowId:input.workflowId,method:input.method,methodVersion:input.methodVersion,runtime:'opencode',state:'failed',stage:'execution',codeChanged:false,changes:[],artifacts:[],checks:[],failure:{code:'EXECUTION_FAILED',action:'review-result'}};
  expect(()=>normalizeAgentMethodWorkflowResult({...result,stdout:'PRIVATE'})).toThrow();expect(()=>normalizeAgentMethodWorkflowResult({...result,artifacts:[{path:'../secrets',sha256:'a'.repeat(64)}]})).toThrow();
 });
});
