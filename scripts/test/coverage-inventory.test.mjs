import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import InventoryReporter from '../coverage/inventory-reporter.mjs';
import {reconcileTestFileInventory} from '../coverage/test-file-inventory.mjs';
import {nodeTestFiles} from '../workspace/check-plan.mjs';

const cwd=path.resolve('synthetic coverage project');
const inventory=moduleIds=>({schemaVersion:1,phase:'before-collection',cwd,moduleIds});
const report=files=>({testResults:files.map(name=>({name}))});
const check=(planned,reported,excluded=[])=>reconcileTestFileInventory({inventory:inventory(planned),report:report(reported),cwd,excluded});

test('A missing workspace-bounds result is incomplete even when every other selected file passed',()=>{
 const planned=['test/worker-heartbeat.test.ts','test/workspace-bounds.test.ts'];
 const result=check(planned,['test/worker-heartbeat.test.ts']);
 assert.equal(result.complete,false);assert.equal(result.expectedFileCount,2);assert.equal(result.reportedFileCount,1);
 assert.deepEqual(result.missingFiles,[path.join(cwd,planned[1])]);assert.deepEqual(result.unexpectedFiles,[]);
});
test('Resolved selection honors legitimate exclusions and normalizes absolute, relative and dot paths',()=>{
 const selected='test/worker-heartbeat.test.ts',excluded='test/restore-rag-db.test.ts';
 const result=check([path.join(cwd,selected)],['./test/../test/worker-heartbeat.test.ts'],[excluded]);
 assert.equal(result.complete,true);assert.deepEqual(result.expectedFiles,result.reportedFiles);
 assert.deepEqual(result.excludedFiles,[path.join(cwd,excluded)]);assert.deepEqual(result.missingFiles,[]);
});
test('An excluded or unrelated returned file is unexpected instead of being silently accepted',()=>{
 const result=check(['test/selected.test.ts'],['test/selected.test.ts','test/excluded.test.ts'],['test/excluded.test.ts']);
 assert.equal(result.complete,false);assert.deepEqual(result.unexpectedFiles,[path.join(cwd,'test/excluded.test.ts')]);
});
test('Duplicate receipts cannot hide a missing selected file or inflate apparent completion',()=>{
 const result=check(['test/one.test.ts','test/two.test.ts'],['test/one.test.ts','./test/one.test.ts']);
 assert.equal(result.complete,false);assert.deepEqual(result.duplicateReportedFiles,[path.join(cwd,'test/one.test.ts')]);
 assert.deepEqual(result.missingFiles,[path.join(cwd,'test/two.test.ts')]);
 assert.equal(check(['test/one.test.ts','./test/one.test.ts'],['test/one.test.ts']).complete,false);
});
test('Missing, malformed, wrong-phase and foreign-root inventory are fail closed',()=>{
 for(const planned of [null,{},inventory([]),{...inventory(['test/one.test.ts']),phase:'after-collection'},
  {...inventory(['test/one.test.ts']),cwd:path.resolve('another project')},inventory(['test/one.test.ts',null])]){
  assert.equal(reconcileTestFileInventory({inventory:planned,report:report(['test/one.test.ts']),cwd}).complete,false);
 }
 assert.equal(reconcileTestFileInventory({inventory:inventory(['test/one.test.ts']),report:null,cwd}).complete,false);
 assert.equal(check(['test/one.test.ts'],[null]).complete,false);
});
test('A failed collection file is present even with zero assertions; failure status remains the runner responsibility',()=>{
 const result=reconcileTestFileInventory({inventory:inventory(['test/one.test.ts']),report:{testResults:[{name:path.join(cwd,'test/one.test.ts'),status:'failed',assertionResults:[]}]},cwd});
 assert.equal(result.complete,true);assert.deepEqual(result.missingFiles,[]);
});
test('The start reporter writes exact planned modules privately before a subsequent collection failure',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-inventory-reporter-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const filename=path.join(directory,'selection.json'),before=process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE;
 t.after(()=>{if(before===undefined)delete process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE;else process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE=before;});
 process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE=filename;
 const reporter=new InventoryReporter(),moduleId=path.join(cwd,'test/workspace-bounds.test.ts');
 await reporter.onTestRunStart([{moduleId}]);
 const saved=JSON.parse(await fs.readFile(filename,'utf8'));assert.equal(saved.phase,'before-collection');
 assert.deepEqual(saved.moduleIds,[moduleId]);assert.equal(saved.cwd,process.cwd());assert.equal((await fs.stat(filename)).mode&0o777,0o600);
 const bytes=await fs.readFile(filename);await assert.rejects(reporter.onTestRunStart([{moduleId:'/changed.test.ts'}]),{code:'EEXIST'});
 assert.deepEqual(await fs.readFile(filename),bytes,'existing inventory evidence must not be overwritten');
 delete process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE;await assert.rejects(reporter.onTestRunStart([]),/explicit absolute/);
 process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE='relative.json';await assert.rejects(reporter.onTestRunStart([]),/explicit absolute/);
});

