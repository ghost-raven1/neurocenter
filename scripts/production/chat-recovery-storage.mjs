import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {chatRecoveryConfiguration,chatRecoveryHash} from './chat-recovery-config.mjs';
import {privateRecoveryFile} from './snapshot-recovery-config.mjs';
import {snapshotRecoveryStore} from './snapshot-recovery-storage.mjs';
import {readChatMetadata,chatObjectFile,validateChatInventory} from './chat-recovery-metadata.mjs';
import {assertPrivateS3Bucket} from '../../services/shared/s3-bucket-privacy.cjs';

const quote=value=>"'"+value.replace(/'/g,"''")+"'",literal=value=>value===null?'NULL':quote(value);
const buckets=value=>[value.projectBucket,value.personalBucket];
const descriptor=value=>value?{storageId:value.storageId,projectBucket:value.projectBucket,personalBucket:value.personalBucket}:null;
const bucketFor=(configuration,row)=>row.objectKey.startsWith('projects/')?configuration.projectBucket:configuration.personalBucket;
function runtimeIdentity(environment){if(!environment||typeof environment!=='object'||!environment.CHAT_S3_ENDPOINT)return null;const url=new URL(environment.CHAT_S3_ENDPOINT);if(!environment.CHAT_S3_PROJECT_BUCKET||!environment.CHAT_S3_PERSONAL_BUCKET)throw Error('Runtime chat S3 identity не заполнена.');return chatRecoveryHash(JSON.stringify([url.origin,environment.CHAT_S3_PROJECT_BUCKET,environment.CHAT_S3_PERSONAL_BUCKET]));}
function configured(rows,configuration){for(const row of rows)if(!configuration||row.storageId!==configuration.storageId||row.bucket!==bucketFor(configuration,row))throw Error('SQL содержит foreign chat storage identity.');}
async function localBytes(source,row){const bytes=await privateRecoveryFile(path.join(source,row.file),10*1024**2);if(bytes.length!==row.bytes||chatRecoveryHash(bytes)!==row.sha256)throw Error('Не совпали exact bytes/SHA оригинала чата.');return bytes;}
async function privateBuckets(store,configuration){for(const bucket of buckets(configuration))await assertPrivateS3Bucket(store,bucket);}
const deadline=(check,maximum)=>{const remaining=check();if(!Number.isFinite(remaining)||remaining<=0)throw Error('Истёк срок chat recovery.');return Math.max(1,Math.floor(Math.min(maximum,remaining)));};
async function anonymousDenied(configuration,row,request,checkDeadline=()=>120000){const url=new URL('/'+bucketFor(configuration,row)+'/'+row.objectKey,configuration.endpoint);url.searchParams.set('versionId',row.versionId??'null');const response=await request(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(deadline(checkDeadline,15000))});await response.body?.cancel();checkDeadline();if(![401,403,404].includes(response.status))throw Error('Оригинал чата доступен анонимно.');}
async function objectBytes(store,bucket,row,{checkDeadline=()=>120000}={}){
    checkDeadline();const stream=await store.getObject(bucket,row.objectKey,{versionId:row.versionId??'null'}),chunks=[];let timer,bytes=0;
    try{timer=setTimeout(()=>stream.destroy(Error('Chat recovery object timeout.')),deadline(checkDeadline,120000));timer.unref();const version=stream.headers?.['x-amz-version-id'];if(row.versionId===null?version!==undefined&&version!=='null':version!==row.versionId)throw Error('S3 вернул другую exact chat version.');
        for await(const part of stream){checkDeadline();const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>row.bytes)throw Error('Chat S3 object превышает опись.');chunks.push(chunk);}
        const result=Buffer.concat(chunks);if(result.length!==row.bytes||chatRecoveryHash(result)!==row.sha256)throw Error('Chat S3 object не совпадает с bytes/SHA.');return result;
    }finally{clearTimeout(timer);stream.destroy();}
}
async function exactTargetVersions(store,configuration,rows){
    for(const bucket of buckets(configuration)){const remaining=new Set(rows.filter(row=>row.bucket===bucket).map(row=>row.objectKey+'\0'+row.versionId)),stream=store.listObjects(bucket,'',true,{IncludeVersion:true});const timer=setTimeout(()=>stream.destroy(Error('Chat target inventory timeout.')),120000);timer.unref();let count=0;
        try{for await(const item of stream)if(++count>100000||item.isDeleteMarker||!remaining.delete(item.name+'\0'+item.versionId))throw Error('Chat target содержит посторонние объекты или версии.');if(remaining.size)throw Error('Chat target не содержит все проверенные версии.');}
        finally{clearTimeout(timer);stream.destroy();}
    }
}
/** Export only referenced originals; cleanup intents and legacy bytea stay explicit in the verified manifest. */
export async function exportChatRecovery({directory,destination,sql,applicationS3=false,checkDeadline=()=>120000,storeFactory=snapshotRecoveryStore,request=fetch}){
    const configuration=await chatRecoveryConfiguration(directory),metadata=await readChatMetadata(sql),source=configuration.source,runtime=runtimeIdentity(applicationS3);
    if((applicationS3||metadata.objects.length||metadata.discardedObjects.length)&&!source)throw Error('Для chat S3 нужна закрытая source конфигурация chat-recovery.json.');
    if(runtime&&runtime!==source?.storageId)throw Error('Source chat recovery не соответствует runtime storage identity.');configured([...metadata.objects,...metadata.discardedObjects],source);
    const store=source&&storeFactory(source,{checkDeadline});if(store){for(const bucket of buckets(source))if(!await store.bucketExists(bucket))throw Error('Исходный chat bucket отсутствует.');await privateBuckets(store,source);}
    const objects=[];for(const row of metadata.objects){checkDeadline();await privateBuckets(store,source);const bytes=await objectBytes(store,row.bucket,row,{checkDeadline});await anonymousDenied(source,row,request,checkDeadline);const file=chatObjectFile(row.id);await mkdir(path.dirname(path.join(destination,file)),{recursive:true,mode:0o700});await writeFile(path.join(destination,file),bytes,{flag:'wx',mode:0o600,flush:true});objects.push({...row,file});}
    return{schemaVersion:1,source:descriptor(source),objects,discardedObjects:metadata.discardedObjects,transfers:metadata.transfers};
}
/** No target mutations occur until SQL ownership, all local bytes and both brand-new buckets pass admission. */
export async function previewChatRecovery({directory,source,manifest,metadata,applicationS3=false,storeFactory=snapshotRecoveryStore}){
    const configuration=await chatRecoveryConfiguration(directory),runtime=runtimeIdentity(applicationS3),current=manifest.format==='neurocenter-recovery-v4';
    let objects=[];if(current){validateChatInventory(manifest.chatObjects,manifest.entries);objects=manifest.chatObjects.objects;const declared={objects:objects.map(({file,...row})=>row),discardedObjects:manifest.chatObjects.discardedObjects,transfers:manifest.chatObjects.transfers};if(!isDeepStrictEqual(declared,metadata))throw Error('Chat inventory не соответствует точным owner/bytes/versions SQL-дампа.');
        if(configuration.source&&!isDeepStrictEqual(descriptor(configuration.source),manifest.chatObjects.source))throw Error('Source chat recovery identity изменилась.');
    }else if(metadata.objects.length)throw Error('Исторический recovery bundle не содержит LIVE S3 оригиналы чата. Нужна новая полная копия.');
    for(const row of objects)await localBytes(source,row);
    const target=configuration.target,requiresTarget=!!(applicationS3||configuration.source||metadata.objects.length||metadata.discardedObjects.length||metadata.transfers.length||current&&manifest.chatObjects.source);
    if(requiresTarget&&!target)throw Error('Для восстановления чата нужны два новых target bucket в chat-recovery.json.');
    if(target){if(target.storageId===runtime||target.storageId===configuration.source?.storageId||[...metadata.objects,...metadata.discardedObjects].some(row=>row.storageId===target.storageId)||current&&manifest.chatObjects.source?.storageId===target.storageId)throw Error('Chat target должен иметь новую storage identity.');
        const store=storeFactory(target);for(const bucket of buckets(target))if(await store.bucketExists(bucket))throw Error('Chat target bucket уже существует: восстановление требует два новых бакета.');
    }return{configuration,objects,metadata};
}
const identityWhere=row=>`id=${quote(row.id)} AND storage_id=${quote(row.storageId)} AND bucket=${quote(row.bucket)} AND object_key=${quote(row.objectKey)} AND version_id IS NOT DISTINCT FROM ${literal(row.versionId)} AND sha256=${quote(row.sha256)} AND bytes=${row.bytes} AND state=${quote(row.state)}`;
const attachmentWhere=row=>`a.id=${quote(row.attachmentId)} AND a.conversation_id=${quote(row.conversationId)} AND a.bytes=${row.bytes} AND c.owner_email=${quote(row.ownerEmail)} AND c.project_id IS NOT DISTINCT FROM ${literal(row.projectId)}`;
/** A partial/unknown attempt is never replayed into existing buckets and never mutates source S3. */
export async function restoreChatRecovery({source,preview,sql,beforeMutation=async()=>{},storeFactory=snapshotRecoveryStore,request=fetch}){
    const target=preview.configuration.target,metadata=preview.metadata;if(!target)return{objects:0,discardedIntents:0,retainedLegacyTransfers:metadata.transfers.length};
    const receipt={schemaVersion:1,state:'failed',phase:'preflight',storageId:target.storageId,createdBuckets:[],attemptedBuckets:[],attemptedObjects:[],verifiedVersions:[],discardedIntents:0,discardReason:'unreferenced source-only STAGING/DELETE/DELETED intents in restored SQL',retainedLegacyTransfers:metadata.transfers.length,retainedDeletedTransfers:metadata.transfers.filter(row=>row.deleted).length,sourceS3Mutated:false,sqlOutcome:'not-started'};
    try{
        if(!isDeepStrictEqual(await readChatMetadata(sql),metadata))throw Error('Восстановленный SQL chat metadata не совпадает с допущенным дампом.');
        for(const row of preview.objects)await localBytes(source,row);const store=storeFactory(target);for(const bucket of buckets(target))if(await store.bucketExists(bucket))throw Error('Chat target bucket уже существует. Повтор требует нового target.');
        for(const bucket of buckets(target)){if(await store.bucketExists(bucket))throw Error('Chat target bucket появился до создания.');await beforeMutation();receipt.phase='create-bucket';receipt.attemptedBuckets.push(bucket);await store.makeBucket(bucket,target.region);receipt.createdBuckets.push(bucket);await beforeMutation();await store.setBucketVersioning(bucket,{Status:'Enabled'});if((await store.getBucketVersioning(bucket)).Status!=='Enabled')throw Error('Chat target не подтвердил versioning.');await assertPrivateS3Bucket(store,bucket);}
        await exactTargetVersions(store,target,[]);const remapped=[];
        for(const row of preview.objects){const bytes=await localBytes(source,row);await privateBuckets(store,target);await beforeMutation();receipt.phase='put-object';const bucket=bucketFor(target,row);receipt.attemptedObjects.push({id:row.id,bucket,objectKey:row.objectKey,sha256:row.sha256,bytes:row.bytes});const result=await store.putObject(bucket,row.objectKey,bytes,bytes.length,{'Content-Type':'application/octet-stream','X-Amz-Meta-Neurocenter-Sha256':row.sha256}),versionId=result.versionId;
            if(typeof versionId!=='string'||!versionId||versionId==='null'||versionId.length>1024||/[\x00-\x1f\x7f]/.test(versionId))throw Error('Chat S3 PUT не подтвердил точную новую version.');
            const next={...row,storageId:target.storageId,bucket,versionId};await objectBytes(store,bucket,next);await anonymousDenied(target,next,request);remapped.push(next);receipt.verifiedVersions.push({id:row.id,bucket,versionId,sha256:row.sha256,bytes:row.bytes});
        }
        await privateBuckets(store,target);await exactTargetVersions(store,target,remapped);await privateBuckets(store,target);await beforeMutation();receipt.phase='sql-publication';
        const statements=['BEGIN;',`SELECT 1/CASE WHEN (SELECT count(*) FROM model_chat_objects)=${metadata.objects.length+metadata.discardedObjects.length} THEN 1 ELSE 0 END;`];
        for(let index=0;index<metadata.objects.length;index++){const old=metadata.objects[index],next=remapped[index];statements.push(`WITH updated AS (UPDATE model_chat_objects SET storage_id=${quote(next.storageId)},bucket=${quote(next.bucket)},version_id=${quote(next.versionId)} WHERE ${identityWhere(old)} AND EXISTS(SELECT 1 FROM model_chat_attachments a JOIN model_chat_conversations c ON c.id=a.conversation_id WHERE ${attachmentWhere(old)} AND a.object_id=model_chat_objects.id AND a.storage_state='S3' AND a.deleted_at IS NULL) RETURNING 1) SELECT 1/count(*) FROM updated;`);}
        for(const row of metadata.discardedObjects)statements.push(`WITH removed AS (DELETE FROM model_chat_objects WHERE ${identityWhere(row)} AND NOT EXISTS(SELECT 1 FROM model_chat_attachments WHERE object_id=model_chat_objects.id) RETURNING 1) SELECT 1/count(*) FROM removed;`);
        for(const row of metadata.transfers)statements.push(`SELECT 1/count(*) FROM model_chat_attachment_transfers t JOIN model_chat_attachments a ON a.id=t.attachment_id JOIN model_chat_conversations c ON c.id=a.conversation_id WHERE ${attachmentWhere(row)} AND t.sha256=${quote(row.sha256)} AND t.bytes=${row.bytes} AND encode(sha256(t.content),'hex')=${quote(row.sha256)} AND octet_length(t.content)=${row.bytes} AND a.object_id IS NULL AND a.storage_state=${quote(row.deleted?'DELETED':'TRANSFER')} AND a.deleted_at IS ${row.deleted?'NOT ':''}NULL;`);
        statements.push('COMMIT;');if(metadata.objects.length||metadata.discardedObjects.length||metadata.transfers.length){receipt.sqlOutcome='unknown';await sql('catalog',statements.join('\n'));receipt.sqlOutcome='committed';}
        const expected={objects:remapped.map(({file,...row})=>row),discardedObjects:[],transfers:metadata.transfers};if(!isDeepStrictEqual(await readChatMetadata(sql),expected))throw Error('Опись chat storage после восстановления не соответствует проверенным target versions.');
        receipt.state='completed';receipt.phase='verified';receipt.discardedIntents=metadata.discardedObjects.length;return{...receipt,objects:remapped.length};
    }catch(error){const failure=error instanceof Error?error:new Error(String(error));Object.defineProperty(failure,'chatRecoveryReceipt',{value:receipt});throw failure;}
}
/** Only the new target credentials and identities reach Catalog; source secrets never enter the bundle. */
export async function chatTargetOverlay(directory,projectName,preview){
    const target=preview.configuration.target;if(!target)return undefined;const destination=path.join(directory,'recovery-receipts',projectName+'-chat-config');await mkdir(destination,{mode:0o700});const secrets={};
    const environment={CHAT_S3_ENDPOINT:target.endpoint,CHAT_S3_REGION:target.region,CHAT_S3_PROJECT_BUCKET:target.projectBucket,CHAT_S3_PERSONAL_BUCKET:target.personalBucket,CHAT_S3_ACCESS_KEY:'',CHAT_S3_SECRET_KEY:''};
    for(const[name,value]of[['chat_s3_access_key',target.accessKey],['chat_s3_secret_key',target.secretKey]]){const file=path.join(destination,name);await writeFile(file,value+'\n',{flag:'wx',mode:0o600,flush:true});secrets[name]={file};environment[name==='chat_s3_access_key'?'CHAT_S3_ACCESS_KEY_FILE':'CHAT_S3_SECRET_KEY_FILE']='/run/secrets/'+name;}
    const filename=path.join(destination,'compose.json');await writeFile(filename,JSON.stringify({services:{'catalog-service':{environment,secrets:Object.keys(secrets)}},secrets},null,2)+'\n',{flag:'wx',mode:0o600,flush:true});return filename;
}
