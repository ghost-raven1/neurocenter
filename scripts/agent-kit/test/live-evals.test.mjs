import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {loadScenarios} from '../evals/run.mjs';
import {activeIdentity,finalSchema,preflightLiveRun,admitLiveRun,executeLiveRun,cleanupLiveRun,nativeInvocation,rescoreInfrastructure} from '../evals/live-runner.mjs';
import {mockName,mockTools,mockResult} from '../evals/mock-server.mjs';
import {captureLiveTrace} from '../evals/live-capture.mjs';
import {fixtureRun} from './live-preflight.fixture.mjs';

const scenarios=await loadScenarios(),scenario=scenarios.find(item=>item.id==='check-source-unknown');
const metadata={capture:'captured-trace',model:{id:'configured-model',version:'native-test',parameters:{reasoning:'ultra'}},prompts:{version:'test',sha256:'a'.repeat(64)}};
const unsupportedMessage=JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message:"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}});
const providerFailure=[{type:'thread.started',thread_id:'fixture-thread'},
    {type:'item.completed',item:{id:'warning',type:'error',message:'Model metadata not found; defaulting to fallback metadata.'}},
    {type:'turn.started'},{type:'error',message:unsupportedMessage},{type:'turn.failed',error:{message:unsupportedMessage}}].map(item=>JSON.stringify(item)).join('\n')+'\n';

function artifacts(selected=scenario){
    const control=selected.controls.find(item=>item.pass).trace,records=[],items=[];
    for(const [index,action]of control.actions.entries()){
        const operation=selected.operations.find(item=>item.id===action.operation),result=mockResult(selected,'run:scenario',index+1,{name:mockName(operation),arguments:operation.input});
        records.push(result.record);items.push({type:'item.completed',item:{id:'item_'+index,type:'mcp_tool_call',server:'eval_mock',tool:mockName(operation),arguments:operation.input,result:result.response,status:'completed'}});
    }
    const final=structuredClone(control.final);final.evidence=final.evidence.map(item=>({...item,facts:JSON.stringify(item.facts)}));
    items.push({type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify(final)}});
    items.push({type:'turn.completed',usage:{input_tokens:100,output_tokens:50}});
    return {runId:'run:scenario',jsonl:items.map(item=>JSON.stringify(item)).join('\n')+'\n',ledger:records.map(item=>JSON.stringify(item)).join('\n')+'\n',metadata,versions:{kitVersion:'test'}};
}

test('private configuration preserves exact active identity without accepting profiles or substitutions',()=>{
    const raw='model = "gpt-6.1-sol"\nmodel_reasoning_effort = "ultra"\nmodel_verbosity = "low"\n[mcp_servers.real]\ncommand = "do-not-run"\n';
    const identity=activeIdentity(raw);
    assert.equal(identity.model,'gpt-6.1-sol');assert.equal(identity.reasoning,'ultra');assert.equal(identity.provider,'openai');
    assert.deepEqual(identity.lines,['model = "gpt-6.1-sol"','model_reasoning_effort = "ultra"','model_verbosity = "low"']);
    assert.ok(!JSON.stringify(identity).includes('do-not-run'));
    for(const suffix of ['profile = "custom"\n','model_provider = "other"\n',"profile = 'custom'\n"])
        assert.throws(()=>activeIdentity(raw.split('[mcp_servers')[0]+suffix));
});

test('all runs share one output vocabulary while gold outcomes stay absent from tool definitions',()=>{
    const schema=finalSchema(scenarios);
    for(const selected of scenarios){
        for(const limit of selected.expected.limits)assert.ok(schema.properties.limits.items.enum.includes(limit));
        for(const step of selected.expected.nextSteps)assert.ok(schema.properties.next_step.enum.includes(step));
        const tools=mockTools(selected),encoded=JSON.stringify(tools);
        assert.equal(tools.length,selected.operations.length);
        for(const item of selected.operations.flatMap(operation=>operation.observations))assert.ok(!encoded.includes(item.id));
        assert.ok(!encoded.includes('controls'));assert.ok(!encoded.includes('expected'));
    }
});

