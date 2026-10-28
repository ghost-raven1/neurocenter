import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {auditedUnits,validateAuditedUnit,validateUnitSafeProfile} from '../coverage/unit-safe-profile.mjs';
import {externalSuite,focusedSelection} from '../coverage/focused-selection.mjs';
import {safeEnvironment} from '../coverage/profiles.mjs';
import {ownedPgAliases} from '../coverage/owned-pg.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const relative='services/catalog-service/test/reviewed.test.ts';
const typeOnly="import type {PoolClient} from 'pg';\nconst query=()=>({rows:[]});\n";

/** Source strings are only read by the classifier; fixture code must never execute. */
async function fixture(t,source=typeOnly){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-unit-profile-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,source);
 return {root,file,entry:{sha256:digest(source),helpers:{}},source};
}

test('All reviewed units and the one self-contained helper retain their exact reviewed bytes',async()=>{
 assert.equal(Object.keys(auditedUnits).length,53);
 assert.equal(Object.values(auditedUnits).reduce((sum,entry)=>sum+Object.keys(entry.helpers).length,0),1);
 await validateUnitSafeProfile(repository,{packages:[['catalog-service','services/catalog-service'],['feature-flags-service','services/feature-flags-service']],chosen:new Set()});
});

test('Actual SQL-mocked actor and execution suites are admitted by the real shared selectors',async()=>{
 for(const file of ['test/actor-canonical-publication.test.ts','test/feature-execution-boundaries.test.ts']){
  const absolute=path.join(repository,'services/catalog-service',file);
  assert.equal(await externalSuite(absolute),false);assert.equal(await externalSuite(absolute,true),false);
  const result=await focusedSelection({root:repository,packages:[['catalog-service','services/catalog-service']],chosen:new Set(['catalog-service']),testFiles:[file],unit:true,native:false,integration:false,ownedPg:false});
  assert.deepEqual(result.files,[file]);
 }
});

test('Real PostgreSQL fixtures and the runtime S3 candidate retain their infrastructure decision',async()=>{
 for(const name of ['agent-catalog','agent-jobs','agent-model-requirements','agent-source-management','agents-service-lifecycle','catalog-requests-targets','device-learning-expiry','mcp-host-access','snapshot-storage-signed-put','catalog-requests-http','chat-learning-context','project-rag-authorization']){
  assert.equal(await externalSuite(path.join(repository,'services/catalog-service/test',name+'.test.ts')),true,name);
 }
 // Existing owned fake-HTTP S3 coverage is not reclassified by a pg-type exemption.
 assert.equal(await externalSuite(path.join(repository,'services/catalog-service/test/s3-bucket-privacy.test.ts')),false);
});

