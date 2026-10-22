import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {collectSourceInventory,reconcileSourceInventory,mergeSourceInventories,repositorySourceFiles,writeSourceInventory} from '../coverage/source-inventory.mjs';
import {nodeTestFiles} from '../workspace/check-plan.mjs';

const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-source-inventory-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    assert.equal(spawnSync('git',['init','--quiet'],{cwd:root}).status,0);
    const put=async(file,text)=>{await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),text);};
    await put('.gitignore','node_modules/\nignored/\n.run/\n');
    await put('frontend/src/main.ts','export const value=1;\n');
    await put('services/shared/contract.cjs','module.exports={};\n');
    await put('scripts/production/recovery.mjs','throw Error("Inventory must never execute me");\n');
    await put('scripts/models/bundle-cli.mts','export const cli=true;\n');
    await put('bridge-dist/install.sh','#!/bin/bash\necho unavailable\n');
    await put('bridge-dist/install.ps1','Write-Host unavailable\n');
    await put('scripts/operator.py','raise RuntimeError("Do not execute")\n');
    await put('services/example/migrations/001.sql','CREATE TABLE own_fixture(id integer);\n');
    await put('mcp/neurocenter-asset-sync/native/windows-job.cpp','int main(){return 0;}\n');
    await put('mcp/neurocenter-asset-sync/scripts/build.mjs','throw Error("Build must not execute");\n');
    await put('mcp/neurocenter-asset-sync/scripts/probe-store.mjs','throw Error("Probe must not execute");\n');
    await put('mcp/neurocenter-asset-sync/scripts/test-local-configuration-smoke.mjs','throw Error("Smoke must not execute");\n');
    await put('scripts/no-extension','#!/usr/bin/env node\nthrow Error("Do not execute");\n');
    await put('scripts/unknown-runtime','#!/usr/bin/env custom-runtime\nexit 99\n');
    await put('scripts/coverage/helper.mjs','export {};\n');
    await put('scripts/test/cli.test.mjs','throw Error("This is fixture data");\n');
    await put('frontend/src/types.d.mts','declare const value:number;\n');
    await put('frontend/vite.config.ts','export default {};\n');
    await put('output-committed/dist/compiled.js','export const generated=true;\n');
    await put('docs/example.ts','export const notYetClassified=true;\n');
    await put('ignored/secret.js','throw Error("Ignored dependency");\n');
    return{root,put};
}
const record=(inventory,file)=>inventory.files.find(item=>item.path===file);

