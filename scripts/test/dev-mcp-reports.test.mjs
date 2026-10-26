import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,rm,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readRunSummary} from '../dev-mcp/run-reports.mjs';

const head='a'.repeat(40),hash='b'.repeat(64),git={available:true,head,dirty:{clean:true}};
const startedAt='2026-10-23T01:00:00.000Z',finishedAt='2026-10-23T01:01:00.000Z';
const checkPath='.run/check/fixture/report.json',buildPath='.run/isolated-build/fixture/receipt.json';
const counters={passed:12,failed:0,skipped:0,todo:0};
const step={name:'frontend: test',ok:true,exitCode:0,signal:null,durationMs:100,tests:counters};
function checkReport(){return {schemaVersion:2,selection:{packages:['frontend'],steps:['test']},state:'passed',startedAt,finishedAt,updatedAt:finishedAt,success:true,
    plannedSteps:[step.name],steps:[structuredClone(step)]};}
function buildReport(){return {schemaVersion:1,selectedPackages:['frontend'],startedAt,finishedAt,status:'built-current-snapshot',ok:true,
    inputs:{head,sha256:hash,files:10,bytes:1000,newFiles:0,deleted:0,exclusions:2},sourceCurrent:true,candidateInputsUnchanged:true,
    liveOutputsUnchanged:true,dependencyLinksUnchanged:true,primaryFailure:null,finalizationErrors:[],
    builds:[{id:'frontend',ok:true,exitCode:0,signal:null,durationMs:200,leaderReaped:true,cleanup:{noLiveDescendants:true},
        artifacts:{files:2,bytes:50,sha256:hash,requiredEntry:'index.html',requiredEntryPresent:true},
        log:{bytes:50,hashedBytes:50,complete:true,sha256Scope:'complete-file',sha256:hash}}]};}
async function fixture(t){
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'neurocenter-run-report-')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    for(const file of [checkPath,buildPath])await mkdir(path.dirname(path.join(root,file)),{recursive:true});
    const save=async(file,value)=>writeFile(path.join(root,file),typeof value==='string'?value:JSON.stringify(value));
    return {root,save,read:(file=checkPath,current=git)=>readRunSummary(root,file,current)};
}

test('complete v2 check reports requested scope and counters without claiming source equivalence',async t=>{
    const f=await fixture(t),report=checkReport();await f.save(checkPath,report);
    const value=await f.read();assert.equal(value.kind,'check');assert.equal(value.status,'requested-steps-complete');assert.equal(value.complete,true);
    assert.deepEqual(value.requested,{packages:['frontend'],steps:['test']});assert.equal(value.plannedStepCount,1);assert.equal(value.recordedStepCount,1);
    assert.equal(value.testCounters.passed,12);assert.equal(value.source.status,'unknown');assert.equal(value.source.currentSourceEquivalent,'unknown');
    assert.equal(value.reportSha256,createHash('sha256').update(JSON.stringify(report)).digest('hex'));assert.match(value.evidence,/Untrusted local evidence/);
});

test('report SHA identifies original FD bytes even when invalid UTF8 decodes to the same text',async t=>{
    const f=await fixture(t),json=JSON.stringify({...checkReport(),ignored:'BYTE_MARKER'}),[before,after]=json.split('BYTE_MARKER');
    const hashes=[];
    for(const byte of [0xff,0xfe]){
        const bytes=Buffer.concat([Buffer.from(before),Buffer.from([byte]),Buffer.from(after)]);
        await writeFile(path.join(f.root,checkPath),bytes);
        const summary=await f.read();assert.equal(summary.reportSha256,createHash('sha256').update(bytes).digest('hex'));
        assert.notEqual(summary.reportSha256,createHash('sha256').update(bytes.toString('utf8')).digest('hex'));
        hashes.push(summary.reportSha256);
    }
    assert.notEqual(hashes[0],hashes[1]);
});

