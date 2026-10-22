import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,mkdir,symlink,readFile,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareDevModelCredentials} from '../workspace/dev-model-credentials.mjs';
import {modelCredentialEnvironmentIdentity} from '../workspace/model-credentials.mjs';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.CATALOG_TEST_PG_URL).href;
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url)),{Pool,Client}=require('pg');
const url=new URL(adminConnection),name='nc_dev_key_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:1500}),query=Client.prototype.query,cases=[];
let database,created=false,temporary,readOnlyTransactions=0;
const check=async(name,action)=>{await action();cases.push({name,passed:true});};
try{
 await admin.query('CREATE DATABASE '+name);created=true;const target=new URL(url);target.pathname='/'+name;
 database=new Pool({connectionString:target.href,max:1,connectionTimeoutMillis:1500});
 await database.query('CREATE TABLE model_remote_connections(credential_kind text,credential jsonb)');
 temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc-dev-key-postgres-')));
 await mkdir(path.join(temporary,'services/catalog-service/node_modules'),{recursive:true});
 await symlink(path.dirname(require.resolve('pg/package.json')),path.join(temporary,'services/catalog-service/node_modules/pg'));
 Client.prototype.query=async function(text,...args){const result=await query.call(this,text,...args);if(text==='BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'){const proof=await query.call(this,'SHOW transaction_read_only');assert.equal(proof.rows[0].transaction_read_only,'on');readOnlyTransactions++;}return result;};
 const environment={CATALOG_PG_URL:target.href};let filename,original,identity;
 await check('Actual empty PostgreSQL allows initial key only inside a read-only transaction',async()=>{const selected=await prepareDevModelCredentials(temporary,environment);filename=selected.NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE;original=await readFile(filename,'utf8');identity=await modelCredentialEnvironmentIdentity(temporary,environment);assert.equal(readOnlyTransactions,1);});
 await database.query("INSERT INTO model_remote_connections VALUES('stored',$1::jsonb)",[JSON.stringify({keyId:identity.keyId})]);
 await check('Existing stored identity preserves the original dev key',async()=>{await prepareDevModelCredentials(temporary,environment);assert.equal(await readFile(filename,'utf8'),original);});
 await rm(path.join(temporary,'.run/model-credentials'),{recursive:true});
 await check('Lost key and marker cannot regenerate against retained PostgreSQL IDs',async()=>{await assert.rejects(prepareDevModelCredentials(temporary,environment),/Восстановите исходные/);await assert.rejects(stat(path.join(temporary,'.run/model-credentials')),{code:'ENOENT'});});
 await check('Explicit original operator key is checked against actual PostgreSQL IDs',async()=>{const selected=await prepareDevModelCredentials(temporary,{...environment,NEUROCENTER_MODEL_CREDENTIAL_KEY:original.trim()});assert.equal(selected.NEUROCENTER_MODEL_CREDENTIAL_KEY,original.trim());});
 await check('Explicit valid but different key fails without generation',async()=>{await assert.rejects(prepareDevModelCredentials(temporary,{...environment,NEUROCENTER_MODEL_CREDENTIAL_KEY:Buffer.alloc(32,13).toString('base64')}),/Восстановите исходные/);await assert.rejects(stat(path.join(temporary,'.run/model-credentials')),{code:'ENOENT'});});
 await check('Actual keyId queries retain stored rows without ciphertext reads or writes',async()=>{assert.equal((await database.query('SELECT count(*)::int AS count FROM model_remote_connections')).rows[0].count,1);assert.equal(readOnlyTransactions,5);});
 const output=path.resolve('output/model-key-review');await mkdir(output,{recursive:true});await writeFile(path.join(output,'dev-real-postgres.json'),JSON.stringify({checkedAt:new Date().toISOString(),cases,readOnlyTransactions,existingDatabasesChanged:false,liveConfigChanged:false,keyContentsLogged:false},null,2)+'\n');
 console.log(JSON.stringify({passed:cases.length,readOnlyTransactions,existingDatabasesChanged:false,keyContentsLogged:false}));
}finally{
 Client.prototype.query=query;await database?.end();if(created)await admin.query('DROP DATABASE '+name);await admin.end();if(temporary)await rm(temporary,{recursive:true,force:true});
}