test('Production CLI, helpers and shipped installers enter the inventory without executing them',async t=>{
    const {root}=await fixture(t),inventory=await collectSourceInventory(root);
    for(const file of ['scripts/production/recovery.mjs','scripts/models/bundle-cli.mts','bridge-dist/install.sh','bridge-dist/install.ps1'])assert.equal(record(inventory,file).role,'production');
    assert.equal(record(inventory,'bridge-dist/install.sh').generated,true);
    assert.equal(record(inventory,'scripts/no-extension').instrumentable,true);
    assert.equal(record(inventory,'scripts/unknown-runtime').language,'unknown-shebang');
    assert.equal(record(inventory,'ignored/secret.js'),undefined);
});
test('JavaScript CLI missing from the measured map stays missing; unsupported runtimes never become100percent',async t=>{
    const {root}=await fixture(t),inventory=await collectSourceInventory(root),result=reconcileSourceInventory(inventory,[path.join(root,'frontend/src/main.ts'),path.join(root,'bridge-dist/install.sh')],root,'vitest-ast-v8');
    assert.equal(record(result,'frontend/src/main.ts').measurement,'represented');
    assert.equal(record(result,'scripts/production/recovery.mjs').measurement,'unrepresented');
    for(const file of ['bridge-dist/install.sh','bridge-dist/install.ps1','scripts/operator.py','scripts/unknown-runtime','services/example/migrations/001.sql','mcp/neurocenter-asset-sync/native/windows-job.cpp'])assert.equal(record(result,file).measurement,'unsupported-runtime');
    assert.equal(result.allProductionSourcesRepresented,false);
    assert.equal(result.summary.production.represented,1);assert.equal(result.summary.production.unsupported,6);
});
test('SQL source stays unmeasured independently of a covered TypeScript caller',async t=>{
    const {root}=await fixture(t),inventory=await collectSourceInventory(root),result=reconcileSourceInventory(inventory,['frontend/src/main.ts','services/example/migrations/001.sql'],root,'vitest-ast-v8');
    const sql=record(result,'services/example/migrations/001.sql');assert.equal(sql.role,'production');assert.equal(sql.language,'sql');assert.equal(sql.measurement,'unsupported-runtime');assert.match(sql.reason,/SQL semantics/);
});
test('Sensitive source and external symlinks are not read; ordinary non-source documents are not shebang-scanned',async t=>{
    const {root,put}=await fixture(t);await put('secrets/private.ts','Never hash this private source');await put('.env.local','#!/usr/bin/env node\nprivate');await put('docs/private-not-source','#!/usr/bin/env node\nnot an executable');
    const inventory=await collectSourceInventory(root,['secrets/private.ts','.env.local','docs/private-not-source']);
    assert.equal(inventory.files.length,1);assert.equal(inventory.files[0].kind,'sensitive-path');assert.equal(inventory.files[0].sha256,null);assert.equal(inventory.inventoryComplete,false);
});
test('Tests, coverage tooling, declarations and generated outputs have explicit non-production reasons',async t=>{
    const {root}=await fixture(t),inventory=await collectSourceInventory(root);
    for(const [file,role] of [['scripts/test/cli.test.mjs','verification'],['scripts/coverage/helper.mjs','tooling'],['frontend/src/types.d.mts','declaration'],['frontend/vite.config.ts','tooling'],['output-committed/dist/compiled.js','generated']]){
        assert.equal(record(inventory,file).role,role);assert.ok(record(inventory,file).reason);
    }
    assert.equal(record(inventory,'docs/example.ts').role,'unclassified');
    assert.equal(record(inventory,'mcp/neurocenter-asset-sync/native/windows-job.cpp').role,'production');
    assert.equal(record(inventory,'mcp/neurocenter-asset-sync/scripts/probe-store.mjs').role,'production');
    assert.equal(record(inventory,'mcp/neurocenter-asset-sync/scripts/build.mjs').role,'tooling');
    assert.equal(record(inventory,'mcp/neurocenter-asset-sync/scripts/test-local-configuration-smoke.mjs').role,'verification');
});
test('A new untracked CLI appears and editing it changes its retained content hash',async t=>{
    const {root,put}=await fixture(t),before=await collectSourceInventory(root);
    await put('scripts/new-cli.cjs','module.exports=1;');assert.ok(repositorySourceFiles(root).includes('scripts/new-cli.cjs'));
    const added=await collectSourceInventory(root);assert.equal(record(before,'scripts/new-cli.cjs'),undefined);
    await put('scripts/new-cli.cjs','module.exports=2;');const changed=await collectSourceInventory(root);
    assert.notEqual(record(added,'scripts/new-cli.cjs').sha256,record(changed,'scripts/new-cli.cjs').sha256);
});
test('Missing retained paths and symlinks stay visible without reading a foreign target',async t=>{
    const {root}=await fixture(t);await fs.symlink('/not-owned/private/cli.mjs',path.join(root,'scripts/symlink.mjs'));
    const inventory=await collectSourceInventory(root,['scripts/missing.ts','scripts/symlink.mjs']);
    assert.equal(inventory.inventoryComplete,false);assert.equal(inventory.files.length,2);
    assert.ok(inventory.files.every(file=>file.unavailable&&file.sha256===null));
    await assert.rejects(collectSourceInventory(root,['../foreign.ts']),/inside its repository/);
});
test('A retained tracked source under a replaced parent symlink cannot hash a foreign file',async t=>{
    const {root}=await fixture(t),foreign=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-foreign-inventory-')));t.after(()=>fs.rm(foreign,{recursive:true,force:true}));
    const rootAlias=path.join(foreign,'owned-root');await fs.symlink(root,rootAlias,'dir');
    assert.equal(record(await collectSourceInventory(rootAlias,['frontend/src/main.ts']),'frontend/src/main.ts').sha256,record(await collectSourceInventory(root,['frontend/src/main.ts']),'frontend/src/main.ts').sha256);
    assert.equal(spawnSync('git',['add','frontend/src/main.ts'],{cwd:root}).status,0);
    await fs.writeFile(path.join(foreign,'main.ts'),'PRIVATE FOREIGN BYTES must never be hashed');
    await fs.rename(path.join(root,'frontend/src'),path.join(root,'frontend/original-src'));
    for(const target of [foreign,path.join(root,'frontend/original-src')]){
        await fs.symlink(target,path.join(root,'frontend/src'),'dir');
        assert.ok(repositorySourceFiles(root).includes('frontend/src/main.ts'));
        const inventory=await collectSourceInventory(root,['frontend/src/main.ts']),source=inventory.files[0];
        assert.equal(source.sha256,null);assert.ok(source.unavailable);assert.equal(inventory.inventoryComplete,false);
        assert.equal(record(reconcileSourceInventory(inventory,[],root,'unmeasured-inventory'),'frontend/src/main.ts').measurement,'source-unavailable');
        await fs.unlink(path.join(root,'frontend/src'));
    }
});
test('Only present comparable source files are reconciled; zero-hit counters are not synthesized',async t=>{
    const {root}=await fixture(t),inventory=await collectSourceInventory(root,['frontend/src/main.ts','scripts/production/recovery.mjs']);
    const result=reconcileSourceInventory(inventory,[path.join(root,'frontend/src/main.ts'),'scripts/production/recovery.mjs'],root,'native-c8-v8');
    assert.equal(result.allProductionSourcesRepresented,true);assert.deepEqual(result.summary.production,{total:2,represented:2,unrepresented:0,unsupported:0,unavailable:0});
    assert.ok(result.files.every(file=>file.summary===undefined&&file.lines===undefined));
});
test('Historical merges retain missing CLI and unsupported installers without consulting current files',async t=>{
    const {root}=await fixture(t),inventory=await collectSourceInventory(root,['frontend/src/main.ts','scripts/production/recovery.mjs','bridge-dist/install.sh']);
    const first=reconcileSourceInventory(inventory,['frontend/src/main.ts'],root,'vitest-ast-v8'),second=reconcileSourceInventory(inventory,['scripts/production/recovery.mjs'],root,'vitest-ast-v8');
    const merged=mergeSourceInventories([first,second],['frontend/src/main.ts','scripts/production/recovery.mjs'],root,'vitest-ast-v8');
    assert.equal(merged.summary.production.represented,2);assert.equal(merged.summary.production.unsupported,1);assert.equal(merged.allProductionSourcesRepresented,false);
    for(const values of [[first,undefined],[first,{schemaVersion:1}],[]])assert.equal(mergeSourceInventories(values,[],root,'vitest-ast-v8').inventoryComplete,false);
    const changed=structuredClone(second);changed.files[0].sha256='different';assert.equal(mergeSourceInventories([first,changed],[],root,'vitest-ast-v8').inventoryComplete,false);
});
test('JSON and Markdown show every unmeasured installer and CLI separately from percentages',async t=>{
    const {root}=await fixture(t),inventory=reconcileSourceInventory(await collectSourceInventory(root),[],root,'unmeasured-inventory'),output=path.join(root,'report');await fs.mkdir(output);
    await writeSourceInventory(inventory,output);const text=await fs.readFile(path.join(output,'source-inventory.md'),'utf8');
    for(const file of ['scripts/production/recovery.mjs','bridge-dist/install.sh','bridge-dist/install.ps1','docs/example.ts'])assert.ok(text.includes(file));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output,'source-inventory.json'),'utf8')),inventory);
    assert.match(text,/не процент покрытия/);
});
test('Source inventory regressions participate in normal workspace check discovery',()=>{
    assert.ok(nodeTestFiles(sourceRoot).includes('scripts/test/coverage-source-inventory.test.mjs'));
});

