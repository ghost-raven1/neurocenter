import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiagnostics} from '../dev-mcp/diagnostics.mjs';
import {validateOutput} from '../dev-mcp/output-validation.mjs';
import {readCoverageGaps} from '../dev-mcp/coverage-gaps.mjs';

const metric=(total,covered)=>({total,covered,skipped:0,pct:999});
const summary={lines:metric(12,6),statements:metric(15,6),functions:metric(3,1),branches:metric(8,3)};
const file='services/catalog-service/src/package-build/example.ts';

async function fixture(t){
    const metrics=structuredClone(summary);
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'neurocenter coverage targets ')));
    t.after(()=>rm(root,{recursive:true,force:true}));
    await writeFile(path.join(root,'package.json'),JSON.stringify({name:'neurocenter-workspace'}));
    const folder=path.join(root,'.run/coverage/owned');await mkdir(folder,{recursive:true});
    const report='.run/coverage/owned/manifest.json';
    const manifest={schemaVersion:2,profile:'unit-safe',coverageKind:'vitest-ast-v8',comparablePercentages:true,
        finishedAt:'2026-10-23T00:00:00Z',complete:true,sourceChangedDuringRun:false,
        packages:[{name:'catalog-service',passed:2,failed:0,skipped:0,todo:0,exitCode:0,excludedInfrastructureSuites:['test/example-db.test.ts'],testFileInventory:{complete:true},reportValidation:{ok:true}}],
        sourceInventory:{schemaVersion:1,inventoryComplete:true,files:[{path:file,role:'production',measurement:'represented'},
            {path:'services/catalog-service/src/missing.ts',role:'production',measurement:'unrepresented'},
            {path:'frontend/src/private.ts',role:'production',measurement:'unrepresented'}]},summary:metrics};
    const gaps={schemaVersion:1,profile:'unit-safe',coverageKind:'vitest-ast-v8',comparablePercentages:true,complete:true,sourceChangedDuringRun:false,
        gaps:[{file,module:'catalog-service/package-build',summary:structuredClone(metrics),uncoveredBranches:5,uncoveredFunctions:[{name:'retry',line:8},{name:'cancel',line:12}],uncoveredStatementLines:[8,9,12],risk:true},
            {file:'frontend/src/private.ts',module:'frontend/private',summary:structuredClone(metrics),uncoveredBranches:5,uncoveredFunctions:[],uncoveredStatementLines:[2],risk:false}]};
    const save=async()=>{await writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest));await writeFile(path.join(folder,'gaps.json'),JSON.stringify(gaps));};
    await save();return {root,folder,report,manifest,gaps,save,diagnostics:await createDiagnostics(root)};
}

test('Coverage targets retain measured gaps, missing sources and excluded suites in the requested package',async t=>{
    const f=await fixture(t),value=await f.diagnostics.coverageGaps(f.report,'catalog-service',1);
    assert.equal(value.package,'catalog-service');assert.equal(value.complete,true);assert.equal(value.testCounters[0].todo,0);validateOutput('coverage_gaps',value);assert.equal(value.targets.length,1);assert.equal(value.targets[0].file,file);
    assert.equal(value.targets[0].summary.lines.pct,50,'Recompute percentages from counters, never trust a saved pct');
    assert.equal(value.targets[0].uncoveredBranches,5);assert.deepEqual(value.targets[0].uncoveredFunctions,[{name:'retry',line:8},{name:'cancel',line:12}]);
    assert.deepEqual(value.unrepresentedFiles,['services/catalog-service/src/missing.ts']);
    assert.deepEqual(value.excludedSuites,['test/example-db.test.ts']);assert.equal(value.source.status,'not-fully-verified');
    assert.match(value.gapsSha256,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(value).includes('frontend/src/private.ts'));assert.match(value.evidence,/never instructions/);
});

test('Mixed instrumentation keeps counters without comparable percentages or a near100 claim',async t=>{
    const f=await fixture(t);for(const report of[f.manifest,f.gaps]){report.comparablePercentages=false;report.coverageKind='experimental-mixed-instrumentation';}
    await f.save();const value=await f.diagnostics.coverageGaps(f.report,'catalog-service');
    assert.equal(value.targets[0].summary.branches.pct,null);assert.equal(value.comparablePercentages,false);
});

