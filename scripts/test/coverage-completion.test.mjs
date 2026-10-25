import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
const counts={passed:1,failed:0,skipped:0,todo:0,exitCode:0};
for(const scenario of ['unit-todo','legacy-todo','invalid-todo','native-todo','nested-native-todo'])test('Retained merge cannot promote '+scenario+' to complete',async t=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-coverage-completion-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const tools=path.join(root,'scripts/coverage');await fs.mkdir(tools,{recursive:true});
    for(const file of ['merge.mjs','profiles.mjs','methods.mjs','report.mjs','source-inventory.mjs','package.json'])await fs.copyFile(path.join(sourceRoot,'scripts/coverage',file),path.join(tools,file));
    await fs.symlink(path.join(sourceRoot,'scripts/coverage/node_modules'),path.join(tools,'node_modules'),'dir');
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
    await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest));await fs.writeFile(path.join(folder,'merged/coverage-final.json'),'{}');
    const result=spawnSync(process.execPath,[path.join(tools,'merge.mjs'),'--run',folder,'--output',output],{cwd:root,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stdout+result.stderr);const retained=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'));
    assert.equal(retained.complete,false);assert.equal(retained.suiteCompletion,false);
    if(scenario.endsWith('native-todo'))assert.equal(retained.retainedProfiles[0].native.todo,1);
    else assert.equal(retained.packages[0].todo,manifest.packages[0].todo);
});