test('mock validates exact inputs and records forbidden-effect requests without executing them',()=>{
    const reviewer=scenarios.find(item=>item.id==='readonly-reviewer-cannot-write');
    const operation=reviewer.operations.find(item=>item.effect==='write');
    const valid=mockResult(reviewer,'run:scenario',1,{name:mockName(operation),arguments:operation.input});
    assert.equal(valid.record.valid,true);assert.deepEqual(valid.record.result.observations,[]);
    const invalid=mockResult(reviewer,'run:scenario',2,{name:mockName(operation),arguments:{path:'/private/foreign'}});
    assert.equal(invalid.record.valid,false);assert.equal(invalid.response.isError,true);
});

test('trusted capture grounds all six final answers in actual MCP events and host records',()=>{
    for(const selected of scenarios){
        const result=captureLiveTrace(selected,artifacts(selected));
        assert.equal(result.score.status,'pass',selected.id);assert.deepEqual(result.errors,[]);
        assert.equal(result.score.capture.provenance.verified,true);assert.equal(result.usage[0].output_tokens,50);
    }
});

test('self-reported final actions cannot create an actual tool observation',()=>{
    const data=artifacts();data.ledger='';data.jsonl=data.jsonl.split('\n').filter(line=>!line.includes('mcp_tool_call')).join('\n');
    const result=captureLiveTrace(scenario,data);
    assert.equal(result.score.status,'fail');assert.equal(result.trace.actions.length,0);
    assert.ok(result.score.hardFailures.includes('FABRICATED_EVIDENCE'));
});

test('item-level metadata diagnostics do not erase completed model behavior or become role actions',()=>{
    const data=artifacts();data.jsonl=JSON.stringify({type:'item.completed',item:{id:'warning',type:'error',message:'Model metadata fallback warning.'}})+'\n'+data.jsonl;
    const captured=captureLiveTrace(scenario,data);
    assert.equal(captured.score.status,'pass');assert.equal(captured.score.modelBehavior,'measured-in-constrained-mock');
    assert.equal(captured.score.rubric.permissions,1);assert.equal(captured.infrastructure,null);
    assert.deepEqual(captured.score.diagnostics,['ITEM_ERROR_DIAGNOSTIC']);
});

test('unsupported model/auth infrastructure without actions leaves behavior and rubric unmeasured',()=>{
    const data={...artifacts(),jsonl:providerFailure,ledger:'',processOk:false};
    const captured=captureLiveTrace(scenario,data);
    assert.equal(captured.score.status,'fail');assert.equal(captured.score.outcome,'infrastructure-error');
    assert.equal(captured.infrastructure.code,'MODEL_UNSUPPORTED_FOR_AUTHENTICATION');assert.equal(captured.infrastructure.providerStatus,400);
    assert.equal(captured.score.modelBehavior,'unmeasured');assert.equal(captured.score.score,null);
    assert.deepEqual(captured.score.rubric,{goal:null,evidence:null,permissions:null,clarity:null});
    assert.ok(!captured.errors.includes('NON_MOCK_ACTION'));assert.deepEqual(captured.usage,[]);
});

test('malformed mock tool calls with an item error stay capture failures despite a completed answer',()=>{
    const data=artifacts(),invalid=mockResult(scenario,'run:scenario',2,{name:'summary',arguments:{report:'wrong'}});
    data.ledger+=JSON.stringify(invalid.record)+'\n';
    const additions=[{type:'item.completed',item:{id:'bad-call',type:'mcp_tool_call',server:'eval_mock',tool:'summary',arguments:{report:'wrong'},result:invalid.response,status:'failed'}},
        {type:'item.completed',item:{id:'bad-call-error',type:'error',message:'Malformed tool call arguments.'}}];
    data.jsonl+=additions.map(item=>JSON.stringify(item)).join('\n')+'\n';
    const captured=captureLiveTrace(scenario,data);
    assert.equal(captured.score.status,'fail');assert.equal(captured.infrastructure,null);
    assert.equal(captured.score.modelBehavior,'measured-in-constrained-mock');assert.ok(captured.score.hardFailures.includes('INVALID_MCP_LEDGER'));
    assert.notEqual(captured.score.rubric.permissions,null);assert.ok(!captured.errors.includes('AGENT_ERROR'));
});

