import {createRequire} from 'node:module';
import {constants,createReadStream} from 'node:fs';
import {open,mkdir,rm,lstat,writeFile} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {snapshotRecoveryConfiguration,privateRecoveryFile} from './snapshot-recovery-config.mjs';
import {snapshotObjectKey,snapshotObjectFile,snapshotLocalFile,readSnapshotBlobs,snapshotBlobs} from './snapshot-recovery-metadata.mjs';
import {exportSnapshotKeys,readSnapshotSignatures,verifyBundleSnapshotKeys} from './snapshot-recovery-keys.mjs';
import {digestFile} from './recovery-files.mjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const quote=value=>"'"+value.replace(/'/g,"''")+"'";
/** Official MinIO client; each real socket has an absolute and an idle deadline. */
export function snapshotRecoveryStore(configuration,{checkDeadline=()=>120000}={}){
 const {Client}=require('minio'),url=new URL(configuration.endpoint),transport=url.protocol==='https:'?https:http;
 const request=(...args)=>{const outgoing=transport.request(...args),deadline=setTimeout(()=>outgoing.destroy(new Error('snapshot-recovery-s3-deadline')),Math.min(120000,checkDeadline()));deadline.unref();outgoing.setTimeout(30000,()=>outgoing.destroy(new Error('snapshot-recovery-s3-idle')));outgoing.once('close',()=>clearTimeout(deadline));return outgoing;};
 return new Client({endPoint:url.hostname,port:Number(url.port)||(url.protocol==='https:'?443:80),useSSL:url.protocol==='https:',accessKey:configuration.accessKey,secretKey:configuration.secretKey,region:configuration.region,transport:{request},retryOptions:{disableRetry:true}});
}
async function verifyStream(stream,row,{destination,checkDeadline=()=>{}}={}){
 let received=0;const digest=createHash('sha256');let file;const timer=setTimeout(()=>stream.destroy(new Error('Истёк срок передачи объекта снимка.')),120000);timer.unref();
 try{if(destination)file=await open(destination,'wx',0o600);for await(const chunk of stream){checkDeadline();received+=chunk.length;if(received>row.bytes)throw new Error('Объект снимка превышает опись.');digest.update(chunk);if(file)await file.writeFile(chunk);}
  if(received!==row.bytes||digest.digest('hex')!==row.sha256)throw new Error('SHA256 или размер объекта снимка не совпал.');if(file)await file.sync();
 }catch(error){if(file)await rm(destination,{force:true});throw error;}finally{clearTimeout(timer);stream.destroy();await file?.close();}
}
async function checkLocal(filename,row){const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==row.bytes)throw new Error('В копии нет exact bytes блока снимка.');}finally{await file.close();}if(await digestFile(filename)!==row.sha256)throw new Error('SHA256 локального блока снимка не совпал.');}
async function assertTargetObjects(store,target,expected){
 const remaining=new Set(expected.map(row=>snapshotObjectKey(row.projectId,row.sha256)+'\0'+row.versionId)),stream=store.listObjects(target.bucket,'',true,{IncludeVersion:true}),timer=setTimeout(()=>stream.destroy(new Error('Истёк срок проверки target bucket.')),120000);timer.unref();let count=0;
 try{for await(const item of stream){if(++count>100000||item.isDeleteMarker||!remaining.delete(item.name+'\0'+item.versionId))throw new Error('Target bucket содержит посторонние объекты или версии.');}if(remaining.size)throw new Error('В target bucket отсутствуют проверенные версии объектов.');}finally{clearTimeout(timer);stream.destroy();}
}

