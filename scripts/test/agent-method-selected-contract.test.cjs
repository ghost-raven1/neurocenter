'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeAgentMethodWorkflowPayload:payload,normalizeAgentMethodWorkflowResult:result,agentMethodWorkflowAgentIdentity:identity,agentMethodWorkflowDigest:digest}=require('../../services/shared/agent-method-workflow.cjs');
const request={protocol:'agent-method-workflow-v1',workflowId:'11111111-1111-4111-8111-111111111111',requestId:'11111111-1111-4111-8111-111111111111',projectId:'project-qa',bindingId:'a'.repeat(64),instanceId:'22222222-2222-4222-8222-222222222222',method:'openspec',methodVersion:'1.15.0',stage:'full-cycle',instruction:'Verify selected execution',deadlineAt:'2026-10-27T12:00:00.000Z',runtime:'opencode',checks:[{command:'node',args:['check.cjs']}]};
const agent={agentId:'agent-qa',slug:'nc-qa',version:2,agentsRevision:3,agentsManifestSha256:'b'.repeat(64),compiledManifestSha256:'c'.repeat(64),fileSha256:'d'.repeat(64),configurationJobId:'33333333-3333-4333-8333-333333333333',mode:'all',model:{agentId:'agent-qa',provider:'qa',configKey:'selected',runtime:'remote-openai',model:'actual-model',baseUrl:'http://127.0.0.1:54321/v1',options:{temperature:0,topP:1},capability:'chat'}};
const observed={protocol:request.protocol,workflowId:request.workflowId,method:request.method,methodVersion:request.methodVersion,runtime:request.runtime,state:'succeeded',stage:'completed',codeChanged:false,changes:[],artifacts:[],checks:[{...request.checks[0],exitCode:0,signal:null,state:'passed'}]};

test('Legacy receipts and accepted input bytes keep their exact shape',()=>{
 assert.equal(JSON.stringify(payload(request)),JSON.stringify(request));assert.equal(Object.hasOwn(payload(request),'agent'),false);
 assert.deepEqual(result(observed,request),observed);
});
test('Selection pins identity and canonical approved mapping without copying private data to the result',()=>{
 const selected=payload({...request,agent}),publicAgent=identity(selected.agent);
 assert.equal(Object.hasOwn(publicAgent,'model'),false);assert.equal(Object.hasOwn(publicAgent,'mode'),false);
 assert.deepEqual(result({...observed,agent:publicAgent},selected).agent,publicAgent);
 assert.equal(digest(selected),digest({...request,agent:{...agent,model:{...agent.model,options:{topP:1,temperature:0}}}}));
 assert.notEqual(digest(request),digest(selected));
});
test('A receipt for another agent, file, assignment or delivery cannot confirm selected execution',()=>{
 const selected=payload({...request,agent}),publicAgent=identity(agent);
 for(const change of [{agentId:'other'},{fileSha256:'e'.repeat(64)},{agentsRevision:4},{configurationJobId:request.workflowId}])assert.throws(()=>result({...observed,agent:{...publicAgent,...change}},selected));
 assert.throws(()=>result(observed,selected));assert.throws(()=>result({...observed,agent:publicAgent},request));
});
test('Subagent/default fallback and unsupported or credential-bearing mappings fail closed',()=>{
 for(const change of [{mode:'subagent'},{model:{...agent.model,agentId:'other'}},{model:{...agent.model,baseUrl:'http://user:password@qa.test/v1'}},{model:{...agent.model,options:{apiKey:'private'}}},{fileSha256:'short'},{prompt:'untrusted'}])assert.throws(()=>payload({...request,agent:{...agent,...change}}));
 for(const invalid of [null,undefined,{}])assert.throws(()=>payload({...request,agent:invalid}));
});
test('Result identity cannot leak runtime model config or smuggle extra fields',()=>{
 const selected=payload({...request,agent});
 assert.throws(()=>result({...observed,agent},selected));
 assert.throws(()=>result({...observed,agent:{...identity(agent),secret:'private'}},selected));
 const setup={...observed,agent:identity(agent),state:'needs_setup',stage:'prerequisites',checks:request.checks.map(check=>({...check,exitCode:null,signal:null,state:'not_run'})),failure:{code:'SELECTED_AGENT_NOT_READY',action:'setup-agent'}};
 assert.equal(result(setup,selected).checks[0].state,'not_run');
});
