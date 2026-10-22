import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest} from '../production/recovery-manifest.mjs';
import {applicationServices} from '../production/compose-client.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {snapshotBlob,snapshotBlobs,snapshotObjectFile,assertSnapshotReferences,readSnapshotBlobs} from '../production/snapshot-recovery-metadata.mjs';
import {readSnapshotCopy} from '../production/snapshot-recovery-dump.mjs';
import {snapshotRecoveryConfiguration,snapshotRecoveryFingerprint} from '../production/snapshot-recovery-config.mjs';
import {exportSnapshotKeys,snapshotKeyMaterial,verifyBundleSnapshotKeys} from '../production/snapshot-recovery-keys.mjs';
import {previewSnapshotRecovery,exportSnapshotRecovery,restoreSnapshotRecovery} from '../production/snapshot-recovery-storage.mjs';
import {s3Fixture} from './chat-recovery.fixture.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
const sha='a'.repeat(64),image='sha256:'+sha;
const manifest=()=>({format:'neurocenter-recovery-v3',createdAt:new Date().toISOString(),postgresMajor:16,postgresImage:image,quiesced:true,images:Object.fromEntries(applicationServices.map(service=>[service,image])),databases:['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C',ctype:'C',file:'databases/'+name+'.dump'})),entries:[{path:'databases',type:'directory',mode:448},...['catalog','rag'].map(name=>({path:'databases/'+name+'.dump',type:'file',mode:384,size:10,sha256:sha})),{path:'files',type:'directory',mode:448},...['skills','projects','backups','runtime-artifacts'].map(name=>({path:'files/'+name,type:'directory',mode:448}))],snapshotObjects:{schemaVersion:1,blobs:[]}});
test('Recovery-v3 accepts an exact snapshot object inventory rather than silently restoring SQL without bytes',()=>{const value=manifest();assert.equal(validateManifest(value),value);});
const hash=value=>createHash('sha256').update(value).digest('hex'),row=()=>({projectId:'prj-1',sha256:sha,bytes:3,storageId:'s3:'+'b'.repeat(32),versionId:'version-1'});
async function temporary(action){const root=await realpath(await mkdtemp(path.join(tmpdir(),'nc-snapshot-recovery-test-')));try{await action(root);}finally{await rm(root,{recursive:true,force:true});}}
test('S3 references require a pinned version, exact address and bounded bytes',()=>{
 for(const changed of [{versionId:null},{versionId:'null'},{versionId:'a\nb'},{storageId:'https://arbitrary'},{sha256:'../bad'},{bytes:67108865},{projectId:''},{projectId:'nul\0'}])assert.throws(()=>snapshotBlob({...row(),...changed}));
 assert.deepEqual(snapshotBlob(row()),row());assert.throws(()=>snapshotBlobs([row(),row()]),/Повтор/);
});
test('Dangling or differently sized full-snapshot references fail before publication or target writes',async()=>{
 const reference={projectId:'prj-1',sha256:sha,bytes:3};assertSnapshotReferences([row()],[reference,reference]);assert.throws(()=>assertSnapshotReferences([], [reference]),/exact.*blob/);assert.throws(()=>assertSnapshotReferences([row()],[{...reference,bytes:4}]),/exact.*blob/);
 await assert.rejects(readSnapshotBlobs(async(_database,text)=>text.includes('project_snapshot_blob_writes')?'f':text.includes('to_regclass')?'t':text.includes('count(*)')?'1':JSON.stringify([row()])),/exact.*blob/);
 await assert.rejects(readSnapshotBlobs(async(_database,text)=>text.includes('project_snapshot_blob_writes')?'f':text.includes('to_regclass')?text.includes('project_snapshot_blobs')?'f':'t':'1'),/exact.*blob/);
});
test('Unsettled blob-write intent blocks backup and readonly dump preview; it never migrates source cleanup identity',async()=>temporary(async root=>{
 await assert.rejects(readSnapshotBlobs(async(_database,text)=>text.includes('to_regclass')?'t':'1'),/незавершённая запись/);
 const file=path.join(root,'writes.copy'),header='COPY public.project_snapshot_blob_writes (project_id, sha256, write_id, bytes, storage_id) FROM stdin;\n';await writeFile(file,header+'\\.\n');assert.deepEqual(await readSnapshotCopy(file,'project_snapshot_blob_writes'),[]);
 await writeFile(file,header+['prj-1',sha,'d193c129-2b46-46a0-bbbd-92159badac84','3','s3:'+'b'.repeat(32)].join('\t')+'\n\\.\n');await assert.rejects(readSnapshotCopy(file,'project_snapshot_blob_writes'),/незавершённую запись/);
}));
test('Incomplete UPLOADING/REJECTED candidates do not require future chunks; ready references require LIVE exact bytes',()=>{
 const reference={snapshotId:'candidate',projectId:'prj-1',sha256:sha,bytes:3};for(const status of ['UPLOADING','REJECTED','DELETING','DELETED'])assertSnapshotReferences([],[reference],{snapshots:[{id:'candidate',status}],blobStates:new Map()});
 for(const status of ['VERIFYING','VERIFIED']){const snapshots=[{id:'candidate',status}];assert.throws(()=>assertSnapshotReferences([],[reference],{snapshots,blobStates:new Map()}),/exact LIVE/);assert.throws(()=>assertSnapshotReferences([row()],[reference],{snapshots,blobStates:new Map([['prj-1\0'+sha,'DELETING']])}),/exact LIVE/);assertSnapshotReferences([row()],[reference],{snapshots,blobStates:new Map([['prj-1\0'+sha,'LIVE']])});}
});
test('V3 rejects absent/corrupt/extra object bytes, unsafe paths, unknown private files and public key modes',()=>{
 const value=manifest(),record={...row(),file:snapshotObjectFile('prj-1',sha)};value.snapshotObjects.blobs=[record];assert.throws(()=>validateManifest(value),/exact bytes/);
 value.entries.push({path:'snapshot-objects',type:'directory',mode:448},{path:path.posix.dirname(record.file),type:'directory',mode:448},{path:record.file,type:'file',mode:384,size:3,sha256:sha});validateManifest(value);
 for(const change of [{file:'../escape'},{file:'snapshot-objects/random'},{bytes:4},{sha256:'c'.repeat(64)}])assert.throws(()=>validateManifest({...value,snapshotObjects:{schemaVersion:1,blobs:[{...record,...change}]}}));
 assert.throws(()=>validateManifest({...value,entries:[...value.entries,{path:'snapshot-objects/extra',type:'file',mode:384,size:3,sha256:sha}]}),/Посторонний/);
 const keys={...value,snapshotObjects:{...value.snapshotObjects,keyFiles:['operatorsecrets/snapshot_signing_key']},entries:[...value.entries,{path:'operatorsecrets',type:'directory',mode:448},{path:'operatorsecrets/snapshot_signing_key',type:'file',mode:420,size:100,sha256:sha}]};assert.throws(()=>validateManifest(keys),/закрытую/);
 keys.entries.at(-1).mode=384;validateManifest(keys);keys.entries.push({path:'operatorsecrets/access_key',type:'file',mode:384,size:10,sha256:sha});assert.throws(()=>validateManifest(keys),/посторонних/);
});
const copyHeader='COPY public.project_snapshot_blobs (project_id, sha256, bytes, storage_id, version_id, future_gc_state) FROM stdin;\n';
const copyRow=['prj-1',sha,'3','s3:'+'b'.repeat(32),'version-1','retained'];
const copyBytes=fields=>copyHeader+fields.join('\t')+'\n\\.\n';
test('Streaming COPY parser decodes PostgreSQL escaping and ignores future lifecycle columns while retaining exact identity',async()=>temporary(async root=>{
 const project="quote'\tline\nback\\slash",file=path.join(root,'copy');
 await writeFile(file,copyBytes(["quote'\\tline\\nback\\\\slash",...copyRow.slice(1)]));
 assert.deepEqual(await readSnapshotCopy(file,'project_snapshot_blobs'),[{...row(),projectId:project}]);
 await writeFile(file,copyBytes(['\\141\\142\\143_日本語',...copyRow.slice(1)]));
 assert.deepEqual(await readSnapshotCopy(file,'project_snapshot_blobs'),[{...row(),projectId:'abc_日本語'}]);
}));
for(const [name,fields,error] of [
 ['null pinned S3 version',[...copyRow.slice(0,4),'\\N','retained'],/точную immutable version/],
 ['null bytes',[...copyRow.slice(0,2),'\\N',...copyRow.slice(3)],/COPY размер/],
 ['fractional bytes',[...copyRow.slice(0,2),'3.5',...copyRow.slice(3)],/COPY размер/],
 ['null project',['\\N',...copyRow.slice(1)],/опись блоков/],
 ['NUL escaped in a project',['prj-\\000',...copyRow.slice(1)],/опись блоков/],
 ['unfinished escape',['prj-\\',...copyRow.slice(1)],/COPY escape/],
])test('Streaming COPY parser refuses '+name,async()=>temporary(async root=>{
 const file=path.join(root,'copy');await writeFile(file,copyBytes(fields));await assert.rejects(readSnapshotCopy(file,'project_snapshot_blobs'),error);
}));
for(const [name,copy,error] of [
 ['missing terminator',copyBytes(copyRow).replace('\\.\n',''),/усечён/],
 ['malformed terminator',copyBytes(copyRow).replace('\\.\n','\\. trailing\n'),/число COPY полей/],
 ['repeated COPY section',copyBytes(copyRow)+copyBytes(copyRow),/Повтор COPY/],
])test('Streaming COPY parser refuses '+name,async()=>temporary(async root=>{
 const file=path.join(root,'copy');await writeFile(file,copy);await assert.rejects(readSnapshotCopy(file,'project_snapshot_blobs'),error);
}));
test('Private S3 config rejects symlinks, public credentials, source URL paths and fingerprints credential rotation',async()=>temporary(async root=>{
 await writeFile(path.join(root,'access'),'access',{mode:384});await writeFile(path.join(root,'secret'),'secret',{mode:384});const endpoint={endpoint:'https://objects.example.test',bucket:'snapshots-source',region:'us-east-1',accessKeyFile:'access',secretKeyFile:'secret'},file=path.join(root,'snapshot-recovery.json');await writeFile(file,JSON.stringify({source:endpoint}),{mode:384});
 const value=await snapshotRecoveryConfiguration(root);assert.match(value.source.storageId,/^s3:[a-f0-9]{32}$/);const before=await snapshotRecoveryFingerprint(root);await writeFile(path.join(root,'secret'),'changed');assert.notDeepEqual(await snapshotRecoveryFingerprint(root),before);
 await chmod(path.join(root,'secret'),420);await assert.rejects(snapshotRecoveryConfiguration(root),/закрытый/);await chmod(path.join(root,'secret'),384);
 await writeFile(file,JSON.stringify({source:{...endpoint,endpoint:'https://objects.example.test/path'}}));await assert.rejects(snapshotRecoveryConfiguration(root),/endpoint/);
  await writeFile(file,JSON.stringify({source:endpoint,target:false}));await assert.rejects(snapshotRecoveryConfiguration(root),/snapshot-recovery/);
 await rm(file);await writeFile(path.join(root,'other'),JSON.stringify({source:endpoint}),{mode:384});await symlink(path.join(root,'other'),file);await assert.rejects(snapshotRecoveryConfiguration(root),/ссылкой/);
}));
test('Bundle retains the current signing identity and historical trusted keys; missing/untrusted signing material fails',async()=>temporary(async root=>{
 const pair=generateKeyPairSync('ed25519'),old=generateKeyPairSync('ed25519'),pem=old.publicKey.export({type:'spki',format:'pem'}).toString(),signature={algorithm:'Ed25519',keyId:hash(pem),publicKey:pem,value:sign(null,Buffer.from('real signature'),old.privateKey).toString('base64')};
 const signing=path.join(root,'signing'),ring=path.join(root,'ring'),destination=path.join(root,'bundle');await mkdir(destination,{mode:448});await writeFile(signing,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:384});await writeFile(ring,JSON.stringify({[signature.keyId]:pem}),{mode:384});
 const keyFiles=await exportSnapshotKeys(destination,{signingKeyFile:signing,trustedKeysFile:ring},[signature]);assert.equal(keyFiles.length,2);await verifyBundleSnapshotKeys(destination,{keyFiles},[signature]);assert.deepEqual(await readFile(path.join(destination,keyFiles[0])),await readFile(signing));
 await assert.rejects(snapshotKeyMaterial(path.join(root,'missing'),ring,{required:true}),/закрытый ключ/);
 await writeFile(ring,'{}');await assert.rejects(exportSnapshotKeys(path.join(root,'another'),{signingKeyFile:signing,trustedKeysFile:ring},[signature]),/доверенному/);
}));
test('Historical SQL-only S3 data and mismatched exact SQL inventory fail preview before any target operation',async()=>temporary(async root=>{
 let touched=0;const factory=()=>{touched++;throw new Error('target must not run');};
 await assert.rejects(previewSnapshotRecovery({directory:root,source:root,manifest:{format:'neurocenter-recovery-v2'},metadata:{blobs:[row()],signatures:[]},storeFactory:factory}),/SQL/);assert.equal(touched,0);
 await assert.rejects(previewSnapshotRecovery({directory:root,source:root,manifest:{snapshotObjects:{schemaVersion:1,blobs:[{...row(),file:snapshotObjectFile('prj-1',sha)}]}},metadata:{blobs:[{...row(),versionId:'different'}],signatures:[]},storeFactory:factory}),/SQL/);assert.equal(touched,0);
}));
test('Backup refuses S3 SQL refs without matching configured source, and incomplete FS bytes',async()=>temporary(async root=>{
 const sql=async(_db,text)=>text.includes('to_regclass')?text.includes('project_snapshot_blobs')?'t':'f':JSON.stringify([row()]);
 await assert.rejects(exportSnapshotRecovery({directory:root,destination:root,sql}),/source/);
 const local={...row(),storageId:'fs:'+'b'.repeat(32),versionId:null};await assert.rejects(exportSnapshotRecovery({directory:root,destination:root,sql:async(db,text)=>text.includes('to_regclass')?text.includes('project_snapshot_blobs')?'t':'f':JSON.stringify([local])}),error=>error.code==='ENOENT');
}));
test('Actual MinIO HTTP partial/truncated/wrong bytes fail without retaining partial objects or deleting an existing file',async()=>temporary(async root=>{
 const payload=Buffer.from('the exact bytes of a snapshot object'),sha256=hash(payload);let mode='partial',reads=0;
 const server=createServer((request,response)=>{
  if(request.url.includes('?policy')){response.writeHead(404,{'content-type':'application/xml'});response.end('<Error><Code>NoSuchBucketPolicy</Code></Error>');return;}
  if(request.url.includes('?acl')){response.writeHead(200,{'content-type':'application/xml'});response.end('<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>');return;}
  if(request.url.includes('versioning')){response.writeHead(200,{'content-type':'application/xml'});response.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>');return;}
  if(mode==='retryable'){reads++;response.writeHead(503,{'content-type':'application/xml'});response.end('<Error><Code>SlowDown</Code><Message>Own bounded retry fixture</Message></Error>');return;}
  reads++;response.writeHead(200,{'content-length':String(payload.length),'content-type':'application/octet-stream'});
  if(mode==='partial'){response.write(payload.subarray(0,4));setTimeout(()=>response.destroy(),5);}
  else response.end(mode==='wrong'?Buffer.alloc(payload.length,1):payload);
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const endpoint='http://127.0.0.1:'+server.address().port,storageId='s3:'+hash(JSON.stringify([endpoint,'source-test'])).slice(0,32),record={...row(),sha256,bytes:payload.length,storageId},configuration={source:{endpoint,bucket:'source-test',region:'us-east-1',accessKeyFile:'access',secretKeyFile:'secret'}};
  await writeFile(path.join(root,'access'),'own-access',{mode:384});await writeFile(path.join(root,'secret'),'own-secret',{mode:384});await writeFile(path.join(root,'snapshot-recovery.json'),JSON.stringify(configuration),{mode:384});
  const sql=async(_database,text)=>text.includes('to_regclass')?text.includes('project_snapshot_blobs')?'t':'f':JSON.stringify([record]);
  const destination=path.join(root,'bundle');await mkdir(destination,{mode:448});const file=path.join(destination,snapshotObjectFile(record.projectId,sha256));
  await assert.rejects(exportSnapshotRecovery({directory:root,destination,sql}));await assert.rejects(readFile(file),error=>error.code==='ENOENT');
  mode='wrong';await assert.rejects(exportSnapshotRecovery({directory:root,destination,sql}),/SHA256/);await assert.rejects(readFile(file),error=>error.code==='ENOENT');
  mode='ok';await writeFile(file,'existing owned bytes',{mode:384});await assert.rejects(exportSnapshotRecovery({directory:root,destination,sql}),error=>error.code==='EEXIST');assert.equal(await readFile(file,'utf8'),'existing owned bytes');assert.equal(reads,3);
  mode='retryable';await assert.rejects(exportSnapshotRecovery({directory:root,destination,sql}),/0 retries/);assert.equal(reads,4);assert.equal(await readFile(file,'utf8'),'existing owned bytes');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));
test('A signed historical bundle without private signing identity fails even when it contains no objects',async()=>temporary(async root=>{
 const pair=generateKeyPairSync('ed25519'),pem=pair.publicKey.export({type:'spki',format:'pem'}).toString(),signature={algorithm:'Ed25519',keyId:hash(pem),publicKey:pem,value:sign(null,Buffer.from('metadata'),pair.privateKey).toString('base64')};
 await assert.rejects(previewSnapshotRecovery({directory:root,source:root,manifest:{format:'neurocenter-recovery-v2'},metadata:{blobs:[],signatures:[signature]}}),/закрытый ключ/);
}));
test('Strict Ceph signed HTTP snapshot restore verifies streamed bytes and version before the SQL admission boundary',async()=>temporary(root=>s3Fixture(async s3=>{
 const payload=Buffer.from('Exact private snapshot original 日本語'),sha256=hash(payload),projectId='prj-operator-ceph',file=snapshotObjectFile(projectId,sha256),target={endpoint:s3.endpoint,bucket:'snapshot-target-private',region:'us-east-1',accessKey:'test-access',secretKey:'test-secret',storageId:'s3:'+'c'.repeat(32)};
 await mkdir(path.dirname(path.join(root,file)),{recursive:true,mode:0o700});await writeFile(path.join(root,file),payload,{mode:0o600});const blob={projectId,sha256,bytes:payload.length,storageId:'s3:'+'b'.repeat(32),versionId:'source-version',file};let guards=0,publications=0;
 await assert.rejects(restoreSnapshotRecovery({source:root,preview:{configuration:{target},blobs:[blob]},sql:async()=>{publications++;throw Error('Unexpected SQL publication');},beforeMutation:async()=>{if(++guards===4)throw Error('operator-revoked-before-SQL');}}),/operator-revoked-before-SQL/);
 const writes=s3.events.filter(e=>e.method==='PUT'&&e.key);assert.equal(writes.length,1);assert.equal(writes[0].signed,true);assert.equal(writes[0].contentType,undefined);assert.equal(publications,0);
 const object=s3.buckets.get(target.bucket).objects.values().next().value[0];assert.deepEqual(object.bytes,payload);assert.equal(hash(object.bytes),sha256);assert.ok(s3.events.some(e=>e.method==='GET'&&e.signed&&e.version===object.version));assert.deepEqual(await readFile(path.join(root,file)),payload);
})));