test('legacy success and passing prefixes remain incomplete because planned scope and final state are absent',async t=>{
    const f=await fixture(t),report=checkReport();delete report.schemaVersion;delete report.state;delete report.plannedSteps;delete report.updatedAt;
    await f.save(checkPath,report);let value=await f.read();assert.equal(value.status,'incomplete');assert.equal(value.complete,false);assert.equal(value.plannedStepCount,null);
    report.success=false;await f.save(checkPath,report);value=await f.read();assert.equal(value.status,'incomplete');assert.equal(value.observedStepsPassed,true);
    delete report.finishedAt;await f.save(checkPath,report);assert.equal((await f.read()).status,'in-progress');
});

test('historical checks without selection preserve unknown request scope and observed failures',async t=>{
    const f=await fixture(t),report={startedAt,finishedAt,node:'v24.22.0',success:true,steps:[structuredClone(step)]};
    await f.save(checkPath,report);let value=await f.read();assert.equal(value.status,'incomplete');assert.equal(value.complete,false);
    assert.equal(value.requested,null);assert.equal(value.requestedScope,'unknown');assert.equal(value.recordedStepCount,1);assert.equal(value.testCounters.passed,12);
    report.success=false;report.steps[0].ok=false;report.steps[0].exitCode=1;await f.save(checkPath,report);assert.equal((await f.read()).status,'failed');
    report.steps[0].exitCode=null;report.steps[0].signal='SIGTERM';await f.save(checkPath,report);value=await f.read();assert.equal(value.status,'cancelled');assert.equal(value.requestedScope,'unknown');
    const modern=checkReport();delete modern.selection;await f.save(checkPath,modern);await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT');
});

test('running checks retain requested plan separately from recorded steps',async t=>{
    const f=await fixture(t),report=checkReport();report.state='running';report.success=false;delete report.finishedAt;report.updatedAt=startedAt;
    report.selection.steps=[];report.plannedSteps=['frontend: typecheck','frontend: build','frontend: test'];report.steps=[{...step,name:report.plannedSteps[0]}];
    await f.save(checkPath,report);const value=await f.read();assert.equal(value.status,'in-progress');assert.equal(value.plannedStepCount,3);assert.equal(value.recordedStepCount,1);
    report.steps=[];await f.save(checkPath,report);assert.equal((await f.read()).observedStepsPassed,false);
});

test('complete common checks accept only the fixed shared gate names',async t=>{
    const f=await fixture(t),report=checkReport();report.selection={packages:[],steps:[]};report.plannedSteps=['Agent kit: актуальность генерации','Общие контракты, production и упаковка','Compose: dev','Compose: локальные эмбеддинги'];
    report.steps=report.plannedSteps.map(name=>({...step,name,tests:{...counters,...(name==='Общие контракты, production и упаковка'?{cancelled:0}:{})}}));await f.save(checkPath,report);assert.equal((await f.read()).status,'requested-steps-complete');
    report.plannedSteps[0]='NEVER_RETURN_PRIVATE_TOKEN';report.steps[0].name=report.plannedSteps[0];await f.save(checkPath,report);
    await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT'&&!error.message.includes('PRIVATE_TOKEN'));
});

test('failed and cancelled checks cannot be turned successful through exit code alone',async t=>{
    const f=await fixture(t);
    for(const [signal,status]of [[null,'failed'],['SIGINT','cancelled'],['SIGTERM','cancelled'],['SIGKILL','failed']]){
        const report=checkReport();report.state='failed';report.success=false;Object.assign(report.steps[0],{ok:false,exitCode:signal?null:1,signal});
        await f.save(checkPath,report);const value=await f.read();assert.equal(value.status,status);assert.equal(value.complete,false);
    }
    const report=checkReport();report.state='failed';report.success=false;report.steps[0].ok=false;report.steps[0].tests.failed=1;
    await f.save(checkPath,report);assert.equal((await f.read()).status,'failed');
});