/** These files are source data for static classification, never runtime imports. */
async function helperFixture(t,files,source="import './runtime.fixture.js';\n"){
 const f=await fixture(t,source);
 for(const [name,content]of Object.entries(files)){
  const file=path.join(path.dirname(f.file),name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
 }
 return {...f,classify:()=>externalSuite(f.file,false,{root:f.root})};
}

test('Indirect runtime PG crosses nested verification exports and JS-to-TS aliases before worker admission',async t=>{
 const f=await helperFixture(t,{'runtime.fixture.ts':"export * from './nested/owned.fixture.mjs';\n",'nested/owned.fixture.mts':"import {Pool} from 'pg';\nthrow Error('must never execute');\n"});
 assert.equal(await f.classify(),true);
 await assert.rejects(focusedSelection({root:f.root,packages:[['catalog-service','services/catalog-service']],chosen:new Set(['catalog-service']),testFiles:['test/reviewed.test.ts'],unit:true,native:false,integration:false,ownedPg:false}),/cannot select infrastructure/);
});

test('Verification-only environment gates and CommonJS runtime PG cannot hide behind fixtures',async t=>{
 for(const content of ["export const connection=process.env.OWNED_TEST_ADMIN_PG_URL;", "const pg=require('pg');", "import type {PoolClient} from 'pg';"]){
  const f=await helperFixture(t,{'runtime.fixture.ts':content});assert.equal(await f.classify(),true,content);
 }
});

test('Focused live-readiness markers stay infrastructure-only through a verification helper',async t=>{
 const f=await helperFixture(t,{'runtime.fixture.ts':'export const ready=process.env.NEUROCENTER_CATALOG_READY;'});
 assert.equal(await f.classify(),false);assert.equal(await externalSuite(f.file,true,{root:f.root}),true);
});

test('A pure in-memory helper graph stays unit-safe in a custom root and never evaluates its sentinel',async t=>{
 const f=await helperFixture(t,{'runtime.fixture.ts':"export * from './nested';\n",'nested/index.ts':"import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('./EXECUTED',import.meta.url),'bad');\nexport const query=()=>({rows:[]});\n"});
 assert.equal(await f.classify(),false);
 const selection=await focusedSelection({root:f.root,packages:[['catalog-service','services/catalog-service']],chosen:new Set(['catalog-service']),testFiles:['test/reviewed.test.ts'],unit:true,native:false,integration:false,ownedPg:false});
 assert.deepEqual(selection.files,['test/reviewed.test.ts']);
 await assert.rejects(fs.stat(path.join(path.dirname(f.file),'nested/EXECUTED')),{code:'ENOENT'});
 // This classifier follows verification dependencies, not the whole production service graph.
 const production=path.join(f.root,'services/catalog-service/src/service.ts');await fs.mkdir(path.dirname(production),{recursive:true});await fs.writeFile(production,"import {Pool} from 'pg';\n");
 await fs.writeFile(f.file,"import '../src/service.ts';\n");assert.equal(await f.classify(),false);
});

test('Missing, ambiguous, dynamic, escaped and redirected verification imports fail closed',async t=>{
 const cases=[
  {files:{}},
  {files:{'runtime.fixture.ts':'export {};','runtime.fixture.tsx':'export {};'}},
  {source:'const helper=process.env.HELPER; import(helper);',files:{}},
  {source:"import '../../../../foreign.fixture.ts';",files:{}},
  {source:"import '/outside/foreign.fixture.ts';",files:{}},
  {source:"import 'file:///outside/foreign.fixture.ts';",files:{}},
 ];
 for(const input of cases){const f=await helperFixture(t,input.files,input.source);assert.equal(await f.classify(),true,input.source??Object.keys(input.files).join(','));}
 for(const ancestor of [false,true]){
  const f=await helperFixture(t,{'actual.ts':'export {};'},ancestor?"import './linked/helper.ts';":"import './runtime.fixture.js';");
  if(ancestor){const directory=path.join(path.dirname(f.file),'actual');await fs.mkdir(directory);await fs.writeFile(path.join(directory,'helper.ts'),'export {};');await fs.symlink(directory,path.join(path.dirname(f.file),'linked'),'dir');}
  else await fs.symlink(path.join(path.dirname(f.file),'actual.ts'),path.join(path.dirname(f.file),'runtime.fixture.ts'));
  assert.equal(await f.classify(),true);
 }
});

test('A literal helper prefix with a dynamic suffix cannot masquerade as an inspected pure dependency',async t=>{
 for(const call of ["import('./runtime.fixture.js' + suffix)","require /* gap */ ('./runtime.fixture.js' /* gap */ + suffix)"]){
  const f=await helperFixture(t,{'runtime.fixture.js':'export {};'},'const suffix=""; '+call+';');
  assert.equal(await f.classify(),true,call);
 }
});

test('Literal call closure permits whitespace/comments but rejects templates and additional arguments',async t=>{
 for(const call of ["import( /* before */ './runtime.fixture.js' /* after */ )","require /* before */ ( './runtime.fixture.js' // after\n)","import(/* require(dynamic); from './missing.fixture' */ './runtime.fixture.js')"]){
  const f=await helperFixture(t,{'runtime.fixture.js':'export {};'},call+';');assert.equal(await f.classify(),false,call);
 }
 for(const call of ["import(`./runtime.fixture.js`)","import('./runtime.fixture.js', options)","require('./runtime.fixture.js' + '')"]){
  const f=await helperFixture(t,{'runtime.fixture.js':'export {};'},call+';');assert.equal(await f.classify(),true,call);
 }
});

test('AST decoding retains the owned target of escaped literals and detects escaped PG identities',async t=>{
 const f=await helperFixture(t,{'runtime.fixture.js':'export {};'},String.raw`import '\u002e/runtime.fixture.js';`);assert.equal(await f.classify(),false);
 await fs.writeFile(f.file,String.raw`import 'p\u0067';`);assert.equal(await f.classify(),true);
 await fs.writeFile(f.file,"import runtime = require('./runtime.fixture.js');");assert.equal(await f.classify(),false);
});

test('Property import/require methods are not runtime module dependencies',async t=>{
 const f=await helperFixture(t,{},'api.import(intent); api.require(intent); api?.import(intent);');assert.equal(await f.classify(),false);
});

test('Quoted source examples and generated template text are not runtime module dependencies',async t=>{
 for(const source of [
  'const example="import {value} from \'./missing.fixture\';";',
  "// import './missing.fixture';\n/* require(unknown); */ export const value=1;",
  "const file='owned'; const generated=`import(${JSON.stringify(file)}); require(${JSON.stringify(file)});`;",
 ]){
  const f=await helperFixture(t,{},source);assert.equal(await f.classify(),false,source);
 }
 const actual=await helperFixture(t,{},"import {value} from './missing.fixture';");assert.equal(await actual.classify(),true);
});

test('A verification helper can contain nonexecuted source text while real nested imports remain inspected',async t=>{
 const f=await helperFixture(t,{'runtime.fixture.ts':"export const example=\"export {value} from './missing.fixture';\";"});
 assert.equal(await f.classify(),false);
 await fs.writeFile(path.join(path.dirname(f.file),'runtime.fixture.ts'),"export {value} from './missing.fixture';");assert.equal(await f.classify(),true);
 await fs.writeFile(path.join(path.dirname(f.file),'runtime.fixture.ts'),"export const example=\"import {Pool} from 'pg';\";");assert.equal(await f.classify(),false);
 await fs.writeFile(path.join(path.dirname(f.file),'runtime.fixture.ts'),"import {Pool} from 'pg';");assert.equal(await f.classify(),true);
});

test('Template expression imports and division expressions retain the opaque dependency fence',async t=>{
 for(const source of ["const text=`value ${import('./runtime.fixture.js' + suffix)}`;","const ratio=1 / import('./runtime.fixture.js' + suffix) / 2;"]){
  const f=await helperFixture(t,{'runtime.fixture.js':'export {};'},source);assert.equal(await f.classify(),true,source);
 }
 const example=await helperFixture(t,{},"const pattern=/import\\('fake'\\)/; const example=\"from './missing.fixture'\";");assert.equal(await example.classify(),false);
});

test('Contextual identifiers, property names, postfix and TS non-null cannot hide a real dynamic import after division',async t=>{
 for(const source of [
  "const of=1; const ratio=of / import('./runtime.fixture.js' + suffix) / 2;",
  "const obj={return:1}; const ratio=obj.return / import(helper) / 2;",
  "let x=1; const ratio=x++ / import(helper) / 2;",
  "let x=1; const ratio=x-- / import(helper) / 2;",
  "declare const x:number; const ratio=x! / import(helper) / 2;",
 ]){
  const f=await helperFixture(t,{'runtime.fixture.js':'export {};'},source);assert.equal(await f.classify(),true,source);
 }
 const regex=await helperFixture(t,{},'const of=1; const pattern=/import(helper)/; const ratio=of / 2;');assert.equal(await regex.classify(),false);
 const invalid=await helperFixture(t,{},"import {broken from './runtime.fixture.js';");assert.equal(await invalid.classify(),true);
});

test('Pure fixture cycles and graphs beyond the bounded inspection budget cannot silently become units',async t=>{
 const cycle=await helperFixture(t,{'runtime.fixture.ts':"import './second.fixture.ts';",'second.fixture.ts':"import './runtime.fixture.js';"});assert.equal(await cycle.classify(),true);
 const files=Object.fromEntries(Array.from({length:65},(_,index)=>['part'+index+'.ts',index===64?'export {};':"import './part"+(index+1)+".ts';"]));
 const large=await helperFixture(t,files,"import './part0.ts';");assert.equal(await large.classify(),true);
 const bytes=await helperFixture(t,{'runtime.fixture.ts':' '.repeat(2*1024*1024)});assert.equal(await bytes.classify(),true);
 const edges=await helperFixture(t,{'runtime.fixture.ts':'export {};'},"import './runtime.fixture.js';\n".repeat(257));assert.equal(await edges.classify(),true);
});

test('Real PostgreSQL bridge and chat regressions stay outside the unit-safe profile',async()=>{
 for(const name of ['device-codex-guard-races','system-role-queue-isolation','personal-group-bridge-isolation','project-chat-learning-receipt']){
  assert.equal(await externalSuite(path.join(repository,'services/catalog-service/test',name+'-postgres.test.ts')),true,name);
 }
 for(const name of ['DEVICE_CODEX_GUARD_TEST_ADMIN_URL','SYSTEM_ROLE_QUEUE_TEST_ADMIN_URL','PROJECT_CHAT_LEARNING_TEST_ADMIN_URL','PERSONAL_GROUP_BRIDGE_TEST_PG_URL'])assert.ok(ownedPgAliases.includes(name),name);
});

for(const source of ["import type {Pool} from 'pg';", "import type Pg from 'pg';", "import type * as Pg from 'pg';", "import type Pg = require('pg');"]){
 test('An explicitly reviewed erased declaration is admitted: '+source,async t=>{
  const f=await fixture(t,source);assert.equal(typeof await validateAuditedUnit(f.root,relative,f.entry),'string');
 });
}

for(const source of [
 "import {Pool} from 'pg';", "import Pg from 'pg';", "import * as Pg from 'pg';", "import 'pg';",
 "import {Pool,type PoolClient} from 'pg';", "import {type PoolClient} from 'pg';", "const pg=require('pg');",
 "const pg=require /* gap */ ('pg');", "const pg=import('pg');", "import Pg = require('pg');", "export {Pool} from 'pg';",
 "export * from 'pg';", "import {Client} from 'minio';", "const s3=require('@aws-sdk/client-s3');",
])test('A runtime infrastructure dependency cannot receive even a matching reviewed exemption: '+source,async t=>{
 const f=await fixture(t,source);await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);
});