test('Coverage targets reject unrelated, unfinished, malformed or mismatched reports',async t=>{
    const f=await fixture(t);
    for(const args of[['.env','catalog-service',1],[f.report,'unknown',1],[f.report,'catalog-service',0],[f.report,'catalog-service',21],[f.report,'catalog-service',1.5],[f.report,'frontend',1]]){
        await assert.rejects(f.diagnostics.coverageGaps(...args),error=>['INVALID_ARGUMENT','PACKAGE_NOT_MEASURED'].includes(error.code));
    }
    delete f.manifest.finishedAt;await f.save();await assert.rejects(f.diagnostics.coverageGaps(f.report,'catalog-service'),error=>error.code==='REPORT_IN_PROGRESS');
    f.manifest.finishedAt='2026-10-23T00:00:00Z';f.gaps.profile='other';await f.save();
    await assert.rejects(f.diagnostics.coverageGaps(f.report,'catalog-service'),error=>error.code==='MALFORMED_REPORT');
    f.gaps.profile='unit-safe';f.gaps.gaps[0].summary.functions.covered=99;await f.save();
    assert.equal((await f.diagnostics.verificationSummary(f.report)).status,'requested-suites-complete','Only the gap payload is malformed');
    await assert.rejects(f.diagnostics.coverageGaps(f.report,'catalog-service'),error=>error.code==='MALFORMED_REPORT');
});

test('Gap output is bounded and never follows a source or report symlink',async t=>{
    const f=await fixture(t),target=f.gaps.gaps[0];
    target.uncoveredFunctions=Array.from({length:80},(_,i)=>({name:'function'+i,line:i+1}));
    target.summary.functions=metric(80,0);target.uncoveredStatementLines=Array.from({length:90},(_,i)=>i+1);
    f.gaps.gaps=Array.from({length:25},(_,i)=>({...target,file:'services/catalog-service/src/file'+i+'.ts'}));await f.save();
    f.manifest.sourceInventory.files=f.gaps.gaps.map(item=>({path:item.file,role:'production',measurement:'represented'}));await f.save();
    const value=await f.diagnostics.coverageGaps(f.report,'catalog-service',2);
    assert.equal(value.targets.length,2);assert.equal(value.totalTargets,25);assert.equal(value.truncated,true);
    assert.equal(value.targets[0].uncoveredFunctions.length,20);assert.equal(value.targets[0].uncoveredStatementLines.length,40);
    await rm(path.join(f.folder,'gaps.json'));await symlink(path.join(f.folder,'manifest.json'),path.join(f.folder,'gaps.json'));
    await assert.rejects(f.diagnostics.coverageGaps(f.report,'catalog-service'),error=>error.code==='UNSAFE_FILE');
});

test('Untrusted gap paths cannot escape the measured package or expose arbitrary names',async t=>{
    const f=await fixture(t);f.gaps.gaps[0].file='services/catalog-service/src/../../../../.env';await f.save();
    await assert.rejects(f.diagnostics.coverageGaps(f.report,'catalog-service'),error=>error.code==='MALFORMED_REPORT');
});

for(const scenario of['absent','unrepresented','duplicate'])test('A '+scenario+' target cannot borrow the selected report provenance',async t=>{
    const f=await fixture(t);
    if(scenario==='absent')f.manifest.sourceInventory.files=[];
    else if(scenario==='unrepresented')f.manifest.sourceInventory.files[0].measurement='unrepresented';
    else f.gaps.gaps.push(f.gaps.gaps[0]);
    await f.save();await assert.rejects(f.diagnostics.coverageGaps(f.report,'catalog-service'),error=>error.code==='MALFORMED_REPORT');
});

test('A changed manifest between summary and target reads cannot reuse the former fingerprint',async t=>{
    const f=await fixture(t),verification=await f.diagnostics.verificationSummary(f.report);
    f.manifest.packages[0].passed=3;await f.save();
    await assert.rejects(readCoverageGaps(f.root,f.report,'catalog-service',10,verification),error=>error.code==='FILE_CHANGED');
});