test('valid Node process signals including SIGILL remain failures while invented signal strings are rejected',async t=>{
    const f=await fixture(t);
    for(const signal of ['SIGILL','SIGFPE','SIGPIPE','SIGXCPU','SIGINFO','SIGPOLL']){
        const check=checkReport();check.state='failed';check.success=false;Object.assign(check.steps[0],{ok:false,exitCode:null,signal});
        await f.save(checkPath,check);let value=await f.read();assert.equal(value.status,'failed');assert.equal(value.steps[0].signal,signal);assert.equal(value.complete,false);
        const build=buildReport();build.status='failed';build.ok=false;build.primaryFailure={code:'BUILD_FAILED'};Object.assign(build.builds[0],{ok:false,exitCode:null,signal});
        await f.save(buildPath,build);value=await f.read(buildPath);assert.equal(value.status,'failed');assert.equal(value.builds[0].signal,signal);
    }
    const check=checkReport();check.state='failed';check.success=false;Object.assign(check.steps[0],{ok:false,exitCode:null,signal:'SIGILL_PRIVATE_TOKEN'});
    await f.save(checkPath,check);await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT'&&!error.message.includes('PRIVATE_TOKEN'));
});

test('skipped or todo counters preserve partial evidence even on a terminal passed check',async t=>{
    const f=await fixture(t);
    for(const key of ['skipped','todo']){const report=checkReport();report.steps[0].tests[key]=1;await f.save(checkPath,report);const value=await f.read();assert.equal(value.status,'incomplete');assert.equal(value.complete,false);}
});

test('historical Node gates with missing counters remain unknown rather than zero or complete',async t=>{
    const f=await fixture(t),report=v3Report();report.selection={packages:[],steps:[]};
    const common='Общие контракты, production и упаковка';report.plannedSteps=[common];report.steps[0].name=common;delete report.steps[0].tests;
    await f.save(checkPath,report);let value=await f.read();assert.equal(value.complete,false);assert.equal(value.status,'incomplete');
    assert.deepEqual(value.testCounters,{passed:null,failed:null,skipped:null,todo:null,cancelled:null,countedSteps:0,scope:value.testCounters.scope});
    report.steps[0].testRunner='node';await f.save(checkPath,report);await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT');
});

test('Node cancelled counters prevent complete and successful Node claims are consistent',async t=>{
    const f=await fixture(t),report=v3Report();report.selection={packages:[],steps:[]};
    const common='Общие контракты, production и упаковка';report.plannedSteps=[common];Object.assign(report.steps[0],{name:common,testRunner:'node',tests:{...counters,cancelled:0}});
    await f.save(checkPath,report);let value=await f.read();assert.equal(value.complete,true);assert.equal(value.testCounters.cancelled,0);
    report.steps[0].tests.cancelled=1;await f.save(checkPath,report);await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT');
    report.steps[0].ok=false;report.steps[0].exitCode=1;report.success=false;report.state='failed';report.failure={code:'TEST_REPORT_FAILED'};
    await f.save(checkPath,report);value=await f.read();assert.equal(value.complete,false);assert.equal(value.testCounters.cancelled,1);
});

test('selected typecheck has no implicit test gate and remains complete without counters',async t=>{
    const f=await fixture(t),report=v3Report();report.selection={packages:['frontend'],steps:['typecheck']};
    report.plannedSteps=['frontend: typecheck'];report.steps[0].name=report.plannedSteps[0];delete report.steps[0].tests;
    await f.save(checkPath,report);const value=await f.read();assert.equal(value.complete,true);assert.equal(value.testCounters.passed,0);assert.equal(value.testCounters.countedSteps,0);
});