for(const mode of ['same-source','legacy','mixed-instrumentation'])test('Actual merge CLI handles '+mode+' denominator evidence without running application code',async t=>{
    const {root}=await fixture(t),tools=path.join(root,'scripts/coverage');
    for(const file of ['merge.mjs','methods.mjs','report.mjs','source-inventory.mjs','package.json'])await fs.copyFile(path.join(sourceRoot,'scripts/coverage',file),path.join(tools,file));
    await fs.symlink(path.join(sourceRoot,'scripts/coverage/node_modules'),path.join(tools,'node_modules'),'dir');
    const file=path.join(root,'frontend/src/main.ts'),map={[file]:{path:file,statementMap:{0:{start:{line:1,column:0},end:{line:1,column:21}}},fnMap:{},branchMap:{},s:{0:1},f:{},b:{}}};
    const inventory=await collectSourceInventory(root,['frontend/src/main.ts','scripts/production/recovery.mjs','bridge-dist/install.sh']);
    const runs=[];
    for(let index=0;index<2;index++){
        const folder=path.join(root,'run-'+index),kind=mode==='mixed-instrumentation'&&index===1?'native-c8-v8':'vitest-ast-v8';await fs.mkdir(path.join(folder,'merged'),{recursive:true});runs.push(folder);
        await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify({finishedAt:'retained',profile:'fixture',coverageKind:kind,comparablePercentages:true,complete:true,sourceBefore:{fixture:true},sourceAfter:{fixture:true},packages:[],...(mode==='legacy'?{}:{sourceInventory:reconcileSourceInventory(inventory,[file],root,kind)}),denominator:{allWorkspaceSourcesIncluded:true}}));
        await fs.writeFile(path.join(folder,'merged/coverage-final.json'),JSON.stringify(map));
    }
    const output=path.join(root,'merged-output'),result=spawnSync(process.execPath,[path.join(tools,'merge.mjs'),...runs.flatMap(run=>['--run',run]),'--output',output],{cwd:root,encoding:'utf8',timeout:15000});
    assert.equal(result.error,undefined);assert.equal(result.status,mode==='mixed-instrumentation'?1:0,result.stdout+result.stderr);
    if(mode==='mixed-instrumentation'){assert.match(result.stderr,/experimental/);await assert.rejects(fs.stat(output),{code:'ENOENT'});return;}
    const manifest=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'));assert.equal(manifest.denominator.allWorkspaceSourcesIncluded,false);
    assert.equal(manifest.sourceInventory.inventoryComplete,mode==='same-source');
    if(mode==='same-source'){assert.equal(manifest.sourceInventory.summary.production.unrepresented,1);assert.equal(manifest.sourceInventory.summary.production.unsupported,1);}
    else assert.match(manifest.sourceInventory.reason,/unavailable/);
    assert.match(await fs.readFile(path.join(output,'gaps.md'),'utf8'),/source-inventory/);
});

