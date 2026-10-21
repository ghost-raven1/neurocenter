#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,randomBytes,createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {privateSnapshotFile} from './control.mjs';

/** Explicit operator setup checks persisted identities before creating any signing material. */
export async function initializeSnapshotRunner(directory){
 for(const folder of [directory,path.join(directory,'secrets')]){await fs.mkdir(folder,{recursive:true,mode:0o700});const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error('UNSAFE_OPERATOR_DIRECTORY');}
 const secrets=path.join(directory,'secrets'),keyFile=path.join(secrets,'snapshot_signing_key'),tokenFile=path.join(secrets,'snapshot_verifier_token');
 const {Client}=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url))('pg');
 const connectionString=(await privateSnapshotFile(path.join(secrets,'catalog_url'),65536)).toString('utf8').trim(),client=new Client({connectionString,connectionTimeoutMillis:10000,query_timeout:10000});await client.connect();
 try{
  await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:snapshot-signing-identity',0))");
  const ids=new Set();for(const table of ['project_snapshots','project_snapshot_profiles'])if((await client.query('SELECT to_regclass($1) AS present',[table])).rows[0].present){for(const row of(await client.query(`SELECT DISTINCT signature->>'keyId' AS id FROM ${table} WHERE signature IS NOT NULL`)).rows)ids.add(row.id);}
  let key;try{key=await privateSnapshotFile(keyFile);}catch(error){if(error.code!=='ENOENT')throw error;if(ids.size)throw new Error('SIGNING_KEY_MISSING_FOR_EXISTING_DATA');
   await fs.writeFile(keyFile,generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600,flush:true});key=await privateSnapshotFile(keyFile);
  }
  const parsed=createPrivateKey(key);if(parsed.asymmetricKeyType!=='ed25519')throw new Error('INVALID_SIGNING_KEY');
  const pem=createPublicKey(parsed).export({type:'spki',format:'pem'}).toString(),known=new Set([createHash('sha256').update(pem).digest('hex')]);
  try{const ring=JSON.parse((await privateSnapshotFile(path.join(secrets,'snapshot_trusted_keys.json'),65536)).toString('utf8'));if(!ring||typeof ring!=='object'||Array.isArray(ring))throw new Error('INVALID_KEY_RING');for(const[id,value]of Object.entries(ring)){if(typeof value!=='string'||createHash('sha256').update(value).digest('hex')!==id||createPublicKey(value).asymmetricKeyType!=='ed25519')throw new Error('INVALID_KEY_RING');known.add(id);}}catch(error){if(error.code!=='ENOENT')throw error;}
  if([...ids].some(id=>!known.has(id)))throw new Error('STORED_SIGNING_IDENTITY_CHANGED');
  try{await privateSnapshotFile(tokenFile,1024);}catch(error){if(error.code!=='ENOENT')throw error;await fs.writeFile(tokenFile,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600,flush:true});}
  if(!/^[a-f0-9]{64,128}$/.test((await privateSnapshotFile(tokenFile,1024)).toString('utf8').trim()))throw new Error('INVALID_RUNNER_TOKEN');
  const folder=await fs.open(secrets,'r');try{await folder.sync();}finally{await folder.close();}return {ready:true,keyId:[...known][0]};
 }finally{await client.query('COMMIT').catch(()=>undefined);await client.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--directory'){console.error('Нужен --directory <private production config>.');process.exitCode=1;}
 else initializeSnapshotRunner(path.resolve(args[1])).then(()=>console.log('Ключ подписи и токен готовы; закрытые значения не выводятся.')).catch(()=>{console.error('Настройка снимков остановлена: проверьте права, подключение к каталогу и исходный ключ подписи. Существующие ключи не заменяются.');process.exitCode=1;});
}
