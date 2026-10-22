import {test} from 'node:test';
import http from 'node:http';
import {snapshotRecoveryStore} from '../production/snapshot-recovery-storage.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,mkdir,chmod,symlink,readFile,rm} from 'node:fs/promises';
import {chatRecoveryConfiguration,chatRecoveryFingerprint,chatRecoveryHash} from '../production/chat-recovery-config.mjs';
import {chatMetadata,validateChatInventory,chatObjectFile} from '../production/chat-recovery-metadata.mjs';
import {readChatCopy,dumpChatMetadata} from '../production/chat-recovery-dump.mjs';
import {writeManifest,verifyBackup,validateManifest} from '../production/recovery-manifest.mjs';
import {applicationServices} from '../production/compose-client.mjs';
import {restoreRunnerConfiguration} from '../production/web-restore-runner.mjs';
import {temporary,configuration,rows,metadata,payload,ids} from './chat-recovery.fixture.mjs';

const empty={objects:[],discardedObjects:[],transfers:[]};
async function configured(root){await configuration(root,'https://s3.example.test');return chatRecoveryConfiguration(root);}
const inventory=(raw,source)=>({schemaVersion:1,source:{storageId:source.storageId,projectBucket:source.projectBucket,personalBucket:source.personalBucket},...metadata(raw),objects:metadata(raw).objects.map(row=>({...row,file:chatObjectFile(row.id)}))});
const entries=value=>[{path:'chat-objects',type:'directory',mode:0o700},...value.objects.map(row=>({path:row.file,type:'file',mode:0o600,size:row.bytes,sha256:row.sha256}))];
test('Chat metadata retains project and personal ownership, exact null version, active and deleted transfer bytes',async()=>temporary(async root=>{
 const c=await configured(root),raw=rows(c.source),result=metadata(raw);assert.equal(result.objects.length,2);assert.equal(result.objects[1].versionId,null);assert.deepEqual(result.transfers.map(row=>row.deleted),[false,true]);assert.deepEqual(result.discardedObjects.map(row=>row.state),['STAGING','DELETE']);const value=inventory(raw,c.source);assert.equal(validateChatInventory(value,entries(value)),value);
}));
test('Foreign owner/project namespace, orphan LIVE and duplicate object reference fail admission',async()=>temporary(async root=>{
 const c=await configured(root);for(const change of [raw=>raw.conversations[0].ownerEmail='foreign@test',raw=>raw.conversations[0].projectId='foreign-project',raw=>raw.attachments.shift(),raw=>raw.attachments.push({...raw.attachments[0],id:ids[10]})]){const raw=rows(c.source);change(raw);assert.throws(()=>metadata(raw));}
}));
test('Discarded intents must have valid core identity and cannot discard LIVE; transfer SHA/content cannot drift',async()=>temporary(async root=>{
 const c=await configured(root);for(const change of [raw=>raw.objects[2].bucket='bad..bucket',raw=>raw.objects[2].objectKey=raw.objects[2].objectKey.replace(ids[4],'-'.repeat(36)),raw=>raw.objects[2].state='LIVE',raw=>raw.transfers[0].contentSha256='b'.repeat(64),raw=>raw.transfers[0].contentBytes++,raw=>raw.attachments[0].deletedAt=undefined]){const raw=rows(c.source);change(raw);assert.throws(()=>metadata(raw));}
}));
test('Manifest rejects missing/corrupt/private-mode/extra bytes and foreign storage identity before writes',async()=>temporary(async root=>{
 const c=await configured(root),value=inventory(rows(c.source),c.source);for(const mutate of [e=>e.pop(),e=>e[1].mode=0o644,e=>e[1].sha256='0'.repeat(64),e=>e.push({...e[1],path:'chat-objects/extra.blob'})]){const e=entries(value);mutate(e);assert.throws(()=>validateChatInventory(value,e));}
 assert.throws(()=>validateChatInventory({...value,source:{...value.source,storageId:'f'.repeat(64)}},entries(value)),/foreign/);
}));
test('Private config validates both bucket names and HTTPS/loopback; public/linked credentials are refused',async()=>temporary(async root=>{
 const raw=await configuration(root,'https://s3.example.test');for(const change of [{projectBucket:'bad..bucket'},{personalBucket:raw.source.projectBucket},{endpoint:'http://remote.example.test'},{endpoint:'https://s3.example.test/path'},{endpoint:'https://s3.example.test?host=foreign'}]){await writeFile(path.join(root,'chat-recovery.json'),JSON.stringify({source:{...raw.source,...change}}));await assert.rejects(chatRecoveryConfiguration(root));}
 await writeFile(path.join(root,'chat-recovery.json'),JSON.stringify(raw));await chmod(path.join(root,'secret'),0o644);await assert.rejects(chatRecoveryConfiguration(root));await chmod(path.join(root,'secret'),0o600);await rm(path.join(root,'secret'));await symlink(path.join(root,'access'),path.join(root,'secret'));await assert.rejects(chatRecoveryConfiguration(root),/ссылкой/);
}));
test('Restore approval digest changes for source, target and target credential edits including initially absent config',async()=>temporary(async root=>{
 await mkdir(path.join(root,'secrets'),{mode:0o700});await writeFile(path.join(root,'.env'),'MODE=production\n',{mode:0o600});await writeFile(path.join(root,'secrets/model_credential_key'),'owned-key',{mode:0o600});const copies=path.join(root,'copies');await mkdir(copies,{mode:0o700});const current=()=>restoreRunnerConfiguration({directory:root,backupRoot:copies});const before=await current();const raw=await configuration(root,'https://s3.example.test');let old=(await current()).configDigest;assert.notEqual(old,before.configDigest);
 for(const mutate of [()=>{raw.source.projectBucket='source-revised';},()=>{raw.target.personalBucket='target-revised';}]){mutate();await writeFile(path.join(root,'chat-recovery.json'),JSON.stringify(raw));const next=(await current()).configDigest;assert.notEqual(next,old);old=next;}
 const fingerprint=await chatRecoveryFingerprint(root);await writeFile(path.join(root,'secret'),'rotated-key');assert.notDeepEqual(await chatRecoveryFingerprint(root),fingerprint);assert.notEqual((await current()).configDigest,old);
}));
const copy=(table,columns,values)=>'-- Data for Name: '+table+';\nCOPY public.'+table+' ('+columns.join(', ')+') FROM stdin;\n'+values.map(row=>row.join('\t')).join('\n')+'\n\\.\n';
test('Fixed COPY parser retains escaped owner, exact null version and rejects truncation/INSERT/unknown storage schema',async()=>temporary(async root=>{
 const file=path.join(root,'copy');await writeFile(file,copy('model_chat_conversations',['id','owner_email','project_id'],[[ids[4],'owner\\tquoted@example','\\N']]));assert.deepEqual(await readChatCopy(file,'model_chat_conversations'),[{id:ids[4],ownerEmail:'owner\tquoted@example',projectId:null}]);
 for(const value of [copy('model_chat_conversations',['id','owner_email','project_id'],[[ids[4],'owner','\\N']]).replace('\\.\n',''),'INSERT INTO public.model_chat_conversations VALUES (1);\n',copy('model_chat_attachments',['id','conversation_id','bytes','deleted_at','object_id'],[[ids[2],ids[4],'3','\\N','\\N']])]){await writeFile(file,value);await assert.rejects(readChatCopy(file,value.includes('attachments')?'model_chat_attachments':'model_chat_conversations'));}
}));
test('Legacy bytea originals and deleted TRANSFER bodies remain in DB; transfer corruption fails readonly COPY',async()=>temporary(async root=>{
 const file=path.join(root,'copy'),bytes='\\\\x'+payload.toString('hex');await writeFile(file,copy('model_chat_attachments',['id','conversation_id','bytes','deleted_at','content'],[[ids[2],ids[4],String(payload.length),'\\N',bytes]]));const result=await readChatCopy(file,'model_chat_attachments');assert.equal(result[0].storageState,'LEGACY');
 await writeFile(file,copy('model_chat_attachment_transfers',['attachment_id','content','sha256','bytes'],[[ids[2],bytes,chatRecoveryHash(payload),String(payload.length)]]));assert.equal((await readChatCopy(file,'model_chat_attachment_transfers'))[0].contentSha256,chatRecoveryHash(payload));
 await writeFile(file,copy('model_chat_attachment_transfers',['attachment_id','content','sha256','bytes'],[[ids[2],bytes,chatRecoveryHash(payload),String(payload.length+1)]]));await assert.rejects(readChatCopy(file,'model_chat_attachment_transfers'),/bytea/);
}));
test('Dump admission executes only four readonly fixed-table extractors; changed dump fails before extraction',async()=>temporary(async root=>{
 await mkdir(path.join(root,'databases'));const file=path.join(root,'databases/catalog.dump');await writeFile(file,'owned dump');const manifest={postgresImage:'sha256:'+'a'.repeat(64),entries:[{path:'databases/catalog.dump',sha256:chatRecoveryHash('owned dump')}]},calls=[];
 const result=await dumpChatMetadata(root,manifest,async(args,options)=>{calls.push(args);assert.ok(args.includes('--read-only'));assert.ok(args.includes('none'));assert.ok(args.includes('pg_restore'));assert.ok(args.some(arg=>arg.startsWith('--table=model_chat_')));await writeFile(options.outputFile,'-- absent table\n');});assert.deepEqual(result,empty);assert.equal(calls.length,4);await writeFile(file,'changed');await assert.rejects(dumpChatMetadata(root,manifest,()=>{throw Error('must not extract');}),/изменился/);
}));
test('V4 writes and verifies both chat originals; trusted-SHA legacy v1-v3 without chat references remain valid',async()=>temporary(async root=>{
 const c=await configured(root),value=inventory(rows(c.source),c.source),destination=path.join(root,'backup');await mkdir(path.join(destination,'databases'),{recursive:true,mode:0o700});for(const db of ['catalog','rag'])await writeFile(path.join(destination,'databases',db+'.dump'),'dump',{mode:0o600});for(const key of ['skills','projects','backups','runtime-artifacts'])await mkdir(path.join(destination,'files',key),{recursive:true,mode:0o700});await mkdir(path.join(destination,'chat-objects'),{mode:0o700});for(const row of value.objects)await writeFile(path.join(destination,row.file),payload,{mode:0o600});
 const image='sha256:'+'a'.repeat(64),base={createdAt:new Date().toISOString(),postgresMajor:16,postgresImage:image,quiesced:true,images:Object.fromEntries(applicationServices.map(name=>[name,image])),databases:['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C',ctype:'C',file:'databases/'+name+'.dump'})),chatObjects:value};const receipt=await writeManifest(destination,base);assert.equal(receipt.manifest.format,'neurocenter-recovery-v4');await verifyBackup(destination,receipt.sha256);
 for(const format of ['neurocenter-recovery-v1','neurocenter-recovery-v2','neurocenter-recovery-v3']){const historical={...receipt.manifest,format,entries:receipt.manifest.entries.filter(e=>!e.path.startsWith('chat-objects')&&(format!=='neurocenter-recovery-v1'||!e.path.startsWith('files/runtime-artifacts')))};delete historical.chatObjects;assert.equal(validateManifest(historical),historical);}
 await writeFile(path.join(destination,value.objects[0].file),Buffer.alloc(payload.length));await assert.rejects(verifyBackup(destination,receipt.sha256),/описи/);
}));

test('Recovery MinIO constructor normalizes IPv6 brackets and IPv4 without opening any socket',t=>{
 let requests=0;t.mock.method(http,'request',()=>{requests++;throw Error('constructor must not request');});for(const endpoint of ['http://[::1]:12345','http://127.0.0.1:12345']){const store=snapshotRecoveryStore({endpoint,region:'us-east-1',accessKey:'test-access',secretKey:'test-secret'});assert.equal(store.host,new URL(endpoint).hostname.replace(/^\[|\]$/g,''));assert.equal(store.port,12345);}assert.equal(requests,0);
});