test('Actual native runner retains c8 hits for a production CLI outside every package src tree',async t=>{
    const {root,put}=await fixture(t),tools=path.join(root,'scripts/coverage');
    for(const file of ['run.mjs','focused-selection.mjs','profiles.mjs','owned-pg.mjs','methods.mjs','report.mjs','source-inventory.mjs','test-file-inventory.mjs','package.json'])await fs.copyFile(path.join(sourceRoot,'scripts/coverage',file),path.join(tools,file));
    await fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true});await fs.copyFile(path.join(sourceRoot,'scripts/workspace/check-report.mjs'),path.join(root,'scripts/workspace/check-report.mjs'));
    for(const file of ['feature-flags.cjs','feature-flag-catalog.json'])await fs.copyFile(path.join(sourceRoot,'services/shared',file),path.join(root,'services/shared',file));
    await fs.writeFile(path.join(tools,'source-identity.mjs'),'export const sourceIdentity=()=>({synthetic:true});\n');
    await fs.symlink(path.join(sourceRoot,'scripts/coverage/node_modules'),path.join(tools,'node_modules'),'dir');
    const profiles=await fs.readFile(path.join(tools,'profiles.mjs'),'utf8');await fs.writeFile(path.join(tools,'profiles.mjs'),profiles.replace(/export const nativeSuites = \[[\s\S]*?\];/,'export const nativeSuites = ["owned-native.test.mjs"];'));
    await put('scripts/production/recovery.mjs','export function run(value){return value+1;}\n');
    await put('scripts/test/owned-native.test.mjs','import {test} from "node:test";import assert from "node:assert/strict";import {run} from "../production/recovery.mjs";test("safe fixture CLI",()=>assert.equal(run(1),2));\n');
    const output=path.join(root,'native-output'),result=spawnSync(process.execPath,[path.join(tools,'run.mjs'),'--no-unit','--native','--output',output],{cwd:root,env:{PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},encoding:'utf8',timeout:15000});
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
    const manifest=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8')),map=JSON.parse(await fs.readFile(path.join(output,'merged/coverage-final.json'),'utf8'));
    assert.equal(manifest.coverageKind,'native-c8-v8');assert.equal(manifest.native.passed,1);assert.equal(manifest.complete,true);assert.equal(manifest.denominator.allWorkspaceSourcesIncluded,false);
    assert.ok(map[path.join(root,'scripts/production/recovery.mjs')]);assert.equal(record(manifest.sourceInventory,'scripts/production/recovery.mjs').measurement,'represented');
    assert.equal(record(manifest.sourceInventory,'scripts/models/bundle-cli.mts').measurement,'unrepresented');
    assert.equal(record(manifest.sourceInventory,'bridge-dist/install.sh').measurement,'unsupported-runtime');
    const gaps=JSON.parse(await fs.readFile(path.join(output,'gaps.json'),'utf8'));assert.ok(gaps.modules.some(module=>module.name==='cli/production'));
});