test('An ordinary unused value import is retained; no unused-import transpiler elision is allowed',async t=>{
 const f=await fixture(t,"import {Pool} from 'pg';\nconst noDatabaseWasUsed=true;\n");
 await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);
});

test('The actual shared predicate rejects runtime pg forms outside the reviewed profile',async t=>{
 for(const source of ["import 'pg';", "const pg=require('pg');", "const pg=require /* gap */ ('pg');", "const pg=import('pg');", "import Pg = require('pg');", "export * from 'pg';"]){
  const f=await fixture(t,source);assert.equal(await externalSuite(f.file),true,source);
  await assert.rejects(focusedSelection({root:f.root,packages:[['catalog-service','services/catalog-service']],chosen:new Set(['catalog-service']),testFiles:['test/reviewed.test.ts'],unit:true,native:false,integration:false,ownedPg:false}),/cannot select infrastructure/);
 }
});

test('A test edit adding bootstrap is not silently approved by its old path',async t=>{
 const f=await fixture(t);await fs.appendFile(f.file,'service.onModuleInit();\n');
 await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Unit-safe audit changed.*Re-audit/);
});

test('A newly imported opaque fixture is denied without evaluating its sentinel',async t=>{
 const source=typeOnly+"import './opaque.fixture';\n",f=await fixture(t,source),sentinel=path.join(f.root,'EXECUTED');
 await fs.writeFile(path.join(path.dirname(f.file),'opaque.fixture.ts'),"import {writeFileSync} from 'node:fs';\nwriteFileSync("+JSON.stringify(sentinel)+",'bad');\nimport {Pool} from 'pg';\n");
 await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
});