test('The inventory safety tests participate in the normal npm check discovery',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 assert.ok(nodeTestFiles(root).includes('scripts/test/coverage-inventory.test.mjs'));
});

const syntheticVitest=String.raw`
import fs from 'node:fs/promises';import path from 'node:path';
const scenario=process.env.SYNTHETIC_COVERAGE_CASE,cwd=process.cwd(),selected=path.join(cwd,'test/selected.test.ts'),missing=path.join(cwd,'test/workspace-bounds.test.ts');
const moduleIds=scenario==='success'?[selected]:[selected,missing];
await fs.writeFile(process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE,JSON.stringify({schemaVersion:1,phase:'before-collection',cwd,moduleIds}),{mode:0o600});
const testResults=[{name:selected,status:'passed',assertionResults:[{status:'passed',fullName:'selected assertion'}]}];
if(scenario==='suite-failed')testResults.push({name:missing,status:'failed',assertionResults:[]});
const report={success:scenario!=='suite-failed',numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,numTotalTests:1,numFailedTestSuites:scenario==='suite-failed'?1:0,testResults};
const filename=process.argv.find(arg=>arg.startsWith('--outputFile=')).slice('--outputFile='.length);await fs.writeFile(filename,JSON.stringify(report));
const source=path.join(cwd,'src/entry.ts');await fs.mkdir(process.env.NEUROCENTER_COVERAGE_DIR,{recursive:true});
await fs.writeFile(path.join(process.env.NEUROCENTER_COVERAGE_DIR,'coverage-final.json'),JSON.stringify({[source]:{path:source,statementMap:{0:{start:{line:1,column:0},end:{line:1,column:21}}},fnMap:{},branchMap:{},s:{0:1},f:{},b:{}}}));
// Every synthetic worker exits0; the actual copied coverage runner must independently reject bad receipts.
`;