test('an infrastructure failure preserves an earlier forbidden native attempt',()=>{
    const data={...artifacts(),jsonl:JSON.stringify({type:'item.started',item:{type:'command_execution',command:'forbidden fixture'}})+'\n'+providerFailure,ledger:'',processOk:false};
    const captured=captureLiveTrace(scenario,data);
    assert.equal(captured.score.modelBehavior,'partially-observed');assert.ok(captured.score.hardFailures.includes('NON_MOCK_ACTION'));
    assert.equal(captured.score.rubric.permissions,0);
});

test('an unfinished forbidden mock attempt cannot disappear behind a valid final answer or provider failure',()=>{
    const selected=scenarios.find(item=>item.id==='readonly-reviewer-cannot-write'),operation=selected.operations.find(item=>item.effect==='write');
    const started={type:'item.started',item:{id:'unfinished-write',type:'mcp_tool_call',server:'eval_mock',tool:mockName(operation),arguments:operation.input}};
    for(const failure of [false,true]){
        const data=artifacts(selected),observed=data.jsonl;
        data.jsonl=JSON.stringify(started)+'\n'+(failure?providerFailure:observed);
        if(failure){data.ledger='';data.processOk=false;}
        const captured=captureLiveTrace(selected,data);
        assert.equal(captured.score.status,'fail');assert.ok(captured.score.hardFailures.includes('FORBIDDEN_ACTION'));
        assert.ok(captured.errors.includes('MCP_CALL_INCOMPLETE'));assert.equal(captured.score.capture.provenance.incompleteMcpCalls,1);
        assert.equal(captured.trace.actions.some(action=>action.operation===operation.id),false);
        assert.equal(captured.score.modelBehavior,failure?'partially-observed':'measured-in-constrained-mock');
        assert.equal(captured.score.rubric.permissions,0);
    }
});

test('malformed or unknown mock starts remain attempted behavior without inventing observations',()=>{
    const operation=scenario.operations[0];
    for(const item of [
        {id:'unknown',type:'mcp_tool_call',server:'eval_mock',tool:'not-an-operation',arguments:{}},
        {id:'bad-input',type:'mcp_tool_call',server:'eval_mock',tool:mockName(operation),arguments:{wrong:true}},
        {type:'mcp_tool_call',server:'eval_mock',tool:mockName(operation),arguments:operation.input},
    ]){
        const captured=captureLiveTrace(scenario,{...artifacts(),jsonl:JSON.stringify({type:'item.started',item})+'\n'+providerFailure,ledger:'',processOk:false});
        assert.equal(captured.score.modelBehavior,'partially-observed');assert.equal(captured.trace.actions.length,0);
        assert.ok(captured.score.hardFailures.some(code=>['INVALID_MCP_ATTEMPT','UNRECOGNIZED_ACTION'].includes(code)));
        assert.equal(captured.score.capture.provenance.verified,false);assert.equal(captured.score.capture.provenance.mcpAttempts,1);
    }
});

test('matching starts and completions count once and mismatched lifecycle ids fail provenance',()=>{
    const data=artifacts(),events=data.jsonl.trim().split('\n').map(line=>JSON.parse(line));
    data.jsonl=events.flatMap(event=>event.item?.type==='mcp_tool_call'?[{type:'item.started',item:{...event.item,result:undefined,status:'in_progress'}},event]:[event]).map(event=>JSON.stringify(event)).join('\n')+'\n';
    const captured=captureLiveTrace(scenario,data);
    assert.equal(captured.score.status,'pass');assert.equal(captured.score.capture.provenance.mcpAttempts,captured.trace.actions.length);
    assert.equal(captured.score.capture.provenance.incompleteMcpCalls,0);
    const mismatched={...data,jsonl:data.jsonl.replace('"type":"item.started","item":{"id":"item_0"','"type":"item.started","item":{"id":"other-id"')};
    assert.ok(captureLiveTrace(scenario,mismatched).errors.includes('MCP_CALL_INCOMPLETE'));
});

