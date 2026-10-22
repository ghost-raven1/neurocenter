import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {coveragePackages} from '../coverage/source-inventory.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const selected='test/selected.test.ts',second='test/second.test.mjs',collision='test/selected.test.tsx',unselected='test/unselected.test.ts',external='test/external-db.test.ts';
const syntheticVitest=String.raw`
import fs from 'node:fs/promises';import path from 'node:path';
const cwd=process.cwd(),args=process.argv.slice(2),excluded=[],filters=[];
for(let i=0;i<args.length;i++){if(args[i]==='--exclude')excluded.push(args[++i]);else if(args[i]!=='run'&&!args[i].startsWith('--'))filters.push(args[i]);}
await fs.appendFile(process.env.FOCUSED_CALLS,JSON.stringify({cwd,args,envHasInfrastructure:Object.keys(process.env).some(key=>/TEST.*PG|TEST.*S3/.test(key))})+'\n');
const all=(await fs.readdir(path.join(cwd,'test'))).filter(file=>/\.test\.(?:ts|tsx|mjs)$/.test(file)).map(file=>'test/'+file);
let files=process.env.FOCUSED_CASE==='ignored'?all.filter(file=>!file.includes('-db.')):all.filter(file=>!excluded.includes(file)&&(!filters.length||filters.some(filter=>file.includes(filter))));
if(process.env.FOCUSED_CASE==='missing')files=files.slice(0,1);
const moduleIds=files.map(file=>path.join(cwd,file));
await fs.writeFile(process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE,JSON.stringify({schemaVersion:1,phase:'before-collection',cwd,moduleIds}));
const testResults=moduleIds.map(name=>({name,status:'passed',assertionResults:[{status:'passed',fullName:'owned synthetic assertion'}]}));
const report={success:true,numPassedTests:files.length,numFailedTests:0,numPendingTests:0,numTodoTests:0,numTotalTests:files.length,numFailedTestSuites:0,testResults};
await fs.writeFile(args.find(arg=>arg.startsWith('--outputFile=')).slice('--outputFile='.length),JSON.stringify(report));
const coverage={};for(const[name,hits]of[['entry.ts',files.length],['never.ts',0]]){const file=path.join(cwd,'src',name);coverage[file]={path:file,statementMap:{0:{start:{line:1,column:0},end:{line:1,column:21}}},fnMap:{},branchMap:{},s:{0:hits},f:{},b:{}};}
await fs.mkdir(process.env.NEUROCENTER_COVERAGE_DIR,{recursive:true});await fs.writeFile(path.join(process.env.NEUROCENTER_COVERAGE_DIR,'coverage-final.json'),JSON.stringify(coverage));
`;