test('A pinned helper edit cannot hide a second-hop PG fixture, cycle or S3 dispatch',async t=>{
 const helper='scripts/test/owned-helper.cjs',source=typeOnly+"import '../../../scripts/test/owned-helper.cjs';\n",f=await fixture(t,source);
 const filename=path.join(f.root,helper),original="module.exports={value:1};\n";
 await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,original);f.entry.helpers[helper]=digest(original);
 await validateAuditedUnit(f.root,relative,f.entry);
 for(const extra of ["require('./second.fixture');", "require('./owned-helper.cjs');", "require('minio');"]){
  await fs.writeFile(filename,original+extra);await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);
  // Even a deliberately forged fresh metadata pin does not approve chained helpers or runtime SDKs.
  f.entry.helpers[helper]=digest(original+extra);await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);
 }
});

test('Missing, redirected or escaped verification inputs fail closed',async t=>{
 const f=await fixture(t);await fs.unlink(f.file);await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);
 const actual=path.join(f.root,'actual.ts');await fs.writeFile(actual,typeOnly);await fs.symlink(actual,f.file);
 await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);await fs.unlink(f.file);
 for(const specifier of ['../../../../outside.js','file:///tmp/foreign.fixture.js']){
  const source=typeOnly+'import '+JSON.stringify(specifier)+';\n';await fs.writeFile(f.file,source);
  await assert.rejects(validateAuditedUnit(f.root,relative,{sha256:digest(source),helpers:{}}),/Re-audit/);
 }
});

test('Unsupported syntax cannot turn a type-only declaration into blanket admission',async t=>{
 const f=await fixture(t,typeOnly+'enum Value {One}\n');await assert.rejects(validateAuditedUnit(f.root,relative,f.entry),/Re-audit/);
});

test('Original hard markers remain stronger than a type-only declaration',async t=>{
 for(const [name,marker] of [['named-db.test.ts',''],['ordinary.test.ts','const input=process.env.CATALOG_TEST_PG_URL;'],['fixture.test.ts','const fixture=databaseFixture();'],['storage.test.ts','const storage=TEST_STORAGE_CONFIG;']]){
  const f=await fixture(t,typeOnly+marker),file=path.join(path.dirname(f.file),name);await fs.rename(f.file,file);assert.equal(await externalSuite(file),true);
 }
 const env=safeEnvironment({PATH:'/bin',CATALOG_PG_URL:'postgresql://unsafe@127.0.0.1:5432/postgres',CHAT_S3_SECRET_KEY:'unsafe'},process.execPath);
 assert.equal(env.CATALOG_PG_URL,undefined);assert.equal(env.CHAT_S3_SECRET_KEY,undefined);
});
