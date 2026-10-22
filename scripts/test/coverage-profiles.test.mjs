import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {integrationConfiguration,safeEnvironment,tapCounts} from '../coverage/profiles.mjs';
import {untrackedContentDigest} from '../coverage/source-identity.mjs';
import {coverageMethod,manifestCoverageKinds} from '../coverage/methods.mjs';

test('Coverage never inherits a caller database, object store or V8 output in the unit/native profile',()=>{
 const env=safeEnvironment({PATH:'/bin',CATALOG_PG_URL:'must-not-inherit',CATALOG_PG_URL_FILE:'/secret',MODEL_CHAT_TEST_ADMIN_URL:'must-not-inherit',
  MODEL_CHAT_TEST_STORAGE_CONFIG:'/private',MINIO_ROOT_PASSWORD:'private',CHAT_S3_SECRET_KEY:'private',NODE_V8_COVERAGE:'/old',SOME_TEST_URL:'old',SSO_DISABLE:'true'},'/owned/node');
 assert.equal(env.NODE_ENV,'test');assert.equal(env.SSO_DISABLE,'true');assert.ok(env.PATH.startsWith('/owned'+path.delimiter));
 for(const key of ['CATALOG_PG_URL','CATALOG_PG_URL_FILE','MODEL_CHAT_TEST_ADMIN_URL','MODEL_CHAT_TEST_STORAGE_CONFIG','MINIO_ROOT_PASSWORD','CHAT_S3_SECRET_KEY','NODE_V8_COVERAGE','SOME_TEST_URL'])assert.equal(key in env,false);
});
test('Integration has no default and rejects the main PostgreSQL, another host and an application database',async()=>{
 for(const value of [undefined,'bad','postgresql://qa:qa@127.0.0.1:5432/postgres','postgresql://qa:qa@remote.test:59616/postgres',
  'postgresql://qa:qa@127.0.0.1:59616/catalog','https://127.0.0.1:59616/postgres','postgresql://qa:qa@127.0.0.1/postgres'])
  await assert.rejects(integrationConfiguration({MODEL_CHAT_TEST_ADMIN_URL:value},'/'));
});
test('One explicitly owned database fills every legacy fixture variable without exposing credentials in report metadata',async()=>{
 const value='postgresql://fixture:private-test-value@127.0.0.1:59616/postgres';
 const result=await integrationConfiguration({MODEL_CHAT_TEST_ADMIN_URL:value},'/');
 assert.ok(Object.values(result.env).every(item=>item===value));assert.equal(result.env.MODEL_USAGE_TEST_ADMIN_URL,value);assert.equal(result.env.OPENCODE_MODEL_SYNC_TEST_PG_URL,value);
 assert.equal(JSON.stringify(result.fixture).includes('private-test-value'),false);assert.equal(result.suites.includes('model-chat-files-http.test.mjs'),false);assert.equal(result.excludedSuites.length,1);
});
test('Optional S3 uses a separate explicit config, never the main endpoint, and secrets stay outside metadata',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-coverage-profile-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const filename=path.join(directory,'storage.json'),base={CHAT_S3_ENDPOINT:'http://127.0.0.1:59617',CHAT_S3_REGION:'test',CHAT_S3_ACCESS_KEY:'synthetic-access',CHAT_S3_SECRET_KEY:'synthetic-secret',CHAT_S3_PROJECT_BUCKET:'qa-project',CHAT_S3_PERSONAL_BUCKET:'qa-personal'};
 const env={MODEL_CHAT_TEST_ADMIN_URL:'postgresql://qa:qa@127.0.0.1:59616/postgres',MODEL_CHAT_TEST_STORAGE_CONFIG:filename};
 await fs.writeFile(filename,JSON.stringify(base));const result=await integrationConfiguration(env,directory);
 assert.ok(result.suites.includes('model-chat-files-http.test.mjs'));assert.equal(result.excludedSuites.length,0);assert.equal(result.env.MODEL_CHAT_TEST_STORAGE_CONFIG,filename);assert.equal(JSON.stringify(result.fixture).includes('synthetic-secret'),false);
 for(const override of [{CHAT_S3_ENDPOINT:'http://127.0.0.1:19010'},{CHAT_S3_ENDPOINT:'http://remote.test:59617'},{CHAT_S3_SECRET_KEY:''},{CHAT_S3_PERSONAL_BUCKET:'qa-project'}]){
  await fs.writeFile(filename,JSON.stringify({...base,...override}));await assert.rejects(integrationConfiguration(env,directory));
 }
});
test('Owned integration includes chat recovery SQL using only its admitted PostgreSQL, overriding a caller alias',async()=>{
 const owned='postgresql://fixture:private-test-value@127.0.0.1:59616/postgres';
 const caller='postgresql://unsafe:unsafe@127.0.0.1:5432/postgres';
 const result=await integrationConfiguration({MODEL_CHAT_TEST_ADMIN_URL:owned,CHAT_RECOVERY_TEST_ADMIN_PG_URL:caller},'/');
 assert.equal(result.env.CHAT_RECOVERY_TEST_ADMIN_PG_URL,owned);
 assert.equal(result.suites.filter(file=>file==='chat-recovery-postgres.test.mjs').length,1);
 assert.equal(JSON.stringify(result.fixture).includes('private-test-value'),false);
 assert.equal(safeEnvironment({CHAT_RECOVERY_TEST_ADMIN_PG_URL:caller}).CHAT_RECOVERY_TEST_ADMIN_PG_URL,undefined);
});
test('TAP footer counts preserve failures, skips and cancellation; missing output is incomplete',()=>{
 assert.deepEqual(tapCounts('# pass 12\n# fail 1\n# skipped 2\n# cancelled 3\n'),{passed:12,failed:1,skipped:2,cancelled:3});
 assert.deepEqual(tapCounts('process died before summary'),{passed:null,failed:null,skipped:null,cancelled:null});
});
test('Editing an existing untracked source changes identity even when the file inventory is identical',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-coverage-identity-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.writeFile(path.join(directory,'new-source.ts'),'export const value=1;');await fs.writeFile(path.join(directory,'other.ts'),'export {};');
 const files=['new-source.ts','other.ts'],before=untrackedContentDigest(directory,files);assert.equal(untrackedContentDigest(directory,[...files].reverse()),before);
 await fs.writeFile(path.join(directory,'new-source.ts'),'export const value=2;');assert.notEqual(untrackedContentDigest(directory,files),before);
});
test('Native c8 and Vitest AST cannot silently become a single comparable percentage',()=>{
 assert.deepEqual(coverageMethod(['vitest-ast-v8','vitest-ast-v8']),{coverageKind:'vitest-ast-v8',comparablePercentages:true});
 assert.throws(()=>coverageMethod(['vitest-ast-v8','native-c8-v8']),/experimental/);
 assert.deepEqual(coverageMethod(['vitest-ast-v8','native-c8-v8'],true),{coverageKind:'experimental-mixed-instrumentation',comparablePercentages:false});
 assert.deepEqual(manifestCoverageKinds({packages:[{}],native:{}}),['vitest-ast-v8','native-c8-v8']);
});
