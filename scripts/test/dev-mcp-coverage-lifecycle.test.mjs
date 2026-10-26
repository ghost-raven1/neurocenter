import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiagnostics} from '../dev-mcp/diagnostics.mjs';
import {validateOutput} from '../dev-mcp/output-validation.mjs';

const start='2026-10-25T01:00:00.000Z',end='2026-10-25T01:00:01.000Z';
const metric={total:1,covered:1,skipped:0,pct:100};
const summary=Object.fromEntries(['lines','statements','functions','branches'].map(key=>[key,{...metric}]));
const processResult=()=>({ok:true,exitCode:0,signal:null,durationMs:10,leaderReaped:true,
    cleanup:{noLiveDescendants:true,zombiePids:[],signals:[]}});
const lifecycle=(state='failed')=>({schemaVersion:1,state,plannedSteps:['unit:frontend'],steps:[],
    failure:state==='failed'?{code:'COVERAGE_EXECUTION_FAILED'}:state==='cancelled'?{code:'CANCELLED'}:null,
    cancellation:state==='cancelled'?{signal:'SIGTERM'}:null,finalizationErrors:[]});

/** Exercise the real bounded reader, without a running MCP server or product services. */
async function fixture(t,state='failed'){
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc coverage lifecycle evidence ')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    await writeFile(path.join(root,'package.json'),JSON.stringify({name:'neurocenter-workspace'}));
    const report='.run/coverage/lifecycle/manifest.json';await mkdir(path.dirname(path.join(root,report)),{recursive:true});
    const manifest={schemaVersion:2,profile:'unit-safe',coverageKind:'vitest-ast-v8',comparablePercentages:true,
        startedAt:start,finishedAt:end,complete:false,suiteCompletion:false,packages:[],native:null,integration:null,lifecycle:lifecycle(state)};
    const save=()=>writeFile(path.join(root,report),JSON.stringify(manifest));await save();
    const diagnostics=await createDiagnostics(root);
    return {manifest,save,report,read:()=>diagnostics.verificationSummary(report),gaps:()=>diagnostics.coverageGaps(report,'frontend')};
}

for(const state of ['failed','cancelled'])test('early '+state+' coverage remains readable without a summary or invented counters',async t=>{
    const f=await fixture(t,state),value=await f.read();
    assert.equal(value.status,state);assert.equal(value.complete,false);assert.deepEqual(value.summary,{});
    assert.deepEqual(value.packages,[]);assert.equal(value.sourceFiles,null);assert.equal(value.source.sourceChangedDuringRun,null);
    assert.equal(value.lifecycle.state,state);assert.deepEqual(value.lifecycle.failure,f.manifest.lifecycle.failure);
    assert.deepEqual(value.lifecycle.cancellation,f.manifest.lifecycle.cancellation);validateOutput('verification_summary',value);
    await assert.rejects(f.gaps(),error=>error.code==='COVERAGE_TARGETS_UNAVAILABLE');
});

for(const state of ['preparing','running','finalizing'])test(state+' is retained evidence, not proof of a live process',async t=>{
    const f=await fixture(t,state);delete f.manifest.finishedAt;
    if(state==='running')f.manifest.lifecycle.steps=[{id:'unit:frontend',startedAt:start,finishedAt:null,result:null}];
    await f.save();const value=await f.read();assert.equal(value.status,'in-progress');assert.equal(value.complete,false);
    assert.equal(value.lifecycle.state,state);validateOutput('verification_summary',value);
});

async function passed(t){
    const f=await fixture(t,'passed');Object.assign(f.manifest,{complete:true,suiteCompletion:true,sourceChangedDuringRun:false,summary,
        packages:[{name:'frontend',passed:1,failed:0,skipped:0,todo:0,exitCode:0,excludedInfrastructureSuites:[],
            testFileInventory:{complete:true},reportValidation:{ok:true}}]});
    f.manifest.lifecycle.steps=[{id:'unit:frontend',startedAt:start,finishedAt:end,result:processResult()}];
    await f.save();return f;
}