test('forged check success, invented scope, contradictory results and duplicate steps are rejected',async t=>{
    const f=await fixture(t);
    const changes=[r=>{r.steps[0].ok=false;},r=>{r.steps[0].exitCode=2;},r=>{r.steps[0].tests.failed=1;},r=>{r.steps[0].tests.passed=-1;},
        r=>{r.steps[0].reportError='secret';},r=>{r.steps[0].errorCode='secret';},r=>{r.steps[0].signal='SIGINT';},r=>{r.steps[0].name='services/catalog-service: test';},r=>{r.startedAt='2026-02-30T01:00:00Z';},
        r=>{r.plannedSteps.push('frontend: build');},r=>{r.steps=[];},r=>{r.steps.push(structuredClone(r.steps[0]));},r=>{r.plannedSteps.push(r.plannedSteps[0]);},
        r=>{r.state='running';},r=>{delete r.finishedAt;},r=>{r.schemaVersion=20;},r=>{r.state='unknown';},r=>{r.success=false;},r=>{r.startedAt=finishedAt;r.finishedAt=startedAt;}];
    for(const change of changes){const report=checkReport();change(report);await f.save(checkPath,report);await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT');}
});

test('complete build receipt summarizes a retained snapshot without equating it to current sources',async t=>{
    const f=await fixture(t);await f.save(buildPath,buildReport());const value=await f.read(buildPath);
    assert.equal(value.status,'built-snapshot');assert.equal(value.complete,true);assert.equal(value.kind,'isolated-build');assert.deepEqual(value.requestedPackages,['frontend']);
    assert.equal(value.source.status,'not-fully-verified');assert.equal(value.source.currentSourceEquivalent,'unknown');assert.equal(value.inputs.sha256,hash);
    assert.equal(value.builds[0].processClean,true);assert.equal(value.builds[0].artifacts.requiredEntryPresent,true);
});

test('stale HEAD, current dirty files and unavailable Git never promise current snapshot equivalence',async t=>{
    const f=await fixture(t);await f.save(buildPath,buildReport());
    for(const [current,status]of [[{...git,head:'c'.repeat(40)},'head-mismatch'],[{...git,dirty:{clean:false}},'dirty-source-not-verified'],[{available:false},'not-fully-verified']]){
        const value=await f.read(buildPath,current);assert.equal(value.source.status,status);assert.equal(value.source.currentSourceEquivalent,'unknown');
    }
    await f.save(checkPath,checkReport());const check=await f.read(checkPath,{...git,dirty:{clean:false}});assert.equal(check.source.status,'unknown');assert.equal(check.source.workingTree,'dirty');
});

test('building, failed partial, cancelled and failed finalization receipts remain distinct',async t=>{
    const f=await fixture(t),running=buildReport();running.status='building';running.ok=false;delete running.finishedAt;running.builds=[];
    await f.save(buildPath,running);assert.equal((await f.read(buildPath)).status,'in-progress');
    const partial=buildReport();partial.status='failed';partial.ok=false;partial.selectedPackages.push('catalog-service');partial.primaryFailure={code:'BUILD_FAILED'};
    await f.save(buildPath,partial);let value=await f.read(buildPath);assert.equal(value.status,'failed');assert.equal(value.recordedBuildCount,1);assert.equal(value.requestedPackages.length,2);
    partial.status='cancelled';partial.primaryFailure={code:'CANCELLED'};await f.save(buildPath,partial);assert.equal((await f.read(buildPath)).status,'cancelled');
    const finalized=buildReport();finalized.ok=false;finalized.status='failed';finalized.sourceCurrent=false;finalized.primaryFailure={code:'SOURCE_CHANGED_AFTER_SNAPSHOT'};
    finalized.finalizationErrors=[finalized.primaryFailure];await f.save(buildPath,finalized);value=await f.read(buildPath);assert.equal(value.status,'failed');assert.equal(value.checks.sourceCurrent,false);
    const early=buildReport();early.ok=false;early.status='failed';early.inputs=null;early.builds=[];early.primaryFailure={code:'INPUT_UNAVAILABLE'};
    await f.save(buildPath,early);assert.equal((await f.read(buildPath)).status,'failed');
    const interrupted=buildReport();interrupted.ok=false;interrupted.status='building';delete interrupted.finishedAt;
    interrupted.builds[0].ok=false;interrupted.builds[0].exitCode=1;await f.save(buildPath,interrupted);assert.equal((await f.read(buildPath)).status,'failed');
    interrupted.builds[0].failure={code:'CANCELLED'};await f.save(buildPath,interrupted);assert.equal((await f.read(buildPath)).status,'cancelled');
});

test('forged build success rejects missing packages, failed checks, artifact/log inconsistencies and unsafe counters',async t=>{
    const f=await fixture(t);
    const changes=[r=>{r.builds=[];},r=>{r.selectedPackages.push('catalog-service');},r=>{r.builds[0].id='bridge';},r=>{r.selectedPackages=['not-a-package'];},
        r=>{r.sourceCurrent=false;},r=>{r.candidateInputsUnchanged=null;},r=>{r.liveOutputsUnchanged=false;},r=>{r.dependencyLinksUnchanged=false;},
        r=>{r.primaryFailure={code:'BUILD_FAILED'};},r=>{r.finalizationErrors=[{code:'BUILD_FAILED'}];},r=>{r.inputs.sha256='wrong';},r=>{r.inputs=null;},
        r=>{r.builds[0].exitCode=1;},r=>{r.builds[0].cleanup.noLiveDescendants=false;},r=>{r.builds[0].leaderReaped=false;},r=>{delete r.builds[0].artifacts;},
        r=>{r.builds[0].artifacts.requiredEntryPresent=false;},r=>{r.builds[0].artifacts.requiredEntry='wrong.js';},r=>{r.builds[0].artifacts.files=0;},r=>{r.builds[0].log.complete=false;},r=>{r.builds[0].log.hashedBytes=0;},
        r=>{r.builds[0].durationMs=Number.MAX_SAFE_INTEGER+1;},r=>{delete r.finishedAt;},r=>{r.status='building';},r=>{r.schemaVersion=2;}];
    for(const change of changes){const report=buildReport();change(report);await f.save(buildPath,report);await assert.rejects(f.read(buildPath),error=>error.code==='MALFORMED_REPORT');}
});

test('report output excludes untrusted logs, commands, messages, environment and arbitrary paths',async t=>{
    const f=await fixture(t),secret='NEVER_RETURN_PRIVATE_TOKEN';
    for(const [file,report]of [[checkPath,checkReport()],[buildPath,buildReport()]]){
        Object.assign(report,{command:[secret],error:secret,log:secret,repository:secret,environmentKeys:[secret],limitations:[secret]});
        const recorded=(report.steps??report.builds)[0];Object.assign(recorded,{command:[secret],log:{...recorded.log,path:secret},error:secret});
        await f.save(file,report);const value=await f.read(file,{available:false,head:secret,dirty:{clean:false}});assert.equal(JSON.stringify(value).includes(secret),false);
    }
    const failed=buildReport();Object.assign(failed,{status:'failed',ok:false,primaryFailure:{code:secret,message:secret},finalizationErrors:[{code:secret,message:secret}]});
    await f.save(buildPath,failed);assert.equal(JSON.stringify(await f.read(buildPath)).includes(secret),false);
});

test('selection is confined to one canonical run filename and malformed data errors do not echo source',async t=>{
    const f=await fixture(t);
    for(const file of ['.env','/tmp/receipt.json','.run/check/../report.json','.run/check/a/b/report.json','.run/check/a/receipt.json',
        '.run/isolated-build/a/report.json','.run/check/a\\b/report.json','.run/check/%2e%2e/report.json']){
        await assert.rejects(f.read(file),error=>error.code==='INVALID_ARGUMENT');
    }
    for(const report of ['{NEVER_RETURN_PRIVATE_TOKEN','null','[]','{}']){await f.save(checkPath,report);await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT'&&!error.message.includes('PRIVATE_TOKEN'));}
});

test('dotted run directory names follow the shared run catalog contract',async t=>{
    const f=await fixture(t),file='.run/check/fixture.2026-10-23/report.json';
    await mkdir(path.dirname(path.join(f.root,file)),{recursive:true});await f.save(file,checkReport());
    const value=await f.read(file);assert.equal(value.report,file);assert.equal(value.status,'requested-steps-complete');
});

test('oversized files, symlinked files/ancestors and hardlinks are blocked before parsing',async t=>{
    const f=await fixture(t);await f.save(checkPath,'x'.repeat(1024**2+1));await assert.rejects(f.read(),error=>error.code==='FILE_TOO_LARGE');
    const outside=path.join(f.root,'private.json');await writeFile(outside,JSON.stringify(checkReport()));
    await rm(path.join(f.root,checkPath));await symlink(outside,path.join(f.root,checkPath));await assert.rejects(f.read(),error=>error.code==='UNSAFE_FILE');
    await rm(path.join(f.root,checkPath));await link(outside,path.join(f.root,checkPath));await assert.rejects(f.read(),error=>error.code==='UNSAFE_FILE');
    await rm(path.join(f.root,'.run/check/fixture'),{recursive:true});await symlink(f.root,path.join(f.root,'.run/check/fixture'));await assert.rejects(f.read(),error=>error.code==='UNSAFE_FILE');
});

function v3Report(){
    const report=checkReport();report.schemaVersion=3;
    const snapshot={head,sha256:hash,files:10,bytes:100,newFiles:1,deleted:1,exclusions:0};
    report.source={status:'unchanged',before:structuredClone(snapshot),after:structuredClone(snapshot)};
    report.failure=null;report.cancellation=null;Object.assign(report.steps[0],{leaderReaped:true,cleanup:{noLiveDescendants:true,signals:[],zombieCount:0}});return report;
}
test('v3 source summary preserves recorded before/after bytes without rehashing current files',async t=>{
    const f=await fixture(t),report=v3Report();await f.save(checkPath,report);await writeFile(path.join(f.root,'current-source.txt'),'changed-after-recorded-run');
    const value=await f.read();assert.equal(value.complete,true);assert.equal(value.status,'requested-steps-complete');assert.equal(value.source.status,'unchanged');
    assert.deepEqual(value.source.before,report.source.before);assert.deepEqual(value.source.after,report.source.after);assert.equal(value.source.currentSourceEquivalent,'unknown');
    assert.equal(value.steps[0].cleanup.noLiveDescendants,true);assert.equal(JSON.stringify(value).includes('current-source.txt'),false);
});
test('v3 unavailable source, changed source, cancellation and timeout retain distinct incomplete outcomes',async t=>{
    const f=await fixture(t),unknown=v3Report();unknown.source={status:'unknown',before:null,after:null,reason:'SOURCE_DISABLED'};
    await f.save(checkPath,unknown);let value=await f.read();assert.equal(value.complete,false);assert.equal(value.status,'incomplete');assert.equal(value.reportedSuccess,true);
    const changed=v3Report();changed.state='failed';changed.success=false;changed.source.status='changed';changed.source.after.sha256='c'.repeat(64);changed.failure={code:'SOURCE_CHANGED'};
    await f.save(checkPath,changed);value=await f.read();assert.equal(value.status,'failed');assert.equal(value.source.status,'changed');assert.equal(value.steps[0].ok,true);assert.equal(value.failure.code,'SOURCE_CHANGED');
    const cancelled=v3Report();Object.assign(cancelled,{state:'cancelled',success:false,failure:{code:'CANCELLED'},cancellation:{signal:'SIGINT'},steps:[]});
    await f.save(checkPath,cancelled);value=await f.read();assert.equal(value.status,'cancelled');assert.equal(value.recordedStepCount,0);
    const timeout=v3Report();Object.assign(timeout,{state:'failed',success:false,failure:{code:'CHECK_TIMEOUT'}});Object.assign(timeout.steps[0],{ok:false,exitCode:null,signal:'SIGKILL',failure:{code:'CHECK_TIMEOUT'}});
    timeout.steps[0].cleanup.signals=['SIGTERM','SIGKILL'];await f.save(checkPath,timeout);value=await f.read();assert.equal(value.status,'failed');assert.equal(value.failure.code,'CHECK_TIMEOUT');
});
test('v3 forged provenance, process cleanup, unknown states and private failure strings are rejected',async t=>{
    const f=await fixture(t),changes=[r=>{r.source.before=null;},r=>{r.source.after.sha256='c'.repeat(64);},r=>{r.source.status='capturing';},
        r=>{r.source={status:'unknown',before:null,after:null,reason:'SOURCE_CHANGED'};},
        r=>{r.source.before.files=-1;},r=>{r.source.reason='PRIVATE_TOKEN';},r=>{r.steps[0].leaderReaped=false;},r=>{r.steps[0].cleanup.noLiveDescendants=false;},
        r=>{r.steps[0].cleanup.signals=['SIGKILL'];},r=>{r.steps[0].cleanup.zombieCount=-1;},r=>{r.failure={code:'PRIVATE_TOKEN'};},r=>{r.cancellation={signal:'SIGINT'};}];
    for(const change of changes){const report=v3Report();change(report);await f.save(checkPath,report);await assert.rejects(f.read(),error=>error.code==='MALFORMED_REPORT'&&!error.message.includes('PRIVATE_TOKEN'));}
});