test('missing, reordered or altered native MCP events fail provenance independently of final prose',()=>{
    for(const mutate of [
        value=>{value.jsonl=value.jsonl.replace('"server":"eval_mock"','"server":"real_server"');},
        value=>{value.jsonl=value.jsonl.replace('"tool":"summary"','"tool":"other"');},
        value=>{value.ledger=value.ledger.replace('run:scenario','other-run');},
        value=>{value.jsonl=value.jsonl.replace('"output_tokens":50','"output_tokens":49');value.ledger='';},
        value=>{value.jsonl=value.jsonl.split('\n').filter(line=>!line.includes('turn.completed')).join('\n');},
    ]){
        const data=artifacts();mutate(data);const result=captureLiveTrace(scenario,data);
        assert.equal(result.score.status,'fail');assert.equal(result.score.capture.provenance.verified,false);
    }
});

test('native non-mock execution and read-only mock write both hard-fail',()=>{
    const data=artifacts();
    data.jsonl=JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'true'}})+'\n'+data.jsonl;
    assert.ok(captureLiveTrace(scenario,data).score.hardFailures.includes('NON_MOCK_ACTION'));
    const reviewer=scenarios.find(item=>item.id==='readonly-reviewer-cannot-write'),bad=artifacts(reviewer),operation=reviewer.operations.find(item=>item.effect==='write');
    const mocked=mockResult(reviewer,'run:scenario',2,{name:mockName(operation),arguments:operation.input});
    bad.ledger+=JSON.stringify(mocked.record)+'\n';
    bad.jsonl=JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'eval_mock',tool:mockName(operation),arguments:operation.input,result:mocked.response,status:'completed'}})+'\n'+bad.jsonl;
    assert.equal(captureLiveTrace(reviewer,bad).score.status,'fail');
    const started=artifacts();started.jsonl=JSON.stringify({type:'item.started',item:{type:'command_execution',command:'true'}})+'\n'+started.jsonl;
    assert.ok(captureLiveTrace(scenario,started).score.hardFailures.includes('NON_MOCK_ACTION'));
});

async function ownedRun(t){
    const run=await fixtureRun(t);assert.equal((await preflightLiveRun(run.id)).status,'compatible');
    return {...run,path:path.join(run.directory,'plan.json')};
}

test('admission rejects modified paths/args/content and cleanup never removes a foreign directory',async t=>{
    const run=await ownedRun(t),original=JSON.stringify(run.plan);
    assert.equal((await admitLiveRun(run.id)).id,run.id);
    const foreign=await fs.mkdtemp(path.join(os.tmpdir(),'nc-foreign-live-'));t.after(()=>fs.rm(foreign,{recursive:true,force:true}));
    await fs.writeFile(path.join(foreign,'sentinel'),'keep');
    for(const change of [value=>{value.privateRoot=foreign;},value=>{value.entries[0].workspace=foreign;},
        value=>{value.entries[0].args.push('--dangerously-bypass-approvals-and-sandbox');}]){
        const modified=JSON.parse(original);change(modified);await fs.writeFile(run.path,JSON.stringify(modified));
        await assert.rejects(admitLiveRun(run.id));
    }
    const modified=JSON.parse(original);modified.privateRoot=foreign;await fs.writeFile(run.path,JSON.stringify(modified));
    await assert.rejects(cleanupLiveRun(run.id));assert.equal(await fs.readFile(path.join(foreign,'sentinel'),'utf8'),'keep');
    await fs.writeFile(run.path,original);
    const prompt=path.join(run.plan.entries[0].directory,'prompt.md');await fs.writeFile(prompt,'supplied gold');
    await assert.rejects(admitLiveRun(run.id),/content/);
});

test('host throw after admission writes a terminal receipt and removes all private auth copies',async t=>{
    const run=await ownedRun(t);let calls=0;
    const receipt=await executeLiveRun(run.id,{invoke:async()=>{calls++;throw Error('controlled host failure');}});
    assert.equal(calls,1);assert.equal(receipt.attempted,1);assert.equal(receipt.status,'failed-or-unconfirmed');
    assert.equal(receipt.privateAuthCopiesRemoved,true);assert.ok(receipt.finishedAt);
    await assert.rejects(fs.stat(run.plan.privateRoot),{code:'ENOENT'});
    assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(run.path),'receipt.json'),'utf8')).failure,'RUN_INTERRUPTED_BY_HOST_ERROR');
});

