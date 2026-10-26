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

test('Eight real PostgreSQL fixtures and the runtime S3 candidate retain their infrastructure decision',async()=>{
 for(const name of ['agent-catalog','agent-jobs','agent-model-requirements','agent-source-management','agents-service-lifecycle','catalog-requests-targets','device-learning-expiry','mcp-host-access','snapshot-storage-signed-put']){
  assert.equal(await externalSuite(path.join(repository,'services/catalog-service/test',name+'.test.ts')),true,name);
 }
 // Existing owned fake-HTTP S3 coverage is not reclassified by a pg-type exemption.
 assert.equal(await externalSuite(path.join(repository,'services/catalog-service/test/s3-bucket-privacy.test.ts')),false);
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
