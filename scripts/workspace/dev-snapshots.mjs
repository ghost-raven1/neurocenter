import fs from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPairSync,createPrivateKey,createPublicKey,createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {privateSnapshotFile} from '../snapshots/control.mjs';
import {withDockerBuildCa} from './docker-build-ca.mjs';
import {runDockerBuild} from './docker-build-progress.mjs';

/** The first dependency download may need an explicit larger budget on a slow registry connection. */
function buildTimeoutSeconds(environment){
 const value=environment.SNAPSHOT_VERIFIER_BUILD_TIMEOUT_SECONDS??'600';
 if(typeof value!=='string'||!/^\d+$/.test(value)||Number(value)<1||Number(value)>3600)throw new Error('SNAPSHOT_VERIFIER_BUILD_TIMEOUT_SECONDS: задайте целое число от 1 до 3600 секунд.');
 return Number(value);
}

/** Opt-in request diagnostics apply only while building the verifier image. */
function npmDiagnosticsEnabled(environment){
 const value=environment.SNAPSHOT_VERIFIER_NPM_DIAGNOSTICS===undefined?'0':environment.SNAPSHOT_VERIFIER_NPM_DIAGNOSTICS;
 if(value!=='0'&&value!=='1')throw new Error('SNAPSHOT_VERIFIER_NPM_DIAGNOSTICS: задайте 0 или 1.');
 return value==='1';
}

/** Host networking is an explicit build-only workaround for a broken Docker DNS path. */
function buildNetwork(environment){
 const value=environment.SNAPSHOT_VERIFIER_BUILD_NETWORK===undefined?'default':environment.SNAPSHOT_VERIFIER_BUILD_NETWORK;
 if(value!=='default'&&value!=='host')throw new Error('SNAPSHOT_VERIFIER_BUILD_NETWORK: задайте default или host.');
 return value;
}

/** Preserve the process outcome without copying arbitrary Docker errors or environment values into the message. */
function dockerFailure(result,seconds){
 if(result.error?.code==='ETIMEDOUT')return `превышен лимит ${seconds} с (ETIMEDOUT)`;
 if(result.error)return `ошибка запуска Docker (${typeof result.error.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(result.error.code)?result.error.code:'DOCKER_START_FAILED'})`;
 if(result.signal)return `Docker завершён сигналом ${/^SIG[A-Z0-9]+$/.test(result.signal)?result.signal:'UNKNOWN'}`;
 if(result.status!==0)return `Docker завершился с кодом ${Number.isInteger(result.status)?result.status:'UNKNOWN'}`;
 return null;
}

/** A missing signing key must never be replaced while signed snapshots or profiles exist. */
export async function prepareDevSnapshots(root,environment=process.env){
 const buildSeconds=environment.SNAPSHOT_VERIFIER_IMAGE?600:buildTimeoutSeconds(environment),npmDiagnostics=environment.SNAPSHOT_VERIFIER_IMAGE?false:npmDiagnosticsEnabled(environment),network=environment.SNAPSHOT_VERIFIER_IMAGE?'default':buildNetwork(environment);
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
 if(!environment.SNAPSHOT_VERIFIER_IMAGE){await withDockerBuildCa(root,environment,async({environment:buildEnvironment,args})=>{
  // Docker reads these values from its environment; credentials never become command arguments.
  const proxyArgs=['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'].filter(name=>Object.hasOwn(buildEnvironment,name)&&buildEnvironment[name]!==undefined).flatMap(name=>['--build-arg',name]);
  console.log(`Образ проверки снимков: network=${network}; npm-diagnostics=${Number(npmDiagnostics)}; timeout=${buildSeconds}s; explicit-proxy=${proxyArgs.filter(name=>name!=='--build-arg').join(',')||'none (Docker client settings may apply)'}`);
  const build=await runDockerBuild(['build',...args,...proxyArgs,...(network==='host'?['--network=host']:[]),...(npmDiagnostics?['--build-arg','NEUROCENTER_NPM_DIAGNOSTICS=1']:[]),'-f','services/catalog-service/snapshot-verifier.Dockerfile','-t',image,'.'],{cwd:root,env:buildEnvironment,stdio:'inherit',timeout:buildSeconds*1000,killSignal:'SIGKILL'}),failure=dockerFailure(build,buildSeconds);
  if(failure)throw new Error(`Образ проверки снимков не собран: ${failure}. Прежний запуск сохранён.${build.error?.code==='ETIMEDOUT'?' Лимит сборки задаётся SNAPSHOT_VERIFIER_BUILD_TIMEOUT_SECONDS (1–3600 с).':''}`,{cause:build.error});
 });}
 const inspected=spawnSync('docker',['image','inspect',image,'--format','{{.Id}}'],{cwd:root,encoding:'utf8',timeout:15000,killSignal:'SIGKILL'}),failure=dockerFailure(inspected,15);
 if(failure)throw new Error(`Образ проверки снимков недоступен: ${failure}. Прежний запуск сохранён.`,{cause:inspected.error});
 const imageId=String(inspected.stdout??'').trim();if(!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new Error('Образ проверки снимков недоступен: Docker не вернул корректный digest. Прежний запуск сохранён.');
 return {catalog:{...Object.fromEntries(Object.entries(environment).filter(([key])=>key.startsWith('SNAPSHOT_')&&!key.startsWith('SNAPSHOT_RUNNER_')&&!['SNAPSHOT_VERIFIER_BUILD_TIMEOUT_SECONDS','SNAPSHOT_VERIFIER_NPM_DIAGNOSTICS','SNAPSHOT_VERIFIER_BUILD_NETWORK'].includes(key))),SNAPSHOT_SIGNING_KEY_FILE:keyFile,SNAPSHOT_VERIFIER_TOKEN_FILE:tokenFile,SNAPSHOT_VERIFIER_IMAGE_DIGEST:imageId,...(environment.SNAPSHOT_TRUSTED_KEYS_FILE?{SNAPSHOT_TRUSTED_KEYS_FILE:path.resolve(root,environment.SNAPSHOT_TRUSTED_KEYS_FILE)}:{})},runner:{PATH:environment.PATH,HOME:environment.HOME,TMPDIR:environment.TMPDIR,SNAPSHOT_MAX_BYTES:environment.SNAPSHOT_MAX_BYTES||String(16*1024**3),SNAPSHOT_STAGING_MAX_BYTES:environment.SNAPSHOT_STAGING_MAX_BYTES||String(32*1024**3),SNAPSHOT_RUNNER_DIRECTORY:path.join(directory,'work'),SNAPSHOT_RUNNER_CATALOG_URL:'http://127.0.0.1:4100',SNAPSHOT_RUNNER_IMAGE:imageId,SNAPSHOT_RUNNER_TOKEN_FILE:tokenFile}};
}