/** Run the actual orchestration on private packages; only the explicit synthetic worker is substituted. */
async function fixture(t,{realVitest=false}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-focused-coverage-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const tools=path.join(root,'scripts/coverage'),output=path.join(root,'output'),calls=path.join(root,'worker-calls.jsonl');
 for(const directory of[tools,path.join(root,'scripts/workspace'),path.join(root,'services/shared')])await fs.mkdir(directory,{recursive:true});
 for(const file of['run.mjs','focused-selection.mjs','profiles.mjs','owned-pg.mjs','methods.mjs','report.mjs','source-inventory.mjs','test-file-inventory.mjs','inventory-reporter.mjs','package.json']){
  try{await fs.copyFile(path.join(repository,'scripts/coverage',file),path.join(tools,file));}catch(error){if(file!=='focused-selection.mjs'||error.code!=='ENOENT')throw error;}
 }
 await fs.copyFile(path.join(repository,'scripts/workspace/check-report.mjs'),path.join(root,'scripts/workspace/check-report.mjs'));
 for(const file of['feature-flags.cjs','feature-flag-catalog.json','test-coverage.mjs'])await fs.copyFile(path.join(repository,'services/shared',file),path.join(root,'services/shared',file));
 await fs.writeFile(path.join(tools,'source-identity.mjs'),'export const sourceIdentity=()=>({synthetic:true});\n');
 await fs.symlink(path.join(repository,'scripts/coverage/node_modules'),path.join(tools,'node_modules'),'dir');
 for(const[id,relative]of coveragePackages){
  const pkg=path.join(root,relative);await fs.mkdir(path.join(pkg,'src'),{recursive:true});await fs.mkdir(path.join(pkg,'test'),{recursive:true});
  await fs.writeFile(path.join(pkg,'src/entry.ts'),'export const value=1;\n');await fs.writeFile(path.join(pkg,'src/never.ts'),'export const unused=2;\n');
  for(const file of[selected,second,collision,unselected,external])await fs.writeFile(path.join(pkg,file),'// owned synthetic test\n');
  if(realVitest&&id==='feature-flags-service'){
   await fs.symlink(path.join(repository,relative,'node_modules'),path.join(pkg,'node_modules'),'dir');
   await fs.copyFile(path.join(repository,relative,'vitest.config.mts'),path.join(pkg,'vitest.config.mts'));
   await fs.writeFile(path.join(pkg,selected),'import {test,expect} from "vitest";import {value} from "../src/entry";test("selected real assertion",()=>expect(value).toBe(1));\n');
   for(const file of[second,collision,unselected,external])await fs.writeFile(path.join(pkg,file),'throw Error("Unselected fixture must never execute");\n');
  }else{await fs.mkdir(path.join(pkg,'node_modules/vitest'),{recursive:true});await fs.writeFile(path.join(pkg,'node_modules/vitest/vitest.mjs'),syntheticVitest);}
 }
 await fs.writeFile(path.join(root,'.gitignore'),'**/node_modules/\noutput*/\nworker-calls.jsonl\n');
 assert.equal(spawnSync('git',['init','--quiet'],{cwd:root,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).status,0);
 const pkg=path.join(root,'services/feature-flags-service');
 function run(args=[],{scenario='selected',destination=output}={}){
  const result=spawnSync(process.execPath,[path.join(tools,'run.mjs'),...args,'--max-workers','1','--output',destination],{cwd:root,
   env:{PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,FOCUSED_CALLS:calls,FOCUSED_CASE:scenario,TEST_PG_URL:'postgres://forbidden-caller',TEST_S3_SECRET:'forbidden-caller'},encoding:'utf8',timeout:30000,maxBuffer:2*1024**2});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);return result;
 }
 return{root,tools,pkg,output,calls,run,manifest:async()=>JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'))};
}

test('Focused runner selects exact requested files, rejects substring expansion and retains untouched source counters',async t=>{
 const f=await fixture(t),result=f.run(['--package','feature-flags-service','--test-file',selected]);
 assert.equal(result.status,0,result.stdout+result.stderr);const manifest=await f.manifest(),item=manifest.packages[0];
 assert.equal(manifest.profile,'unit-safe');assert.equal(manifest.packages.length,1);assert.equal(item.passed,1);assert.equal(item.testFileInventory.complete,true);
 assert.deepEqual(manifest.requestedTestFiles,[selected]);assert.equal(manifest.scope.completion,'requested-selection-only');assert.equal(manifest.scope.package,'feature-flags-service');
 assert.deepEqual(item.requestedTestFiles,[selected]);assert.deepEqual(item.excludedInfrastructureSuites,[external]);
 assert.deepEqual(item.excludedBySelection,[second,collision,unselected].sort());assert.deepEqual(item.testFileInventory.excludedFiles,[path.join(f.pkg,external)]);
 assert.deepEqual(item.testFileInventory.expectedFiles,[path.join(f.pkg,selected)]);assert.deepEqual(item.testFileInventory.requestedFiles,[path.join(f.pkg,selected)]);
 assert.equal(manifest.complete,true);assert.equal(manifest.denominator.configuredPackageSourcesIncluded,false);assert.equal(manifest.denominator.selectedPackageSourcesIncluded,true);assert.equal(manifest.denominator.allWorkspaceSourcesIncluded,false);
 const command=item.command;assert.ok(command.includes(selected));for(const file of[external,second,collision,unselected])assert.ok(command.some((arg,index)=>arg==='--exclude'&&command[index+1]===file));
 const map=JSON.parse(await fs.readFile(path.join(f.output,'merged/coverage-final.json'),'utf8'));assert.equal(map[path.join(f.pkg,'src/never.ts')].s[0],0);assert.equal(item.ownSourceSummary.lines.total,2);assert.equal(item.ownSourceSummary.lines.covered,1);
 const calls=(await fs.readFile(f.calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.length,1);assert.equal(calls[0].envHasInfrastructure,false);
});
test('Repeated test-file options run only those files once',async t=>{
 const f=await fixture(t),result=f.run(['--package','feature-flags-service','--test-file',selected,'--test-file',second]);assert.equal(result.status,0,result.stdout+result.stderr);
 const manifest=await f.manifest();assert.deepEqual(manifest.requestedTestFiles,[selected,second]);assert.equal(manifest.packages[0].passed,2);assert.equal(manifest.packages[0].testFileInventory.expectedFileCount,2);
});
test('A mixed focused batch names the rejected infrastructure file before creating output or starting a worker',async t=>{
 const f=await fixture(t),result=f.run(['--package','feature-flags-service','--test-file',selected,'--test-file',second,'--test-file',external]);
 assert.equal(result.status,1);assert.match(result.stderr,/cannot select infrastructure suites in unit-safe coverage/);assert.ok(result.stderr.includes(external),'The diagnostic must identify the offending canonical relative test file');
 await assert.rejects(fs.stat(f.output),{code:'ENOENT'});await assert.rejects(fs.stat(f.calls),{code:'ENOENT'});
});
test('The 32-file boundary admits distinct ordinary tests instead of silently truncating the request',async t=>{
 const f=await fixture(t),files=Array.from({length:32},(_,index)=>'test/bounded-'+index+'.test.ts');for(const file of files)await fs.writeFile(path.join(f.pkg,file),'// owned bounded selection\n');
 const result=f.run(['--package','feature-flags-service',...files.flatMap(file=>['--test-file',file])]);assert.equal(result.status,0,result.stdout+result.stderr);
 const manifest=await f.manifest();assert.equal(manifest.requestedTestFiles.length,32);assert.equal(manifest.packages[0].passed,32);assert.equal(manifest.complete,true);
});
for(const scenario of['ignored','missing'])test('Actual selection '+scenario+' cannot masquerade as completed focused coverage',async t=>{
 const f=await fixture(t),result=f.run(['--package','feature-flags-service','--test-file',selected,'--test-file',second],{scenario});
 assert.equal(result.status,1,result.stdout+result.stderr);const manifest=await f.manifest(),inventory=manifest.packages[0].testFileInventory;
 assert.equal(manifest.complete,false);assert.equal(inventory.complete,false);assert.equal(manifest.packages[0].exitCode,0);
 if(scenario==='ignored')assert.deepEqual(inventory.unexpectedSelectedFiles,[path.join(f.pkg,collision),path.join(f.pkg,unselected)].sort());
 else assert.equal(inventory.missingRequestedFiles.length,1);
});
test('Actual Vitest AST focused fixture excludes a colliding test and includes never-imported package source',async t=>{
 const f=await fixture(t,{realVitest:true}),result=f.run(['--package','feature-flags-service','--test-file',selected]);assert.equal(result.status,0,result.stdout+result.stderr);
 const manifest=await f.manifest(),map=JSON.parse(await fs.readFile(path.join(f.output,'merged/coverage-final.json'),'utf8'));
 assert.equal(manifest.packages[0].passed,1);assert.equal(manifest.complete,true);assert.equal(manifest.coverageKind,'vitest-ast-v8');
 assert.ok(Object.values(map[path.join(f.pkg,'src/entry.ts')].s).some(count=>count>0));assert.ok(Object.values(map[path.join(f.pkg,'src/never.ts')].s).every(count=>count===0));
 assert.ok(manifest.packages[0].ownSourceSummary.lines.covered<manifest.packages[0].ownSourceSummary.lines.total);assert.equal(manifest.denominator.allWorkspaceSourcesIncluded,false);
});

test('Focused argument admission rejects unsafe paths, modes and infrastructure before creating output or invoking a worker',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.pkg,'test/hidden.test.ts'),'import {Pool} from "pg";\n');
 for(const file of['test/optional.integration.test.ts','test/optional.e2e.test.ts'])await fs.writeFile(path.join(f.pkg,file),'// explicitly external opt-in suite\n');
 await fs.writeFile(path.join(f.pkg,'test/optional.test.ts'),'const ready=process.env.NEUROCENTER_CATALOG_READY;\n');
 await fs.symlink(path.join(f.pkg,selected),path.join(f.pkg,'test/link.test.ts'));await fs.symlink(path.join(f.pkg,'test'),path.join(f.pkg,'test/linked'),'dir');await fs.mkdir(path.join(f.pkg,'test/directory.test.ts'));
 const base=['--package','feature-flags-service'];
 const badPaths=['test/optional.integration.test.ts','test/optional.e2e.test.ts','test/optional.test.ts','../test/selected.test.ts','test/../test/selected.test.ts','test//selected.test.ts','test/./selected.test.ts',path.join(f.pkg,selected),'test\\selected.test.ts','--watch','test/*.test.ts','test/source.ts','test/source.spec.ts','test/missing.test.ts','test/link.test.ts','test/linked/selected.test.ts','test/directory.test.ts','test/hidden.test.ts',external,'test/a\n.test.ts','test/selected.test.jsx'];
 const cases=[...badPaths.map(file=>[...base,'--test-file',file]),['--test-file',selected],[...base,'--package','bridge','--test-file',selected],...['--native','--integration','--owned-pg','--no-unit'].map(flag=>[...base,flag,'--test-file',selected]),[...base,'--test-file',selected,'--test-file',selected],[...base,'--test-file'],[...base,...Array.from({length:33},()=>['--test-file',selected]).flat()]];
 for(const[index,args]of cases.entries()){
  const output=path.join(f.root,'output-invalid-'+index),result=f.run(args,{destination:output});assert.equal(result.status,1,args.join(' '));
  await assert.rejects(fs.stat(output),{code:'ENOENT'});await assert.rejects(fs.stat(f.calls),{code:'ENOENT'});
 }
});
test('No test-file option preserves all eight default unit-safe package commands and infrastructure separation',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.pkg,'test/optional.integration.test.ts'),'const ready=process.env.NEUROCENTER_CATALOG_READY;\n');
 const result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);const manifest=await f.manifest();
 assert.equal(manifest.profile,'unit-safe');assert.deepEqual(manifest.packages.map(item=>item.name),coveragePackages.map(([id])=>id));assert.equal(manifest.packages.length,8);
 assert.equal(manifest.requestedTestFiles,undefined);assert.equal(manifest.scope,undefined);assert.equal(manifest.complete,true);
 for(const item of manifest.packages){assert.equal(item.passed,item.name==='feature-flags-service'?5:4);assert.deepEqual(item.excludedInfrastructureSuites,[external]);assert.equal(item.excludedBySelection,undefined);assert.equal(item.requestedTestFiles,undefined);}
});
test('A symlinked package test root is refused before output or worker execution',async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.pkg,'test'),{recursive:true});await fs.symlink(path.join(f.root,'services/catalog-service/test'),path.join(f.pkg,'test'),'dir');
 const result=f.run(['--package','feature-flags-service','--test-file',selected]);assert.equal(result.status,1);assert.match(result.stderr,/without symlinks/);
 await assert.rejects(fs.stat(f.output),{code:'ENOENT'});await assert.rejects(fs.stat(f.calls),{code:'ENOENT'});
});
