import fs from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPairSync,createPrivateKey,createPublicKey,createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {privateSnapshotFile} from '../snapshots/control.mjs';
import {withDockerBuildCa} from './docker-build-ca.mjs';

/** A missing signing key must never be replaced while signed snapshots or profiles exist. */
export async function prepareDevSnapshots(root,environment=process.env){
 const directory=path.join(root,'.run/project-snapshots'),secrets=path.join(directory,'secrets');await fs.mkdir(secrets,{recursive:true,mode:0o700});
 const keyFile=path.resolve(root,environment.SNAPSHOT_SIGNING_KEY_FILE||path.join(secrets,'signing.pem'));
 const tokenFile=path.resolve(root,environment.SNAPSHOT_VERIFIER_TOKEN_FILE||path.join(secrets,'verifier-token'));
 if(environment.SNAPSHOT_VERIFIER_TOKEN)throw new Error('Для исполнителя снимков задайте SNAPSHOT_VERIFIER_TOKEN_FILE.');
 let url=environment.CATALOG_PG_URL;
 if(environment.CATALOG_PG_URL_FILE){if(url)throw new Error('Задайте только CATALOG_PG_URL_FILE.');url=(await privateSnapshotFile(path.resolve(root,environment.CATALOG_PG_URL_FILE),65536)).toString('utf8').trim();}
 const {Client}=createRequire(path.join(root,'services/catalog-service/package.json'))('pg'),client=new Client({connectionString:url||'postgresql://rag:rag@localhost:5432/catalog',connectionTimeoutMillis:10000,query_timeout:10000});
 await client.connect();
 try{
  await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:snapshot-signing-identity',0))");
  const tables=(await client.query("SELECT to_regclass('project_snapshots') AS snapshots,to_regclass('project_snapshot_profiles') AS profiles")).rows[0];
  const ids=new Set();for(const [name,present]of [['project_snapshots',tables.snapshots],['project_snapshot_profiles',tables.profiles]])if(present){for(const row of(await client.query(`SELECT DISTINCT signature->>'keyId' AS id FROM ${name} WHERE signature IS NOT NULL`)).rows)ids.add(row.id);}
  let bytes;try{bytes=await privateSnapshotFile(keyFile);}catch(error){if(error.code!=='ENOENT')throw error;if(ids.size)throw new Error('Ключ подписи снимков потерян. Восстановите исходный ключ; новый не создаётся.');
   bytes=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});try{await fs.writeFile(keyFile,bytes,{flag:'wx',mode:0o600});}catch(writeError){if(writeError.code!=='EEXIST')throw writeError;}bytes=await privateSnapshotFile(keyFile);
  }
  const privateKey=createPrivateKey(bytes);if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('Нужен ключ Ed25519.');
  const pem=createPublicKey(privateKey).export({format:'pem',type:'spki'}).toString(),trusted=new Set([createHash('sha256').update(pem).digest('hex')]);
  if(environment.SNAPSHOT_TRUSTED_KEYS_FILE){const ring=JSON.parse((await privateSnapshotFile(path.resolve(root,environment.SNAPSHOT_TRUSTED_KEYS_FILE),65536)).toString('utf8'));
   if(!ring||typeof ring!=='object'||Array.isArray(ring))throw new Error('Некорректное кольцо ключей снимков.');for(const[id,key]of Object.entries(ring)){if(typeof key!=='string'||createHash('sha256').update(key).digest('hex')!==id||createPublicKey(key).asymmetricKeyType!=='ed25519')throw new Error('Некорректный доверенный ключ снимков.');trusted.add(id);}}
  if([...ids].some(id=>!trusted.has(id)))throw new Error('Ключи подписанных снимков не совпадают. Верните исходную конфигурацию ключей.');
 }finally{await client.query('COMMIT').catch(()=>undefined);await client.end();}
 try{await privateSnapshotFile(tokenFile,1024);}catch(error){if(error.code!=='ENOENT')throw error;try{await fs.writeFile(tokenFile,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});}catch(writeError){if(writeError.code!=='EEXIST')throw writeError;}}
 const token=(await privateSnapshotFile(tokenFile,1024)).toString('utf8').trim();if(!/^[a-f0-9]{64,128}$/.test(token))throw new Error('Некорректный токен исполнителя снимков.');
 const image=environment.SNAPSHOT_VERIFIER_IMAGE||'neurocenter-snapshot-verifier:local';
 if(!environment.SNAPSHOT_VERIFIER_IMAGE){await withDockerBuildCa(root,environment,({environment:buildEnvironment,args})=>{const build=spawnSync('docker',['build',...args,'-f','services/catalog-service/snapshot-verifier.Dockerfile','-t',image,'.'],{cwd:root,env:buildEnvironment,stdio:'inherit',timeout:600000});if(build.error||build.status!==0)throw new Error('Образ проверки снимков не собран; прежний запуск сохранён.');});}
 const inspected=spawnSync('docker',['image','inspect',image,'--format','{{.Id}}'],{cwd:root,encoding:'utf8',timeout:15000});if(inspected.status!==0||!/^sha256:[a-f0-9]{64}$/.test(inspected.stdout.trim()))throw new Error('Образ проверки снимков недоступен.');
 const imageId=inspected.stdout.trim();
 return {catalog:{...Object.fromEntries(Object.entries(environment).filter(([key])=>key.startsWith('SNAPSHOT_')&&!key.startsWith('SNAPSHOT_RUNNER_'))),SNAPSHOT_SIGNING_KEY_FILE:keyFile,SNAPSHOT_VERIFIER_TOKEN_FILE:tokenFile,SNAPSHOT_VERIFIER_IMAGE_DIGEST:imageId,...(environment.SNAPSHOT_TRUSTED_KEYS_FILE?{SNAPSHOT_TRUSTED_KEYS_FILE:path.resolve(root,environment.SNAPSHOT_TRUSTED_KEYS_FILE)}:{})},runner:{PATH:environment.PATH,HOME:environment.HOME,TMPDIR:environment.TMPDIR,SNAPSHOT_MAX_BYTES:environment.SNAPSHOT_MAX_BYTES||String(16*1024**3),SNAPSHOT_STAGING_MAX_BYTES:environment.SNAPSHOT_STAGING_MAX_BYTES||String(32*1024**3),SNAPSHOT_RUNNER_DIRECTORY:path.join(directory,'work'),SNAPSHOT_RUNNER_CATALOG_URL:'http://127.0.0.1:4100',SNAPSHOT_RUNNER_IMAGE:imageId,SNAPSHOT_RUNNER_TOKEN_FILE:tokenFile}};
}
