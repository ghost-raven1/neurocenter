import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {copyCoverageRuntime} from './coverage-runtime.fixture.mjs';

const counts={passed:1,failed:0,skipped:0,todo:0,exitCode:0};
for(const scenario of ['unit-todo','legacy-todo','invalid-todo','native-todo','nested-native-todo','lifecycle-failed','lifecycle-cancelled',
    'lifecycle-missing-package','lifecycle-extra-package','lifecycle-duplicate-package','lifecycle-unplanned-native',
    'lifecycle-source-changed','lifecycle-source-identity-mismatch','lifecycle-passed-control'])test('Retained merge preserves completion evidence for '+scenario,async t=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-coverage-completion-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const tools=await copyCoverageRuntime(root,'merge');
    const folder=path.join(root,'run'),output=path.join(root,'output');await fs.mkdir(path.join(folder,'merged'),{recursive:true});
    const manifest={schemaVersion:2,profile:'unit-safe',coverageKind:'vitest-ast-v8',comparablePercentages:true,finishedAt:'2026-10-24T00:00:00Z',complete:true,suiteCompletion:true,
        packages:[{...counts,name:'catalog-service',excludedInfrastructureSuites:[],testFileInventory:{complete:true},reportValidation:{ok:true}}]};
    if(scenario==='unit-todo')manifest.packages[0].todo=1;
    if(scenario==='legacy-todo')delete manifest.packages[0].todo;
    if(scenario==='invalid-todo')manifest.packages[0].todo=-1;
    if(scenario.endsWith('native-todo')){
        manifest.coverageKind='native-c8-v8';manifest.packages=[];const native={...counts,todo:1,cancelled:0,excludedSuites:[]};
        if(scenario==='native-todo')manifest.native=native;
        else{manifest.profile='retained-runs-merge';manifest.inputs=[{profile:'native-http',native}];}
    }
    let map={};
    if(scenario.startsWith('lifecycle-')){
        const state=scenario==='lifecycle-failed'?'failed':scenario==='lifecycle-cancelled'?'cancelled':'passed',cancelled=state==='cancelled';
        manifest.lifecycle={schemaVersion:1,state,plannedSteps:['unit:catalog-service'],steps:[{
            id:'unit:catalog-service',startedAt:'2026-10-23T23:59:00Z',finishedAt:'2026-10-23T23:59:01Z',
            result:{ok:true,exitCode:0,signal:null,durationMs:1000,leaderReaped:true,cleanup:{noLiveDescendants:true,zombiePids:[],signals:[]}},
        }],failure:state==='passed'?null:{code:cancelled?'CANCELLED':'COVERAGE_EXECUTION_FAILED'},cancellation:cancelled?{signal:'SIGTERM'}:null,finalizationErrors:[]};
        manifest.sourceChangedDuringRun=scenario==='lifecycle-source-changed';
        manifest.sourceBefore={head:'a'.repeat(40),status:'',trackedDiffSha256:'b'.repeat(64),untrackedContentSha256:'c'.repeat(64)};
        manifest.sourceAfter={...manifest.sourceBefore,...(scenario==='lifecycle-source-identity-mismatch'?{trackedDiffSha256:'d'.repeat(64)}:{})};
        if(scenario==='lifecycle-missing-package')manifest.packages=[];
        if(scenario==='lifecycle-extra-package')manifest.packages.push({...manifest.packages[0],name:'frontend'});
        if(scenario==='lifecycle-duplicate-package')manifest.packages.push({...manifest.packages[0]});
        if(scenario==='lifecycle-unplanned-native')manifest.native={...counts,cancelled:0,excludedSuites:[]};
        const source=path.join(root,'services/catalog-service/src/entry.ts');await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,'export const value=1;\n');
        map={[source]:{path:source,statementMap:{0:{start:{line:1,column:0},end:{line:1,column:21}}},fnMap:{},branchMap:{},s:{0:1},f:{},b:{}}};
    }
    await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest));await fs.writeFile(path.join(folder,'merged/coverage-final.json'),JSON.stringify(map));
    const result=spawnSync(process.execPath,[path.join(tools,'merge.mjs'),'--run',folder,'--output',output],{cwd:root,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stdout+result.stderr);const retained=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'));
    assert.equal(retained.complete,scenario==='lifecycle-passed-control');assert.equal(retained.suiteCompletion,scenario==='lifecycle-passed-control');
    if(scenario.endsWith('native-todo'))assert.equal(retained.retainedProfiles[0].native.todo,1);
    else if(scenario==='lifecycle-missing-package')assert.deepEqual(retained.packages,[]);
    else assert.equal(retained.packages[0].todo,manifest.packages[0].todo);
    if(scenario.startsWith('lifecycle-')){
        assert.equal(retained.inputs[0].complete,true,'The stale success claim is retained as input evidence only.');
        assert.equal(retained.summary.lines.covered,1,'Available coverage hits survive rejection of the stale completion claim.');
        assert.equal(retained.packages.length,manifest.packages.length);
        if(manifest.packages.length)assert.equal(retained.packages[0].passed,1);
    }
});