test('Retained package entries preserve distinct exclusions from every run without double counting',async t=>{
    const f=await fixture(t);f.manifest.packages.push({...structuredClone(f.manifest.packages[0]),excludedInfrastructureSuites:['test/example-db.test.ts','test/other-db.test.ts']});
    await f.save();const value=await f.diagnostics.coverageGaps(f.report,'catalog-service');
    assert.equal(value.excludedSuiteCount,2);assert.deepEqual(value.excludedSuites,['test/example-db.test.ts','test/other-db.test.ts']);assert.match(value.exclusionScope,/Distinct unit/);
});

test('HTTP-only reports explain the missing unit package scope instead of inferring it from executed source',async t=>{
    const f=await fixture(t);f.manifest.packages=[];f.manifest.native={passed:1,failed:0,skipped:0,cancelled:0,exitCode:0};await f.save();
    await assert.rejects(f.diagnostics.coverageGaps(f.report,'catalog-service'),error=>error.code==='PACKAGE_NOT_MEASURED'&&/HTTP-only/.test(error.message));
});

for(const todo of [1,null,undefined])test('Coverage TODO '+String(todo)+' remains incomplete through summary and gap contracts',async t=>{
    const f=await fixture(t);if(todo===undefined)delete f.manifest.packages[0].todo;else f.manifest.packages[0].todo=todo;await f.save();
    const verification=await f.diagnostics.verificationSummary(f.report),gaps=await f.diagnostics.coverageGaps(f.report,'catalog-service');
    assert.equal(verification.complete,false);assert.equal(verification.status,'incomplete');assert.equal(verification.packages[0].todo,todo??null);
    assert.equal(gaps.complete,false);assert.equal(gaps.testCounters[0].todo,todo??null);assert.equal(gaps.verificationStatus,'incomplete');
    validateOutput('verification_summary',verification);validateOutput('coverage_gaps',gaps);
});

for(const key of ['todo','passed','failed','skipped'])for(const value of [-1,1.5,'0'])test('Coverage rejects malformed '+key+' counter '+String(value),async t=>{
    const f=await fixture(t);f.manifest.packages[0][key]=value;await f.save();
    await assert.rejects(f.diagnostics.verificationSummary(f.report),error=>error.code==='MALFORMED_REPORT');
});

test('Retained native TODO remains visible when no top-level native profile is present',async t=>{
    const f=await fixture(t);f.manifest.profile=f.gaps.profile='retained-runs-merge';
    f.manifest.inputs=[{native:{passed:2,failed:0,skipped:0,todo:1,cancelled:0,exitCode:0}}];await f.save();
    const verification=await f.diagnostics.verificationSummary(f.report);assert.equal(verification.complete,false);assert.equal(verification.retainedProfiles[0].native.todo,1);
    validateOutput('verification_summary',verification);
});

for(const profile of ['native','integration'])for(const todo of [0,1,undefined])test(profile+' TODO '+String(todo)+' is known or explicitly incomplete',async t=>{
    const f=await fixture(t);f.manifest[profile]={passed:1,failed:0,skipped:0,cancelled:0,exitCode:0,excludedSuites:[],...(todo===undefined?{}:{todo})};await f.save();
    const value=await f.diagnostics.verificationSummary(f.report);assert.equal(value[profile].todo,todo??null);assert.equal(value.complete,todo===0);
    validateOutput('verification_summary',value);
});

for(const scenario of ['nested-failure','nested-invalid'])test('Retained profile '+scenario+' cannot hide behind an outer completion flag',async t=>{
    const f=await fixture(t);f.manifest.profile=f.gaps.profile='retained-runs-merge';
    const native={passed:1,failed:0,skipped:0,todo:0,cancelled:0,exitCode:0};
    if(scenario==='nested-failure')native.failed=1;else native.todo=-1;
    f.manifest.inputs=[{inputs:[{native}]}];await f.save();
    if(scenario==='nested-invalid')await assert.rejects(f.diagnostics.verificationSummary(f.report),error=>error.code==='MALFORMED_REPORT');
    else{const value=await f.diagnostics.verificationSummary(f.report);assert.equal(value.status,'failed');assert.equal(value.complete,false);}
});