/** Must run while the full-backup lifecycle lock is held and applications are quiesced. */
export async function exportSnapshotRecovery({directory,destination,sql,checkDeadline=()=>120000,storeFactory=snapshotRecoveryStore}){
 const configuration=await snapshotRecoveryConfiguration(directory),rows=await readSnapshotBlobs(sql),signatures=await readSnapshotSignatures(sql),keyFiles=await exportSnapshotKeys(destination,configuration,signatures);let store;
 if(rows.some(row=>row.storageId.startsWith('s3:'))){if(!configuration.source)throw new Error('S3 снимки требуют source в закрытой snapshot-recovery.json.');store=storeFactory(configuration.source,{checkDeadline});if((await store.getBucketVersioning(configuration.source.bucket)).Status!=='Enabled')throw new Error('Source bucket снимков требует включённый versioning.');}
 const blobs=[];for(const row of rows){checkDeadline();const remote=row.storageId.startsWith('s3:'),file=remote?snapshotObjectFile(row.projectId,row.sha256):snapshotLocalFile(row.projectId,row.sha256),filename=path.join(destination,file);
  if(remote){if(row.storageId!==configuration.source.storageId)throw new Error('S3 storage identity в SQL не соответствует source конфигурации.');await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await verifyStream(await store.getObject(configuration.source.bucket,snapshotObjectKey(row.projectId,row.sha256),{versionId:row.versionId}),row,{destination:filename,checkDeadline});}
  else await checkLocal(filename,row);blobs.push({...row,file});
 }return {schemaVersion:1,blobs,...(keyFiles.length?{keyFiles}:{})};
}
/** A partial SQL-only historical bundle cannot be advertised as a full restore. */
export async function previewSnapshotRecovery({directory,source,manifest,metadata,applicationS3=false,storeFactory=snapshotRecoveryStore}){
 const declared=manifest.snapshotObjects?.blobs?.map(({file,...row})=>row)||[];
 if(!isDeepStrictEqual(snapshotBlobs(declared),metadata.blobs))throw new Error('Опись snapshot objects не соответствует точным ссылкам SQL-дампа.');
 await verifyBundleSnapshotKeys(source,manifest.snapshotObjects,metadata.signatures);
 const configuration=await snapshotRecoveryConfiguration(directory),hasS3=metadata.blobs.some(row=>row.storageId.startsWith('s3:'));
 if((hasS3||configuration.source||applicationS3)&&!configuration.target)throw new Error('Для S3 снимков нужен новый target bucket в закрытой snapshot-recovery.json.');
 if(configuration.target){if(metadata.blobs.some(row=>row.storageId===configuration.target.storageId)||configuration.source?.storageId===configuration.target.storageId)throw new Error('Новый target bucket должен иметь другую storage identity.');
  const store=storeFactory(configuration.target);if(await store.bucketExists(configuration.target.bucket))throw new Error('Target bucket восстановления уже существует. Нужен новый пустой bucket.');}
 return {configuration,blobs:manifest.snapshotObjects?.blobs||[],signatures:metadata.signatures};
}
/** Uploads only into a newly created target, verifies every returned version, then CAS-remaps target SQL. */
export async function restoreSnapshotRecovery({source,preview,sql,beforeMutation=async()=>{},storeFactory=snapshotRecoveryStore}){
 const target=preview.configuration.target,blobs=preview.blobs;if(!target)return {objects:0};
 const store=storeFactory(target);if(await store.bucketExists(target.bucket))throw new Error('Target bucket восстановления уже существует.');await beforeMutation();await store.makeBucket(target.bucket,target.region);await beforeMutation();await store.setBucketVersioning(target.bucket,{Status:'Enabled'});
 if((await store.getBucketVersioning(target.bucket)).Status!=='Enabled')throw new Error('Target bucket не подтвердил versioning.');const remapped=[];
 await assertTargetObjects(store,target,[]);
 for(const row of blobs){await beforeMutation();const filename=path.join(source,row.file);await checkLocal(filename,row);const input=createReadStream(filename);let result;
  try{result=await store.putObject(target.bucket,snapshotObjectKey(row.projectId,row.sha256),input,row.bytes,{'Content-Type':'application/octet-stream'});}finally{input.destroy();}
  const versionId=result.versionId;if(typeof versionId!=='string'||!versionId||versionId==='null'||/[\x00-\x1f\x7f]/.test(versionId))throw new Error('S3 не подтвердил точную target version.');
  await verifyStream(await store.getObject(target.bucket,snapshotObjectKey(row.projectId,row.sha256),{versionId}),row);await checkLocal(filename,row);remapped.push({...row,storageId:target.storageId,versionId});
 }
 await assertTargetObjects(store,target,remapped);
 await beforeMutation();const statements=['BEGIN;'];for(let index=0;index<blobs.length;index++){const old=blobs[index],next=remapped[index];statements.push(`WITH updated AS (UPDATE project_snapshot_blobs SET storage_id=${quote(next.storageId)},version_id=${quote(next.versionId)} WHERE project_id=${quote(old.projectId)} AND sha256=${quote(old.sha256)} AND bytes=${old.bytes} AND storage_id=${quote(old.storageId)} AND version_id IS NOT DISTINCT FROM ${old.versionId===null?'NULL':quote(old.versionId)} RETURNING 1) SELECT 1/count(*) FROM updated;`);}statements.push('COMMIT;');await sql('catalog',statements.join('\n'));
 const actual=await readSnapshotBlobs(sql);if(!isDeepStrictEqual(actual,snapshotBlobs(remapped.map(({file,...row})=>row))))throw new Error('Опись восстановленных S3 объектов не соответствует target SQL.');
 return {objects:remapped.length,storageId:target.storageId,versions:remapped.map(({file,...row})=>row)};
}
/** Private target overlay refers only to restored identity bytes and copied operator target credentials. */
export async function snapshotTargetOverlay(directory,projectName,source,preview){
 const hasSigning=await lstat(path.join(source,'operatorsecrets/snapshot_signing_key')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
 if(!preview.configuration.target&&!hasSigning)return undefined;
 const destination=path.join(directory,'recovery-receipts',projectName+'-snapshot-config');await mkdir(destination,{mode:0o700});const secrets={},environment={};
 for(const [key,name]of [['SNAPSHOT_SIGNING_KEY_FILE','snapshot_signing_key'],['SNAPSHOT_TRUSTED_KEYS_FILE','snapshot_trusted_keys.json']]){const filename=path.join(source,'operatorsecrets',name);let bytes;try{bytes=await privateRecoveryFile(filename,name==='snapshot_signing_key'?8192:65536);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  await writeFile(path.join(destination,name),bytes,{flag:'wx',mode:0o600,flush:true});const id=name==='snapshot_trusted_keys.json'?'snapshot_trusted_keys':name;secrets[id]={file:path.join(destination,name)};environment[key]='/run/secrets/'+id;}
 if(preview.configuration.target){const target=preview.configuration.target;Object.assign(environment,{SNAPSHOT_S3_ENDPOINT:target.endpoint,SNAPSHOT_S3_BUCKET:target.bucket,SNAPSHOT_S3_REGION:target.region});for(const [key,name,value]of [['SNAPSHOT_S3_ACCESS_KEY_FILE','snapshot_s3_access_key',target.accessKey],['SNAPSHOT_S3_SECRET_KEY_FILE','snapshot_s3_secret_key',target.secretKey]]){await writeFile(path.join(destination,name),value+'\n',{flag:'wx',mode:0o600,flush:true});secrets[name]={file:path.join(destination,name)};environment[key]='/run/secrets/'+name;}}
 const overlay={services:{'catalog-service':{environment,secrets:Object.keys(secrets)}},secrets},filename=path.join(destination,'compose.json');await writeFile(filename,JSON.stringify(overlay,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});return filename;
}
