import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {coverageFixture,until,optionalJson,running} from './coverage-lifecycle.fixture.mjs';
import {createDiagnostics} from '../dev-mcp/diagnostics.mjs';
import {validateOutput} from '../dev-mcp/output-validation.mjs';

test('Timeout before the first collector report retains a failed incomplete manifest',async t=>{
    if(process.platform==='win32'){t.skip('POSIX process groups.');return;}
    const f=await coverageFixture(t,{scenario:'hang'}),result=await f.start({args:['--timeout-ms','350']}).ended;
    assert.notEqual(result.code,0,result.stdout+result.stderr);
    const manifest=await f.manifest();assert.ok(manifest,'A timeout must retain its first manifest before any collector report exists.');
    assert.equal(manifest.schemaVersion,2);assert.equal(manifest.complete,false);assert.equal(manifest.suiteCompletion,false);
    assert.equal(manifest.lifecycle.schemaVersion,1);assert.equal(manifest.lifecycle.state,'failed');
    assert.equal(manifest.lifecycle.steps.length,1);assert.equal(manifest.lifecycle.steps[0].id,'unit:frontend');
    assert.equal(manifest.lifecycle.steps[0].result.cleanup.noLiveDescendants,true);
    assert.match(manifest.lifecycle.failure.code,/TIMEOUT/);
    assert.ok(manifest.finishedAt);assert.equal(await optionalJson(path.join(f.output,'frontend/test-results.json')),null);
    const writer=await optionalJson(path.join(f.runtime,'writer.json'));if(writer)assert.equal(Boolean(running(writer.pid)),false);
    const diagnostics=await createDiagnostics(f.root),summary=await diagnostics.verificationSummary(f.relativeReport);
    assert.equal(summary.status,'failed');assert.equal(summary.complete,false);assert.equal(summary.lifecycle.failure.code,'COVERAGE_TIMEOUT');
    validateOutput('verification_summary',summary);
    await assert.rejects(diagnostics.coverageGaps(f.relativeReport,'frontend'),error=>error.code==='COVERAGE_TARGETS_UNAVAILABLE');
});

test('Malformed coverage collector JSON retains the completed test counters and terminal failure',async t=>{
    const f=await coverageFixture(t,{scenario:'invalid-json'}),result=await f.start().ended;
    assert.notEqual(result.code,0,result.stdout+result.stderr);
    assert.ok(await f.marker('frontend'),'The actual collector must run before rejecting its malformed coverage JSON.');
    const manifest=await f.manifest();assert.ok(manifest,'Malformed coverage data must not erase the run receipt.');
    assert.equal(manifest.complete,false);assert.equal(manifest.lifecycle.state,'failed');assert.ok(manifest.lifecycle.failure.code);
    const raw=JSON.parse(await fs.readFile(path.join(f.output,'frontend/test-results.json'),'utf8'));assert.equal(raw.numPassedTests,2);
    assert.equal(manifest.packages[0].passed,2);assert.equal(manifest.packages[0].failed,0);assert.ok(manifest.finishedAt);
});

test('Success preserves the exact requested plan, real source identity and test counters',async t=>{
    const f=await coverageFixture(t),result=await f.start({wrapper:true,args:['--timeout-ms','5000']}).ended;
    assert.equal(result.code,0,result.stdout+result.stderr);assert.equal(result.signal,null);
    const manifest=await f.manifest();assert.equal(manifest.complete,true);assert.equal(manifest.suiteCompletion,true);
    assert.equal(manifest.lifecycle.state,'passed');assert.deepEqual(manifest.lifecycle.plannedSteps,['unit:frontend']);
    assert.equal(manifest.lifecycle.steps.length,1);assert.equal(manifest.lifecycle.steps[0].result.ok,true);
    assert.equal(manifest.lifecycle.steps[0].result.cleanup.noLiveDescendants,true);
    assert.deepEqual([manifest.packages[0].passed,manifest.packages[0].failed,manifest.packages[0].skipped,manifest.packages[0].todo],[2,0,0,0]);
    assert.match(manifest.sourceBefore.head,/^[a-f0-9]{40}$/);assert.equal(manifest.sourceChangedDuringRun,false);
    assert.ok(manifest.finishedAt);assert.ok((await fs.stat(path.join(f.output,'merged/coverage-final.json'))).isFile());
    const diagnostics=await createDiagnostics(f.root),summary=await diagnostics.verificationSummary(f.relativeReport);
    assert.equal(summary.status,'requested-suites-complete');assert.equal(summary.complete,true);assert.equal(summary.packages[0].passed,2);
    validateOutput('verification_summary',summary);
    const gaps=await diagnostics.coverageGaps(f.relativeReport,'frontend');
    assert.equal(gaps.verificationStatus,'requested-suites-complete');assert.equal(gaps.complete,true);assert.equal(gaps.package,'frontend');
    validateOutput('coverage_gaps',gaps);
    const savedGaps=JSON.parse(await fs.readFile(path.join(f.output,'gaps.json'),'utf8'));
    assert.equal(savedGaps.sourceChangedDuringRun,manifest.sourceChangedDuringRun,'Published gaps and final manifest must refer to the same source observation.');
});

