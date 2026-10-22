import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createHash,createPublicKey,generateKeyPairSync,randomUUID} from 'node:crypto';
import {prepareDevSnapshots} from '../workspace/dev-snapshots.mjs';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.CATALOG_TEST_PG_URL).href;
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url)),{Pool,Client}=require('pg');
const source=new URL(adminConnection),databaseName='nc_snapshot_keys_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:source.href,max:1,connectionTimeoutMillis:1500}),cases=[];
let created=false,database,temporary,writer;
const check=async(name,action)=>{await action();cases.push({name,passed:true});};
const sameSecret=(actual,expected)=>assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(expected).digest('hex'));
const identity=key=>createHash('sha256').update(createPublicKey(key).export({format:'pem',type:'spki'})).digest('hex');
try{
 await admin.query('CREATE DATABASE '+databaseName);created=true;const target=new URL(source);target.pathname='/'+databaseName;
 database=new Pool({connectionString:target.href,max:2,connectionTimeoutMillis:1500});await database.query('CREATE TABLE project_snapshots(signature jsonb);CREATE TABLE project_snapshot_profiles(signature jsonb)');
 temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-snapshot-keys-postgres-')));
 await fs.mkdir(path.join(temporary,'services/catalog-service/node_modules'),{recursive:true});await fs.symlink(path.dirname(require.resolve('pg/package.json')),path.join(temporary,'services/catalog-service/node_modules/pg'));
 const environment={CATALOG_PG_URL:target.href,SNAPSHOT_VERIFIER_IMAGE:process.env.SNAPSHOT_TEST_VERIFIER_IMAGE||'neurocenter-snapshot-verifier:local',SNAPSHOT_MAX_BYTES:'21474836480',PATH:process.env.PATH,HOME:process.env.HOME};
 let selected,keyFile,keyBytes,tokenBytes,keyId;
 await check('Actual empty PostgreSQL prepares persistent closed key/token; env contains filenames only',async()=>{
  selected=await prepareDevSnapshots(temporary,environment);keyFile=selected.catalog.SNAPSHOT_SIGNING_KEY_FILE;keyBytes=await fs.readFile(keyFile);tokenBytes=await fs.readFile(selected.catalog.SNAPSHOT_VERIFIER_TOKEN_FILE);keyId=identity(keyBytes);
  assert.equal((await fs.stat(keyFile)).mode&0o777,0o600);assert.equal((await fs.stat(selected.catalog.SNAPSHOT_VERIFIER_TOKEN_FILE)).mode&0o777,0o600);
  assert.ok(!JSON.stringify(selected).includes(keyBytes.toString().trim()));assert.ok(!JSON.stringify(selected).includes(tokenBytes.toString().trim()));assert.equal(selected.runner.SNAPSHOT_RUNNER_TOKEN_FILE,selected.catalog.SNAPSHOT_VERIFIER_TOKEN_FILE);assert.equal(selected.runner.SNAPSHOT_SIGNING_KEY_FILE,undefined);assert.equal(selected.runner.CATALOG_PG_URL,undefined);
 });
 await check('Repeat keeps the same key identity/token instead of reinitializing secrets',async()=>{await prepareDevSnapshots(temporary,environment);sameSecret(await fs.readFile(keyFile),keyBytes);sameSecret(await fs.readFile(selected.catalog.SNAPSHOT_VERIFIER_TOKEN_FILE),tokenBytes);});
 await database.query('INSERT INTO project_snapshots VALUES($1::jsonb)',[JSON.stringify({keyId})]);
 await check('Missing key with retained signature fails before replacement file creation',async()=>{await fs.rm(keyFile);await assert.rejects(prepareDevSnapshots(temporary,environment),/потерян/);await assert.rejects(fs.stat(keyFile),{code:'ENOENT'});await fs.writeFile(keyFile,keyBytes,{mode:0o600});});
 await check('A different valid operator key cannot replace the retained signing identity',async()=>{const other=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});await fs.writeFile(keyFile,other);await assert.rejects(prepareDevSnapshots(temporary,environment),/не совпадают/);sameSecret(await fs.readFile(keyFile),other);await fs.writeFile(keyFile,keyBytes);});
 await check('Historical trusted Ed25519 signatures are admitted only from the exact configured public ring',async()=>{
  const historical=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString(),oldId=createHash('sha256').update(historical).digest('hex'),ring=path.join(temporary,'trusted.json');
  await database.query('INSERT INTO project_snapshot_profiles VALUES($1::jsonb)',[JSON.stringify({keyId:oldId})]);await assert.rejects(prepareDevSnapshots(temporary,environment),/не совпадают/);
  await fs.writeFile(ring,JSON.stringify({[oldId]:historical}),{mode:0o600});const prepared=await prepareDevSnapshots(temporary,{...environment,SNAPSHOT_TRUSTED_KEYS_FILE:ring});assert.equal(prepared.catalog.SNAPSHOT_TRUSTED_KEYS_FILE,ring);sameSecret(await fs.readFile(keyFile),keyBytes);
  await database.query('DELETE FROM project_snapshot_profiles');
 });
 await check('Exclusive dev key preflight waits for an in-flight signing transaction and cannot rotate after its commit',async()=>{
  await database.query('DELETE FROM project_snapshots');await fs.rm(keyFile);writer=new Client({connectionString:target.href});await writer.connect();await writer.query('BEGIN');await writer.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('neurocenter:snapshot-signing-identity',0))");
  const pending=prepareDevSnapshots(temporary,environment),observed=pending.then(()=>({ok:true}),error=>({error}));let blocked=false;
  for(let index=0;index<100&&!blocked;index++){
   blocked=Number((await database.query("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND NOT l.granted",[databaseName])).rows[0].n)>0;if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(blocked,true);await assert.rejects(fs.stat(keyFile),{code:'ENOENT'});await writer.query('INSERT INTO project_snapshots VALUES($1::jsonb)',[JSON.stringify({keyId})]);await writer.query('COMMIT');await writer.end();writer=undefined;
  const result=await observed;assert.ok(result.error);assert.match(result.error.message,/потерян/);await assert.rejects(fs.stat(keyFile),{code:'ENOENT'});await fs.writeFile(keyFile,keyBytes,{mode:0o600});
 });
 await check('Configured server byte limit is the same explicit limit in the isolated worker',async()=>{const prepared=await prepareDevSnapshots(temporary,environment);assert.equal(prepared.catalog.SNAPSHOT_MAX_BYTES,environment.SNAPSHOT_MAX_BYTES);assert.equal(prepared.runner.SNAPSHOT_MAX_BYTES,environment.SNAPSHOT_MAX_BYTES);});
 await check('Explicit ambiguous PG configuration is rejected without touching key/token',async()=>{const filename=path.join(temporary,'pg-url');await fs.writeFile(filename,target.href,{mode:0o600});await assert.rejects(prepareDevSnapshots(temporary,{...environment,CATALOG_PG_URL_FILE:filename}),/только CATALOG_PG_URL_FILE/);sameSecret(await fs.readFile(keyFile),keyBytes);sameSecret(await fs.readFile(selected.catalog.SNAPSHOT_VERIFIER_TOKEN_FILE),tokenBytes);});
}finally{
 if(writer){await writer.query('ROLLBACK').catch(()=>undefined);await writer.end();}await database?.end();if(created)await admin.query('DROP DATABASE '+databaseName);await admin.end();if(temporary)await fs.rm(temporary,{recursive:true,force:true});
}
const directory=path.resolve('output/browser-feedback');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'snapshot-dev-keys-postgres.json'),JSON.stringify({checkedAt:new Date().toISOString(),passed:cases.length,cases,actualPostgres:true,dockerInspectionOnly:true,ownedDatabaseDropped:true,existingDatabasesChanged:false,liveConfigChanged:false,secretContentsLogged:false},null,2)+'\n');
console.log(JSON.stringify({passed:cases.length,actualPostgres:true,ownedDatabaseDropped:true,existingDatabasesChanged:false,secretContentsLogged:false}));
