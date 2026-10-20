import {createRequire} from 'node:module';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {modelCredentialEnvironment,modelCredentialEnvironmentIdentity} from './model-credentials.mjs';
import {assertStoredModelKey,modelKeyUnavailable} from './model-credential-store.mjs';

async function catalogUrlFile(filename){
    const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const before=await file.stat();if(!before.isFile()||before.size>65536)throw modelKeyUnavailable();
        const value=(await file.readFile('utf8')).replace(/\r?\n$/,''),after=await file.stat();
        if(!value||/[\x00\r\n]/.test(value)||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw modelKeyUnavailable();return value;
    }finally{await file.close();}
}

/** Catalog connection and key checks finish before old dev processes may be stopped. */
export async function prepareDevModelCredentials(root,environment=process.env,{sql}={}){
    let client;
    try{
        if(!sql){
            let connectionString=environment.CATALOG_PG_URL;
            if(environment.CATALOG_PG_URL_FILE){
                if(connectionString)throw modelKeyUnavailable();
                connectionString=await catalogUrlFile(path.resolve(root,environment.CATALOG_PG_URL_FILE));
            }
            const {Client}=createRequire(path.join(root,'services/catalog-service/package.json'))('pg');
            client=new Client({connectionString:connectionString||'postgresql://rag:rag@localhost:5432/catalog',connectionTimeoutMillis:10000,query_timeout:10000});
            await client.connect();await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
            sql=async query=>{const result=await client.query(query),value=Object.values(result.rows[0]||{})[0];return typeof value==='boolean'?(value?'t':'f'):JSON.stringify(value);};
        }
        const before=await modelCredentialEnvironmentIdentity(root,environment);
        await assertStoredModelKey(before?.keyId??null,sql);
        const credentials=await modelCredentialEnvironment(root,environment),ready=await modelCredentialEnvironmentIdentity(root,environment);
        if(!ready||before&&before.keyId!==ready.keyId)throw modelKeyUnavailable();
        await assertStoredModelKey(ready.keyId,sql);
        if((await modelCredentialEnvironmentIdentity(root,environment))?.keyId!==ready.keyId)throw modelKeyUnavailable();
        if(environment.NEUROCENTER_MODEL_CREDENTIAL_KEY!==undefined)return {NEUROCENTER_MODEL_CREDENTIAL_KEY:environment.NEUROCENTER_MODEL_CREDENTIAL_KEY};
        return ready.filename?{NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE:ready.filename}:credentials;
    }catch(error){if(error instanceof Error&&/Ключ шифрования моделей/.test(error.message))throw error;throw modelKeyUnavailable();}
    finally{if(client){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}}
}