for(const scenario of ['success','missing','suite-failed'])test('Actual runner preserves evidence and '+scenario+' receipts determine completion independently of worker exit0',async t=>{
 const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-coverage-runner-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const tools=path.join(root,'scripts/coverage'),pkg=path.join(root,'services/feature-flags-service'),output=path.join(root,'output');
 await Promise.all([fs.mkdir(tools,{recursive:true}),fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true}),fs.mkdir(path.join(root,'services/shared'),{recursive:true}),fs.mkdir(path.join(pkg,'node_modules/vitest'),{recursive:true}),fs.mkdir(path.join(pkg,'src'),{recursive:true}),fs.mkdir(path.join(pkg,'test'),{recursive:true})]);
 for(const file of ['run.mjs','profiles.mjs','owned-pg.mjs','methods.mjs','report.mjs','source-inventory.mjs','test-file-inventory.mjs','inventory-reporter.mjs','package.json'])await fs.copyFile(path.join(sourceRoot,'scripts/coverage',file),path.join(tools,file));
 await fs.copyFile(path.join(sourceRoot,'scripts/workspace/check-report.mjs'),path.join(root,'scripts/workspace/check-report.mjs'));
 for(const file of ['feature-flags.cjs','feature-flag-catalog.json'])await fs.copyFile(path.join(sourceRoot,'services/shared',file),path.join(root,'services/shared',file));
 // Provenance is synthetic here; all runner orchestration, report validation, inventory and rendering are unchanged.
 await fs.writeFile(path.join(tools,'source-identity.mjs'),'export const sourceIdentity=()=>({synthetic:true});\n');
 await fs.symlink(path.join(sourceRoot,'scripts/coverage/node_modules'),path.join(tools,'node_modules'),'dir');
 await fs.writeFile(path.join(pkg,'src/entry.ts'),'export const value=1;\n');
 for(const file of ['selected.test.ts','workspace-bounds.test.ts','excluded-db.test.ts'])await fs.writeFile(path.join(pkg,'test',file),'// synthetic test file\n');
 await fs.writeFile(path.join(pkg,'node_modules/vitest/vitest.mjs'),syntheticVitest);
 await fs.mkdir(path.join(root,'scripts/production'),{recursive:true});await fs.writeFile(path.join(root,'scripts/production/cli.mjs'),'throw Error("Must never execute an inventoried production CLI");\n');
 await fs.mkdir(path.join(root,'bridge-dist'),{recursive:true});await fs.writeFile(path.join(root,'bridge-dist/install.sh'),'#!/bin/bash\nexit 99\n');
 assert.equal(spawnSync('git',['init','--quiet'],{cwd:root}).status,0);
 const result=spawnSync(process.execPath,[path.join(tools,'run.mjs'),'--package','feature-flags-service','--output',output],{cwd:root,env:{PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,SYNTHETIC_COVERAGE_CASE:scenario},encoding:'utf8',timeout:15000});
 assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,scenario==='success'?0:1,result.stdout+'\n'+result.stderr);
 const manifest=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8')),item=manifest.packages[0];
 assert.equal(item.exitCode,0);assert.equal(manifest.complete,scenario==='success');assert.equal(manifest.suiteCompletion,scenario==='success');
 assert.equal(manifest.denominator.allWorkspaceSourcesIncluded,false);
 const sources=manifest.sourceInventory.files;
 assert.equal(sources.find(file=>file.path==='scripts/production/cli.mjs').measurement,'unrepresented');
 assert.equal(sources.find(file=>file.path==='bridge-dist/install.sh').measurement,'unsupported-runtime');
 assert.equal(sources.find(file=>file.path==='services/feature-flags-service/src/entry.ts').measurement,'represented');
 assert.match(await fs.readFile(path.join(output,'source-inventory.md'),'utf8'),/bridge-dist\/install\.sh/);
 assert.equal(item.passed,1);assert.equal(item.failed,0);assert.equal(item.testFileInventory.complete,scenario!=='missing');
 assert.equal(item.reportValidation.ok,scenario!=='suite-failed');assert.deepEqual(item.excludedInfrastructureSuites,['test/excluded-db.test.ts']);
 if(scenario==='missing')assert.deepEqual(item.testFileInventory.missingFiles,[path.join(pkg,'test/workspace-bounds.test.ts')]);
 const rawReport=JSON.parse(await fs.readFile(path.join(output,'feature-flags-service/test-results.json'),'utf8'));
 assert.equal(rawReport.numFailedTests,0);assert.equal(rawReport.numFailedTestSuites,scenario==='suite-failed'?1:0);
 assert.equal(rawReport.testResults.length,scenario==='suite-failed'?2:1);
 assert.equal(JSON.parse(await fs.readFile(path.join(output,'feature-flags-service/test-file-inventory.json'),'utf8')).phase,'before-collection');
});