test('cancel stops before the next scenario, writes terminal state and removes private auth',async t=>{
    const run=await ownedRun(t);let calls=0;
    const receipt=await executeLiveRun(run.id,{invoke:async()=>{
        calls++;process.emit('SIGINT');return {stdout:'',stderr:'',code:null,signal:'SIGTERM',ok:false,leaderReaped:true,cleanup:{noLiveDescendants:true,signals:['SIGTERM']},failure:{code:'CANCELLED'}};
    }});
    assert.equal(calls,1);assert.equal(receipt.attempted,1);assert.equal(receipt.status,'cancelled');assert.equal(receipt.privateAuthCopiesRemoved,true);
});

test('provider failure stops after one attempt and historical rescore preserves all original bytes',async t=>{
    const run=await ownedRun(t);let calls=0;
    const receipt=await executeLiveRun(run.id,{invoke:async()=>{calls++;return {stdout:providerFailure,stderr:'',code:1,signal:null,ok:false,
        leaderReaped:true,cleanup:{noLiveDescendants:true,signals:[]},failure:{code:'BUILD_FAILED'}};}});
    assert.equal(calls,1);assert.equal(receipt.attempted,1);assert.equal(receipt.unattempted,5);assert.equal(receipt.unattemptedScenarios.length,5);
    assert.equal(receipt.stopReason,'MODEL_UNSUPPORTED_FOR_AUTHENTICATION');assert.equal(receipt.status,'failed-or-unconfirmed');assert.equal(receipt.privateAuthCopiesRemoved,true);
    const directory=path.dirname(run.path),source=path.join(directory,receipt.results[0].scenario);
    const paths=[path.join(directory,'receipt.json'),path.join(source,'agent.jsonl'),path.join(source,'mock-ledger.jsonl'),path.join(source,'score.json')];
    const before=await Promise.all(paths.map(file=>fs.readFile(file)));
    const summary=await rescoreInfrastructure(run.id);
    assert.equal(summary.modelRequestsMadeByRescore,0);assert.equal(summary.modelBehavior,'unmeasured');assert.equal(summary.attempted,1);assert.equal(summary.unattempted,5);
    assert.equal(summary.sourceReceiptSha256,createHash('sha256').update(before[0]).digest('hex'));
    for(const [index,file]of paths.entries())assert.deepEqual(await fs.readFile(file),before[index]);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory,'infrastructure-summary.json'),'utf8')).results[0].score,null);
});

async function historicalRun(t,{scenarioSha256='d'.repeat(64)}={}){
    const id='test-rescore-'+randomUUID(),directory=fileURLToPath(new URL('../../../.run/agent-kit-evals/'+id+'/',import.meta.url)),source=path.join(directory,scenario.id);
    await fs.mkdir(source,{recursive:true,mode:0o700});t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const originalVersions={kitVersion:'historical-kit',kitManifestSha256:'b'.repeat(64),promptContentSha256:'c'.repeat(64)},promptSha256='e'.repeat(64);
    const oldScore={versions:{scenario:'historical-scenario',scenarioSha256,evaluator:'historical-evaluator',liveCapture:'historical-capture'},capture:{prompts:{version:'historical-prompt',sha256:promptSha256}}};
    const files={'plan.json':{versions:originalVersions,identity:{model:'configured-model',provider:'openai',reasoning:'ultra'},entries:[{scenario:scenario.id,scenarioSha256,promptSha256}]},
        'receipt.json':{budget:6,attempted:1,finished:0,privateAuthCopiesRemoved:true,results:[{scenario:scenario.id,process:{code:1,failure:{code:'BUILD_FAILED'}}}]},
        [scenario.id+'/agent.jsonl']:providerFailure,[scenario.id+'/mock-ledger.jsonl']:'',[scenario.id+'/score.json']:oldScore};
    for(const [file,value]of Object.entries(files))await fs.writeFile(path.join(directory,file),typeof value==='string'?value:JSON.stringify(value)+'\n',{mode:0o600});
    const originals=await Promise.all(Object.keys(files).map(file=>fs.readFile(path.join(directory,file))));
    return {id,directory,files,originals,promptSha256};
}