test('SIGTERM through the shipped wrapper stops its writer, retains cancellation and never starts the next package',async t=>{
    if(process.platform==='win32'){t.skip('POSIX process groups.');return;}
    const f=await coverageFixture(t,{scenario:'hang',packages:['frontend','bridge']});
    const outsider=spawn(process.execPath,['-e','setInterval(()=>{},50)'],{detached:true,stdio:'ignore'});
    t.after(()=>{try{process.kill(-outsider.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}});
    const run=f.start({wrapper:true,args:['--timeout-ms','10000']});
    const writer=await until(()=>optionalJson(path.join(f.runtime,'writer.json')),'writer start');
    await until(async()=>{const value=await fs.readFile(path.join(f.runtime,'writer.log'),'utf8').catch(()=>null);return value?.length;},'writer activity');
    run.child.kill('SIGTERM');const result=await run.ended;
    assert.notEqual(result.code,0);assert.equal(Boolean(running(outsider.pid)),true,'Cancellation must preserve an unrelated process.');
    assert.equal(Boolean(running(writer.pid)),false,'The SIGTERM-resistant writer must be stopped.');
    const before=await fs.readFile(path.join(f.runtime,'writer.log'),'utf8');await delay(80);assert.equal(await fs.readFile(path.join(f.runtime,'writer.log'),'utf8'),before);
    const manifest=await f.manifest();assert.ok(manifest);assert.equal(manifest.complete,false);assert.equal(manifest.lifecycle.state,'cancelled');
    assert.deepEqual(manifest.lifecycle.cancellation,{signal:'SIGTERM'});assert.deepEqual(manifest.lifecycle.plannedSteps,['unit:frontend','unit:bridge']);
    assert.equal(manifest.lifecycle.steps.length,1);assert.equal(manifest.lifecycle.steps[0].result.cleanup.noLiveDescendants,true,JSON.stringify(manifest.lifecycle.steps[0].result));
    assert.equal(await f.marker('bridge'),null,'Cancellation cannot advance into another package.');assert.ok(manifest.finishedAt);
});

test('Lifecycle flag off blocks new execution while the shipped help remains available',async t=>{
    const f=await coverageFixture(t),result=await f.start({wrapper:true,environment:{NEUROCENTER_COVERAGE_LIFECYCLE:'0'}}).ended;
    assert.notEqual(result.code,0);await assert.rejects(fs.stat(f.output),{code:'ENOENT'});assert.equal(await f.marker('frontend'),null);
    const help=await f.start({wrapper:true,args:['--help'],environment:{NEUROCENTER_COVERAGE_LIFECYCLE:'0'}}).ended;
    assert.equal(help.code,0,help.stderr);assert.match(help.stdout,/--timeout-ms/);await assert.rejects(fs.stat(f.output),{code:'ENOENT'});
});

test('Invalid timeout is rejected before output or collector startup',async t=>{
    const f=await coverageFixture(t);
    for(const value of ['0','-1','1.5','NaN','9007199254740992']){
        const result=await f.start({args:['--timeout-ms',value]}).ended;
        assert.notEqual(result.code,0);assert.match(result.stderr,/timeout/i);await assert.rejects(fs.stat(f.output),{code:'ENOENT'});assert.equal(await f.marker('frontend'),null);
    }
});

test('Invalid lifecycle feature flag is rejected before output or collector startup',async t=>{
    const f=await coverageFixture(t),result=await f.start({environment:{NEUROCENTER_COVERAGE_LIFECYCLE:'enabled'}}).ended;
    assert.notEqual(result.code,0);assert.match(result.stderr,/NEUROCENTER_COVERAGE_LIFECYCLE/);
    await assert.rejects(fs.stat(f.output),{code:'ENOENT'});assert.equal(await f.marker('frontend'),null);
});

test('Native no-unit timeout retains its own lifecycle and cleans the unfinished collector',async t=>{
    if(process.platform==='win32'){t.skip('POSIX process groups.');return;}
    const f=await coverageFixture(t,{packages:[],native:true}),result=await f.start({args:['--native','--no-unit','--timeout-ms','1000']}).ended;
    assert.notEqual(result.code,0);assert.ok(await f.marker('native'),'A real Node test collector must start in the separate native loop.');
    const manifest=await f.manifest();assert.ok(manifest);assert.equal(manifest.complete,false);assert.equal(manifest.suiteCompletion,false);
    assert.equal(manifest.profile,'native-http');assert.equal(manifest.lifecycle.state,'failed');
    assert.deepEqual(manifest.lifecycle.plannedSteps,['native']);assert.equal(manifest.lifecycle.steps.length,1);
    assert.equal(manifest.lifecycle.steps[0].id,'native');assert.equal(manifest.lifecycle.failure.code,'COVERAGE_TIMEOUT');
    assert.equal(manifest.lifecycle.steps[0].result.cleanup.noLiveDescendants,true);assert.ok(manifest.finishedAt);
    const writer=await optionalJson(path.join(f.runtime,'writer.json'));assert.ok(writer);assert.equal(Boolean(running(writer.pid)),false);
});

test('A failing unit assertion retains its finished JSON counters despite the collector exit1',async t=>{
    const f=await coverageFixture(t,{scenario:'test-failure'}),result=await f.start().ended;
    assert.notEqual(result.code,0);const manifest=await f.manifest();assert.ok(manifest);
    assert.equal(manifest.complete,false);assert.equal(manifest.lifecycle.state,'failed');
    const raw=JSON.parse(await fs.readFile(path.join(f.output,'frontend/test-results.json'),'utf8'));
    assert.deepEqual([raw.numPassedTests,raw.numFailedTests],[1,1]);
    assert.equal(manifest.packages.length,1);assert.deepEqual([manifest.packages[0].passed,manifest.packages[0].failed,manifest.packages[0].skipped,manifest.packages[0].todo],[1,1,0,0]);
    assert.equal(manifest.packages[0].exitCode,1);assert.equal(manifest.lifecycle.steps[0].result.exitCode,1);
    const summary=await (await createDiagnostics(f.root)).verificationSummary(f.relativeReport);
    assert.equal(summary.status,'failed');assert.equal(summary.packages[0].failed,1);validateOutput('verification_summary',summary);
});

test('A failing native assertion retains actual Node TAP counters after the subprocess exits',async t=>{
    if(process.platform==='win32'){t.skip('POSIX process groups.');return;}
    const f=await coverageFixture(t,{packages:[],native:'failure'}),result=await f.start({args:['--native','--no-unit','--timeout-ms','5000']}).ended;
    assert.notEqual(result.code,0);const manifest=await f.manifest();assert.ok(manifest);
    assert.equal(manifest.complete,false);assert.equal(manifest.lifecycle.state,'failed');assert.ok(manifest.native,'Finished TAP evidence must survive a failed subprocess.');
    const tap=await fs.readFile(path.join(f.output,'native/tests.log'),'utf8');
    assert.match(tap,/^# fail 1$/m);assert.equal(manifest.native.failed,1);assert.ok(manifest.native.passed>0);
    assert.equal(manifest.native.cancelled,0);assert.equal(manifest.native.exitCode,1);
    const summary=await (await createDiagnostics(f.root)).verificationSummary(f.relativeReport);
    assert.equal(summary.status,'failed');assert.equal(summary.native.failed,1);validateOutput('verification_summary',summary);
});

test('Missing collector dependencies preserve standalone help, disabled admission and an initial failed receipt',async t=>{
    const f=await coverageFixture(t);
    await fs.unlink(path.join(f.root,'scripts/coverage/node_modules'));
    const help=await f.start({wrapper:true,args:['--help']}).ended;
    assert.equal(help.code,0,help.stdout+help.stderr);assert.match(help.stdout,/--timeout-ms/);
    await assert.rejects(fs.stat(f.output),{code:'ENOENT'});
    const disabled=await f.start({wrapper:true,environment:{NEUROCENTER_COVERAGE_LIFECYCLE:'0'}}).ended;
    assert.notEqual(disabled.code,0);assert.match(disabled.stderr,/NEUROCENTER_COVERAGE_LIFECYCLE=0/);
    await assert.rejects(fs.stat(f.output),{code:'ENOENT'});assert.equal(await f.marker('frontend'),null);
    const failed=await f.start().ended;assert.notEqual(failed.code,0);
    const manifest=await f.manifest();assert.ok(manifest,'Dependency failure must retain the receipt written before loading collectors.');
    assert.equal(manifest.complete,false);assert.equal(manifest.suiteCompletion,false);assert.equal(manifest.lifecycle.state,'failed');
    assert.equal(manifest.lifecycle.failure.code,'COVERAGE_EXECUTION_FAILED');assert.deepEqual(manifest.lifecycle.steps,[]);
    assert.deepEqual(manifest.packages,[]);assert.equal(await f.marker('frontend'),null);assert.ok(manifest.finishedAt);
});

for(const fault of ['late-source','partial-gap-write'])test('Real gap generation with '+fault+' retains raw evidence and removes failed targets',async t=>{
    const f=await coverageFixture(t),entry=path.join(f.runtime,'gap-fault-wrapper.mjs');
    const wrapper='const injectedFault='+JSON.stringify(fault)+';\n'+String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const originalWrite=fs.writeFile,root=process.cwd(),fault=injectedFault;
let fired=false;
fs.writeFile=async function(...args){
 const result=await originalWrite(...args),trigger=fault==='late-source'?'gaps.md':'gaps.json';
 if(!fired&&path.basename(String(args[0]))===trigger){
  fired=true;await originalWrite(path.join(root,'runtime/fault-fired'),fault);
  if(fault==='late-source')await originalWrite(path.join(root,'frontend/src/entry.ts'),'export const value=2;\n');
  else throw Object.assign(Error('Controlled failure after the real gaps JSON write'),{code:'EIO'});
 }
 return result;
};
syncBuiltinESMExports();
const {main}=await import('../scripts/coverage/run.mjs');
process.exitCode=await main(process.argv.slice(2));
`;
    await fs.writeFile(entry,wrapper);
    const result=await f.start({entry}).ended;
    assert.notEqual(result.code,0,result.stdout+result.stderr);assert.equal(await fs.readFile(path.join(f.runtime,'fault-fired'),'utf8'),fault);
    const manifest=await f.manifest();assert.ok(manifest);assert.equal(manifest.complete,false);assert.equal(manifest.suiteCompletion,false);
    assert.equal(manifest.lifecycle.state,'failed');assert.equal(manifest.lifecycle.failure.code,fault==='late-source'?'SOURCE_CHANGED':'COVERAGE_FINALIZATION_FAILED');
    if(fault==='late-source')assert.equal(manifest.sourceChangedDuringRun,true);
    else assert.ok(manifest.lifecycle.finalizationErrors.some(item=>item.code==='COVERAGE_FINALIZATION_FAILED'));
    for(const file of ['gaps.json','gaps.md'])await assert.rejects(fs.stat(path.join(f.output,file)),{code:'ENOENT'});
    const rawMap=JSON.parse(await fs.readFile(path.join(f.output,'frontend/report/coverage-final.json'),'utf8'));
    assert.equal(rawMap[path.join(f.root,'frontend/src/entry.ts')].s[0],2);assert.equal(manifest.packages[0].passed,2);
    const diagnostics=await createDiagnostics(f.root),summary=await diagnostics.verificationSummary(f.relativeReport);
    assert.equal(summary.status,'failed');validateOutput('verification_summary',summary);
    await assert.rejects(diagnostics.coverageGaps(f.relativeReport,'frontend'),error=>error.code==='COVERAGE_TARGETS_UNAVAILABLE');
});
