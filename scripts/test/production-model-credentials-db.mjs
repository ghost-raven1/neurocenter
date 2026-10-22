import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ensureModelCredentialKey,modelCredentialIdentity} from '../workspace/model-credentials.mjs';
import {assertProductionModelKey} from '../production/model-credentials.mjs';
import {storedModelKeyIds} from '../workspace/model-credential-store.mjs';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.CATALOG_TEST_PG_URL).href;
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url)),{Pool}=require('pg');
const adminUrl=new URL(adminConnection),name='nc_credential_test_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:adminUrl.href,max:1,connectionTimeoutMillis:1500});let database,created=false,temporary;
const cases=[];
const check=async(name,action)=>{await action();cases.push({name,passed:true});};
try{
 await admin.query('CREATE DATABASE '+name);created=true;const databaseUrl=new URL(adminUrl);databaseUrl.pathname='/'+name;
 database=new Pool({connectionString:databaseUrl.href,max:1,connectionTimeoutMillis:1500});
 temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc-key-postgres-')));
 const config=directory=>({secrets:{model_credential_key:{file:path.join(directory,'secrets/model_credential_key')}}});
 const sql=async query=>{const result=await database.query(query);return String(Object.values(result.rows[0])[0]===false?'f':Object.values(result.rows[0])[0]===true?'t':JSON.stringify(Object.values(result.rows[0])[0]));};
 await check('First-upgrade catalog without private table has no stored key IDs',async()=>assert.deepEqual(await storedModelKeyIds(sql),[]));
 await database.query('CREATE TABLE model_remote_connections(credential_kind text,credential jsonb)');
 await check('Readonly empty-catalog preflight does not create a key',async()=>{assert.equal((await assertProductionModelKey(temporary,config(temporary),sql,{allowMissing:true})).keyId,null);await assert.rejects(stat(path.join(temporary,'secrets')),{code:'ENOENT'});});
 await database.query("INSERT INTO model_remote_connections VALUES('stored',$1::jsonb)",[JSON.stringify({keyId:'a'.repeat(24)})]);
 await check('Missing key cannot be initialized over existing encrypted credentials',async()=>{await assert.rejects(assertProductionModelKey(temporary,config(temporary),sql,{allowMissing:true}),/Восстановите исходные/);await assert.rejects(stat(path.join(temporary,'secrets')),{code:'ENOENT'});});
 await ensureModelCredentialKey(temporary);const identity=await modelCredentialIdentity(temporary);
 await database.query("UPDATE model_remote_connections SET credential=$1::jsonb",[JSON.stringify({keyId:identity.keyId})]);
 await check('Actual PostgreSQL JSON aggregate and original key identity permit restore',async()=>{assert.deepEqual(await storedModelKeyIds(sql),[identity.keyId]);assert.equal((await assertProductionModelKey(temporary,config(temporary),sql)).keyId,identity.keyId);});
 const other=path.join(temporary,'other');await mkdir(other,{mode:0o700});await ensureModelCredentialKey(other);
 await check('Fresh configure key cannot open restored original catalog and is not overwritten',async()=>{const file=path.join(other,'secrets/model_credential_key'),before=await readFile(file);await assert.rejects(assertProductionModelKey(other,config(other),sql),/Восстановите исходные/);assert.deepEqual(await readFile(file),before);});
 await database.query("INSERT INTO model_remote_connections VALUES('stored','{}'::jsonb)");
 await check('Malformed historical stored credential keyId blocks readiness',async()=>{await assert.rejects(assertProductionModelKey(temporary,config(temporary),sql),/Восстановите исходные/);});
 await database.query("DELETE FROM model_remote_connections WHERE credential='{}'::jsonb;INSERT INTO model_remote_connections VALUES('none',NULL),('environment',NULL)");
 await check('Environment and keyless connections do not invent master key identities',async()=>assert.deepEqual(await storedModelKeyIds(sql),[identity.keyId]));
 const output=path.resolve('output/model-key-review');await mkdir(output,{recursive:true});await writeFile(path.join(output,'real-postgres.json'),JSON.stringify({at:new Date().toISOString(),cases,existingDatabasesChanged:false,liveConfigChanged:false,keyContentsLogged:false},null,2)+'\n');
 console.log(JSON.stringify({passed:cases.length,failed:0,existingDatabasesChanged:false,keyContentsLogged:false}));
}finally{
 await database?.end();if(created)await admin.query('DROP DATABASE '+name);await admin.end();if(temporary)await rm(temporary,{recursive:true,force:true});
}