test('historical same-id scenario drift is explicit and retains original and current scoring versions',async t=>{
    const {id,directory,files,originals,promptSha256}=await historicalRun(t),summary=await rescoreInfrastructure(id),result=summary.results[0];
    assert.equal(summary.modelRequestsMadeByRescore,0);assert.equal(result.outcome,'scenario-version-mismatch');assert.equal(result.score,null);
    assert.deepEqual(result.errors,['SCENARIO_VERSION_MISMATCH']);assert.equal(result.versions.original.scenarioSha256,'d'.repeat(64));
    assert.equal(result.versions.current.scenarioSha256,createHash('sha256').update(JSON.stringify(scenario)).digest('hex'));
    assert.equal(result.versions.original.evaluator,'historical-evaluator');assert.equal(result.versions.original.prompts.version,'historical-prompt');
    assert.equal(result.versions.original.kitVersion,'historical-kit');assert.equal(result.versions.current.evaluator,'1.0.0');
    assert.match(result.versions.current.evaluatorSha256,/^[a-f0-9]{64}$/);assert.match(result.versions.current.liveCaptureSha256,/^[a-f0-9]{64}$/);
    assert.equal(result.versions.current.capturedPromptSha256,promptSha256);
    for(const [index,file]of Object.keys(files).entries())assert.deepEqual(await fs.readFile(path.join(directory,file)),originals[index]);
});

test('matching historical scenario is rescored with current evaluator fingerprints without rating provider failure',async t=>{
    const scenarioSha256=createHash('sha256').update(JSON.stringify(scenario)).digest('hex'),run=await historicalRun(t,{scenarioSha256});
    const summary=await rescoreInfrastructure(run.id),result=summary.results[0];
    assert.equal(summary.schemaVersion,2);assert.equal(summary.modelRequestsMadeByRescore,0);assert.equal(result.outcome,'infrastructure-error');
    assert.equal(result.infrastructure.code,'MODEL_UNSUPPORTED_FOR_AUTHENTICATION');assert.equal(result.modelBehavior,'unmeasured');
    assert.equal(result.score,null);assert.deepEqual(result.rubric,{goal:null,evidence:null,permissions:null,clarity:null});
    assert.equal(result.versions.original.scenarioSha256,scenarioSha256);assert.equal(result.versions.current.scenarioSha256,scenarioSha256);
    assert.equal(result.versions.original.evaluator,'historical-evaluator');assert.equal(result.versions.current.evaluator,'1.0.0');
    assert.equal(result.versions.original.liveCapture,'historical-capture');assert.equal(result.versions.current.liveCapture,'1.1.0');
    assert.equal(result.source.originalScoreSha256,createHash('sha256').update(run.originals.at(-1)).digest('hex'));
    for(const [index,file]of Object.keys(run.files).entries())assert.deepEqual(await fs.readFile(path.join(run.directory,file)),run.originals[index]);
});

test('fatal agent error stops the series even when the host process exits zero',async t=>{
    const run=await ownedRun(t);let calls=0;
    const receipt=await executeLiveRun(run.id,{invoke:async()=>{calls++;return {stdout:providerFailure,stderr:'',code:0,signal:null,ok:true,
        leaderReaped:true,cleanup:{noLiveDescendants:true,signals:[]},failure:null};}});
    assert.equal(calls,1);assert.equal(receipt.attempted,1);assert.equal(receipt.unattempted,5);assert.equal(receipt.stopReason,'MODEL_UNSUPPORTED_FOR_AUTHENTICATION');
});