test('completed lifecycle preserves selected-suite success and omission limits',async t=>{
    const f=await passed(t);let value=await f.read();assert.equal(value.status,'requested-suites-complete');validateOutput('verification_summary',value);
    f.manifest.packages[0].todo=1;f.manifest.complete=false;f.manifest.suiteCompletion=false;await f.save();
    value=await f.read();assert.equal(value.lifecycle.state,'passed');assert.equal(value.status,'incomplete');assert.equal(value.packages[0].todo,1);
});

const corruptions={
    'unsupported version':m=>m.lifecycle.schemaVersion=2,
    'unknown state':m=>m.lifecycle.state='green',
    'unknown step':m=>m.lifecycle.plannedSteps=['shell:arbitrary'],
    'duplicate plan':m=>m.lifecycle.plannedSteps.push('unit:frontend'),
    'substituted step':m=>m.lifecycle.steps[0].id='native',
    'reordered prefix':m=>{m.lifecycle.plannedSteps.push('native');m.lifecycle.steps[0].id='native';},
    'missing step':m=>m.lifecycle.steps=[],
    'unclean success':m=>m.lifecycle.steps[0].result.cleanup.noLiveDescendants=false,
    'unreaped success':m=>m.lifecycle.steps[0].result.leaderReaped=false,
    'nonzero success':m=>m.lifecycle.steps[0].result.exitCode=1,
    'pending terminal step':m=>{m.lifecycle.steps[0].finishedAt=null;m.lifecycle.steps[0].result=null;},
    'unknown failure':m=>m.lifecycle.failure={code:'SECRET_TOKEN_VALUE'},
    'finalization failure':m=>m.lifecycle.finalizationErrors.push({code:'COVERAGE_FINALIZATION_FAILED'}),
    'reversed time':m=>m.finishedAt='2026-10-24T01:00:00Z',
    'running with final timestamp':m=>{m.lifecycle.state='running';m.complete=false;m.suiteCompletion=false;},
    'failed with success flag':m=>{m.lifecycle.state='failed';m.lifecycle.failure={code:'COVERAGE_FAILED'};},
    'wrong package scope':m=>m.packages[0].name='catalog-service',
    'changed source completion':m=>m.sourceChangedDuringRun=true,
    'contradictory source identities':m=>{m.sourceBefore={trackedDiffSha256:'a'.repeat(64)};m.sourceAfter={trackedDiffSha256:'b'.repeat(64)};},
    'negative supplied counters':m=>{m.complete=false;m.suiteCompletion=false;m.packages[0].failed=-1;},
    'cancelled without cancellation':m=>{m.lifecycle.state='cancelled';m.lifecycle.failure={code:'CANCELLED'};m.complete=false;m.suiteCompletion=false;},
};
for(const [name,change]of Object.entries(corruptions))test('lifecycle cannot hide '+name,async t=>{
    const f=await passed(t);change(f.manifest);await f.save();await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT');
});

test('failed lifecycle retains known partial results and strips private process details',async t=>{
    const f=await passed(t);f.manifest.complete=false;f.manifest.suiteCompletion=false;f.manifest.lifecycle.state='failed';
    f.manifest.lifecycle.failure={code:'COVERAGE_FINALIZATION_FAILED'};
    f.manifest.lifecycle.finalizationErrors=[{code:'COVERAGE_FINALIZATION_FAILED'}];
    f.manifest.lifecycle.steps[0].result.command='PRIVATE_COMMAND';f.manifest.lifecycle.steps[0].result.environment={TOKEN:'PRIVATE_VALUE'};
    await f.save();const value=await f.read();assert.equal(value.status,'failed');assert.equal(value.packages[0].passed,1);
    assert.ok(!JSON.stringify(value).includes('PRIVATE_'));validateOutput('verification_summary',value);
});

test('legacy evidence keeps its existing strict summary requirements',async t=>{
    const f=await fixture(t);delete f.manifest.lifecycle;await f.save();
    await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT');
});
