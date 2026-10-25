import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {sourceInventory} from '../source-inventory.mjs';
import {prepareAdditionalSource} from '../source-adapters.mjs';
import {packRuntime} from '../pack.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';
import {validateBuildPlan} from '../../../services/shared/package-build-plan.cjs';
const targets=['darwin-arm64'];
const files=[{path:'src/plugin.mjs',content:"import {readFileSync} from 'node:fs'; export default()=>({html:readFileSync(new URL('../visualizer/index.html',import.meta.url),'utf8')});"},
 {path:'visualizer/index.html',content:'<h1>PACKAGED_RESOURCE</h1>'}];
const planFor=inventory=>({schemaVersion:2,sourceSha256:inventory.sourceSha256,entrypoint:inventory.entrypoints[0].path,targets,
 steps:[{op:'dependencies',mode:'none',lockSha256:null},{op:'compile',runtime:'node24',mode:inventory.entrypoints[0].modes[0]},
 {op:'copy-resources',paths:inventory.resources},{op:'verify',profile:'isolated-startup'}]});

test('Executable recipe preserves the JS module layout and reads its packaged adjacent HTML',async()=>{
 const inventory=await sourceInventory(files,['src/plugin.mjs'],targets),buildPlan=planFor(inventory);
 assert.deepEqual(inventory.entrypoints[0].modes,['preserve']);assert.deepEqual(validateBuildPlan(buildPlan,inventory),buildPlan);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-recipe-layout-'));
 try{
  for(const file of files){const destination=path.join(root,'source',file.path);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,file.content);}
  const directory=path.join(root,'output');await fs.mkdir(directory);
  const prepared=await prepareAdditionalSource({schemaVersion:2,inventory,buildPlan,targets,source:{type:'project',directory:'source',entrypoint:'src/plugin.mjs'}},{directory,recipeDirectory:root,target:targets[0]});
  assert.equal(prepared.entrypoint,'src/plugin.mjs');assert.equal(prepared.upstream.layout,'source');
  const archivePath=path.join(root,'runtime.tgz'),unpacked=path.join(root,'unpacked');
  const descriptor=await packRuntime({directory,archivePath,target:targets[0],entrypoint:prepared.entrypoint});
  await runtime.inspectRuntimeArchive(archivePath,descriptor,{destination:unpacked});
  await fs.rm(directory,{recursive:true,force:true});
  const module=await import(pathToFileURL(path.join(unpacked,descriptor.entrypoint)));assert.deepEqual(module.default(),{html:files[1].content});
  await fs.writeFile(path.join(root,'source/visualizer/index.html'),'changed after pin');
  const changed=path.join(root,'changed');await fs.mkdir(changed);
  await assert.rejects(prepareAdditionalSource({schemaVersion:2,inventory,buildPlan,targets,source:{type:'project',directory:'source',entrypoint:'src/plugin.mjs'}},{directory:changed,recipeDirectory:root,target:targets[0]}),{code:'SOURCE_RECIPE_INVALID'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Bun source is rejected before any package startup or model action',async()=>{
 const bun=[{path:'index.ts',content:'import "./visualizer/server";export default async()=>({event:async()=>{}});'},
  {path:'visualizer/server.ts',content:'const dir=import.meta.dir; Bun.serve({fetch:()=>new Response(Bun.file(dir+"/index.html"))});'},files[1]];
 await assert.rejects(sourceInventory(bun,['index.ts'],targets),{code:'SOURCE_RUNTIME_UNSUPPORTED'});
});
test('TS without module-relative resources gets a Node24 compilation recipe',async()=>{
 const inventory=await sourceInventory([{path:'index.ts',content:'enum Kind{Ready};interface Input{value:string};export default(input:Input)=>({event:async()=>input.value+Kind.Ready});'}],['index.ts'],targets);
 assert.deepEqual(inventory.entrypoints[0].modes,['bundle']);assert.equal(validateBuildPlan(planFor(inventory),inventory).steps[1].runtime,'node24');
});
test('Missing, invalid and unsupported local imports are rejected during source inspection',async()=>{
 for(const imported of [undefined,'export const broken: = 1;', 'const element=<div/>;']){
  const source=[{path:'index.ts',content:'import "./helper";export default()=>({event:async()=>{}});'},
   ...(imported===undefined?[]:[{path:'helper.ts',content:imported}])];
  await assert.rejects(sourceInventory(source,['index.ts'],targets),/неразрешимый JS\/TS import/);
 }
 await assert.rejects(sourceInventory([{path:'index.mjs',content:'const name="helper";await import("./"+name);'}],['index.mjs'],targets),/динамический импорт/);
});
test('A local writer cannot validate original A after different B bytes were copied to private staging',async()=>{
 const originalA='export default()=>({variant:"A"});',copiedB='export default()=>({variant:"B"});';
 const inventory=await sourceInventory([{path:'index.mjs',content:originalA}],['index.mjs'],targets),buildPlan=planFor(inventory);
 buildPlan.steps[1].mode='preserve';
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-recipe-source-race-')),source=path.join(root,'source/index.mjs');
 const nativeCopy=fs.copyFile,nativeLstat=fs.lstat;let copied=false,restored=false;
 try{
  await fs.mkdir(path.dirname(source));await fs.writeFile(source,copiedB);const directory=path.join(root,'output');await fs.mkdir(directory);
  fs.copyFile=async(...args)=>{const result=await nativeCopy(...args);if(args[0]===source)copied=true;return result;};
  fs.lstat=async(...args)=>{const result=await nativeLstat(...args);if(args[0]===source&&copied&&!restored){await fs.writeFile(source,originalA);restored=true;}return result;};
  await assert.rejects(prepareAdditionalSource({schemaVersion:2,inventory,buildPlan,targets,source:{type:'project',directory:'source',entrypoint:'index.mjs'}},
   {directory,recipeDirectory:root,target:targets[0]}),{code:'SOURCE_RECIPE_INVALID'});
  assert.equal(restored,true);await assert.rejects(fs.stat(path.join(directory,'index.mjs')),{code:'ENOENT'});
 }finally{fs.copyFile=nativeCopy;fs.lstat=nativeLstat;await fs.rm(root,{recursive:true,force:true});}
});
test('Invented shell, runtime, target, source digest and resource escape cannot enter an executable recipe',async()=>{
 const inventory=await sourceInventory(files,['src/plugin.mjs'],targets),plan=planFor(inventory);
 for(const mutate of [p=>p.steps.push({op:'shell',command:'touch /tmp/forbidden'}),p=>p.steps[1].runtime='bun',p=>p.targets.push('linux-x64-glibc'),
  p=>p.sourceSha256='a'.repeat(64),p=>p.steps[2].paths=['../private'],p=>p.steps[2].paths=[]]){
  const changed=structuredClone(plan);mutate(changed);assert.throws(()=>validateBuildPlan(changed,inventory),{code:'SOURCE_RECIPE_INVALID'});
 }
});