test('invalid flags fail before any plan access; help works without config/auth',async()=>{
    const previous=process.env.NEUROCENTER_AGENT_EVALS;
    try{
        for(const value of ['0','false','yes']){process.env.NEUROCENTER_AGENT_EVALS=value;await assert.rejects(executeLiveRun('missing-run'),/evaluation (flag|is disabled)/);}
    }finally{if(previous===undefined)delete process.env.NEUROCENTER_AGENT_EVALS;else process.env.NEUROCENTER_AGENT_EVALS=previous;}
    const cli=fileURLToPath(new URL('../evals/live-runner.mjs',import.meta.url));
    const child=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8',env:{...process.env,CODEX_HOME:'/nonexistent',NEUROCENTER_AGENT_EVALS:'invalid'}});
    assert.equal(child.status,0);assert.equal(child.stderr,'');assert.match(child.stdout,/--run-six/);
});

test('native supervisor kills a TERM-ignoring descendant after the native leader exits',async t=>{
    const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-native-live-group-'))),home=path.join(folder,'home'),bin=path.join(folder,'bin');
    await fs.mkdir(home);await fs.mkdir(bin);t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    const ready=path.join(folder,'ready'),heartbeat=path.join(folder,'heartbeat');
    const source=`const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);`)}],{stdio:'ignore'});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(0);}},5);`;
    await fs.writeFile(path.join(bin,'codex'),'#!'+process.execPath+'\n'+source,{mode:0o700});
    const previous=process.env.PATH;process.env.PATH=bin+path.delimiter+previous;
    let child;
    try{child=await nativeInvocation([],{home,cwd:folder,timeoutMs:10000});}finally{process.env.PATH=previous;}
    assert.equal(child.ok,false);assert.equal(child.failure.code,'SURVIVING_DESCENDANTS');assert.equal(child.leaderReaped,true);
    assert.equal(child.cleanup.noLiveDescendants,true);assert.ok(child.cleanup.signals.includes('SIGKILL'));
    const before=await fs.readFile(heartbeat,'utf8');await new Promise(resolve=>setTimeout(resolve,50));assert.equal(await fs.readFile(heartbeat,'utf8'),before);
});

test('native stdout and stderr share a four MiB on-disk cap before cleanup',async t=>{
    const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-native-live-cap-'))),home=path.join(folder,'home'),bin=path.join(folder,'bin');
    await fs.mkdir(home);await fs.mkdir(bin);t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    await fs.writeFile(path.join(bin,'codex'),'#!'+process.execPath+"\nconst chunk=Buffer.alloc(1024*1024,'x');for(let i=0;i<20;i++){process.stdout.write(chunk);process.stderr.write(chunk);}",{mode:0o700});
    const previous=process.env.PATH;process.env.PATH=bin+path.delimiter+previous;
    let result;
    try{result=await nativeInvocation([],{home,cwd:folder,timeoutMs:10000});}finally{process.env.PATH=previous;}
    assert.equal(result.ok,false);assert.equal(result.cleanup.noLiveDescendants,true);
    const files=(await fs.readdir(home)).filter(name=>name.endsWith('.stdout')||name.endsWith('.stderr'));
    let total=0;for(const file of files)total+=(await fs.stat(path.join(home,file))).size;
    assert.equal(total,4*1024**2);
});

test('mock MCP stdio executes handshake/list/call and produces a host-owned ledger without a model',async t=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-mock-eval-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const fixture=path.join(directory,'operations.json'),ledger=path.join(directory,'ledger.jsonl');
    await fs.writeFile(fixture,JSON.stringify({operations:scenario.operations}));await fs.writeFile(ledger,'');
    const server=fileURLToPath(new URL('../evals/mock-server.mjs',import.meta.url));
    const child=spawn(process.execPath,[server,fixture,ledger,'run:scenario'],{stdio:['pipe','pipe','pipe']});
    let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.resume();
    for(const request of [{id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},{id:2,method:'tools/list'},
        {id:3,method:'tools/call',params:{name:'summary',arguments:scenario.operations[0].input}}])child.stdin.write(JSON.stringify({jsonrpc:'2.0',...request})+'\n');
    child.stdin.end();await new Promise(resolve=>child.on('close',resolve));
    const events=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(events.length,3);
    assert.equal(events[1].result.tools[0].name,'summary');
    assert.equal(JSON.parse(await fs.readFile(ledger,'utf8')).action,'a1');
    assert.equal(JSON.parse(events[2].result.content[0].text).observations[0].id,'legacy-check');
});
