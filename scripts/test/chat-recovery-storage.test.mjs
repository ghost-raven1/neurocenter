import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chatRecoveryConfiguration} from '../production/chat-recovery-config.mjs';
import {chatObjectFile} from '../production/chat-recovery-metadata.mjs';
import {exportChatRecovery,previewChatRecovery,restoreChatRecovery,chatTargetOverlay} from '../production/chat-recovery-storage.mjs';
import {pauseBudget} from '../production/recovery.mjs';
import {temporary,s3Fixture,configuration,rows,metadata,sqlRows,payload} from './chat-recovery.fixture.mjs';

const entries=inventory=>[{path:'chat-objects',type:'directory',mode:0o700},...inventory.objects.map(row=>({path:row.file,type:'file',mode:0o600,size:row.bytes,sha256:row.sha256}))];
async function fixture(action,{empty=false}={}){return temporary(root=>s3Fixture(async s3=>{
 await configuration(root,s3.endpoint);const config=await chatRecoveryConfiguration(root),raw=empty?{objects:[],attachments:[],conversations:[],transfers:[]}:rows(config.source),sql=sqlRows(raw);s3.seed(config.source,raw);const source=path.join(root,'bundle');await mkdir(source,{mode:0o700});
 const exported=await exportChatRecovery({directory:root,destination:source,sql});const manifest={format:'neurocenter-recovery-v4',chatObjects:exported,entries:entries(exported)};
 const preview=()=>previewChatRecovery({directory:root,source,manifest,metadata:metadata(raw)});return action({root,s3,config,raw,sql,source,exported,manifest,preview});
}));}
const objectWrites=events=>events.filter(e=>e.method==='PUT'&&e.key);
const mutation=events=>events.filter(e=>['PUT','DELETE','POST'].includes(e.method));
test('Signed HTTP export uses exact nonlatest and null versions from both buckets, copies bytes and never mutates source',async()=>fixture(async f=>{
 assert.equal(f.exported.objects.length,2);for(const row of f.exported.objects)assert.deepEqual(await readFile(path.join(f.source,row.file)),payload);const reads=f.s3.events.filter(e=>e.key);assert.ok(reads.filter(e=>e.signed&&e.method==='GET').every(e=>['old-project','null'].includes(e.version)));assert.ok(reads.filter(e=>!e.signed).every(e=>['old-project','null'].includes(e.version)));assert.equal(mutation(f.s3.events).length,0);await f.preview();
}));
test('Old public version with latest private is rejected using exact anonymous HEAD before publishing backup bytes',async()=>fixture(async f=>{
 const old=f.exported.objects[0];f.s3.publicVersions.add(old.bucket+'\0'+old.objectKey+'\0'+old.versionId);const destination=path.join(f.root,'public-refused');await mkdir(destination,{mode:0o700});await assert.rejects(exportChatRecovery({directory:f.root,destination,sql:f.sql}),/анонимно/);await assert.rejects(readFile(path.join(destination,old.file)),{code:'ENOENT'});assert.equal(mutation(f.s3.events).length,0);
}));
for(const mode of ['wrong-version','wrong-bytes'])test('Signed exact source '+mode+' refuses publication without any source writes',async()=>fixture(async f=>{
 f.s3.setMode(mode);const destination=path.join(f.root,'bad-source');await mkdir(destination);await assert.rejects(exportChatRecovery({directory:f.root,destination,sql:f.sql}),mode==='wrong-version'?/version/:/SHA/);assert.equal(mutation(f.s3.events).length,0);await assert.rejects(readFile(path.join(destination,f.exported.objects[0].file)),{code:'ENOENT'});
}));
test('Missing source exact object is not replaced with latest; missing local bytes prevent target access',async()=>fixture(async f=>{
 f.s3.buckets.get(f.config.source.projectBucket).objects.clear();const destination=path.join(f.root,'missing');await mkdir(destination);await assert.rejects(exportChatRecovery({directory:f.root,destination,sql:f.sql}));const before=f.s3.events.length;await rm(path.join(f.source,f.exported.objects[0].file));await assert.rejects(f.preview(),{code:'ENOENT'});assert.equal(f.s3.events.length,before);
}));
for(const mode of ['stall-head','stall-body'])test('Absolute maintenance pause bounds '+mode+' rather than allowing 15s/120s stall',async()=>fixture(async f=>{
 f.s3.setMode(mode);const destination=path.join(f.root,'timeout');await mkdir(destination);const started=Date.now();await assert.rejects(exportChatRecovery({directory:f.root,destination,sql:f.sql,checkDeadline:pauseBudget(180)}));assert.ok(Date.now()-started<2000);assert.equal(mutation(f.s3.events).length,0);
}));
test('Foreign SQL/source identity and existing target bucket fail before any target mutation',async()=>fixture(async f=>{
 const changed=metadata(f.raw);changed.objects[0].storageId='f'.repeat(64);await assert.rejects(previewChatRecovery({directory:f.root,source:f.source,manifest:f.manifest,metadata:changed}),/SQL/);
 const raw=JSON.parse(await readFile(path.join(f.root,'chat-recovery.json'),'utf8'));raw.source.projectBucket='foreign-project';await writeFile(path.join(f.root,'chat-recovery.json'),JSON.stringify(raw));await assert.rejects(f.preview(),/identity/);await configuration(f.root,f.s3.endpoint);
 f.s3.buckets.set(f.config.target.personalBucket,{versioned:false,objects:new Map()});await assert.rejects(f.preview(),/уже существует/);assert.equal(mutation(f.s3.events).length,0);
}));
test('Runtime chat S3 with zero references still requires target and target overlay replaces every source identity/credential field',async()=>fixture(async f=>{
 const runtime={CHAT_S3_ENDPOINT:f.s3.endpoint,CHAT_S3_PROJECT_BUCKET:f.config.source.projectBucket,CHAT_S3_PERSONAL_BUCKET:f.config.source.personalBucket};const raw=JSON.parse(await readFile(path.join(f.root,'chat-recovery.json'),'utf8'));delete raw.target;await writeFile(path.join(f.root,'chat-recovery.json'),JSON.stringify(raw));await assert.rejects(previewChatRecovery({directory:f.root,source:f.source,manifest:f.manifest,metadata:metadata(f.raw),applicationS3:runtime}),/target/);
 await configuration(f.root,f.s3.endpoint);const preview=await previewChatRecovery({directory:f.root,source:f.source,manifest:f.manifest,metadata:metadata(f.raw),applicationS3:runtime});await mkdir(path.join(f.root,'recovery-receipts'));const overlay=JSON.parse(await readFile(await chatTargetOverlay(f.root,'owned',preview),'utf8')),env=overlay.services['catalog-service'].environment;assert.equal(env.CHAT_S3_PROJECT_BUCKET,'chat-target-project');assert.equal(env.CHAT_S3_PERSONAL_BUCKET,'chat-target-personal');assert.equal(env.CHAT_S3_ACCESS_KEY,'');assert.equal(env.CHAT_S3_SECRET_KEY,'');assert.match(env.CHAT_S3_ACCESS_KEY_FILE,/\/run\/secrets\//);assert.equal(mutation(f.s3.events).length,0);
},{empty:true}));
test('Legacy v1-v3 absent chat tables require no migrations or publication SQL; explicit target is new/private/versioned',async()=>fixture(async f=>{
 for(const format of ['neurocenter-recovery-v1','neurocenter-recovery-v2','neurocenter-recovery-v3']){const before=f.s3.events.length,p=await previewChatRecovery({directory:f.root,source:f.source,manifest:{format},metadata:{objects:[],discardedObjects:[],transfers:[]}});assert.equal(mutation(f.s3.events.slice(before)).length,0);assert.ok(p.configuration.target);}
 const preview=await f.preview(),queries=[],sql=async(_db,text)=>{queries.push(text);assert.ok(text.includes('to_regclass'));return'f';};const result=await restoreChatRecovery({source:f.source,preview,sql});assert.equal(result.state,'completed');assert.equal(result.sqlOutcome,'not-started');assert.equal(result.objects,0);assert.ok(queries.every(text=>!text.includes('CREATE')&&!text.includes('BEGIN')));assert.equal(f.s3.buckets.get('chat-target-project').versioned,true);assert.equal(f.s3.buckets.get('chat-target-personal').versioned,true);
},{empty:true}));
test('Revocation while target privacy awaits blocks next PUT and publishes no SQL',async()=>fixture(async f=>{
 const preview=await f.preview();let revoked=false,publications=0;f.s3.setHook(async e=>{if(e.bucket==='chat-target-personal'&&e.url.searchParams.has('acl')&&f.s3.events.filter(item=>item.bucket==='chat-target-personal'&&item.query==='?acl').length>=2)revoked=true;});
 await assert.rejects(restoreChatRecovery({source:f.source,preview,sql:sqlRows(f.raw,{onPublication:()=>{publications++;}}),beforeMutation:async()=>{if(revoked)throw Error('revoked');}}),/revoked/);assert.equal(objectWrites(f.s3.events).length,0);assert.equal(publications,0);
}));
test('Revocation during final privacy check stops SQL after already admitted exact object copies',async()=>fixture(async f=>{
 const preview=await f.preview();let revoked=false,publications=0;f.s3.setHook(async e=>{if(e.bucket==='chat-target-personal'&&e.url.searchParams.has('acl')&&objectWrites(f.s3.events).length===2)revoked=true;});
 await assert.rejects(restoreChatRecovery({source:f.source,preview,sql:sqlRows(f.raw,{onPublication:()=>{publications++;}}),beforeMutation:async()=>{if(revoked)throw Error('revoked-final');}}),/revoked-final/);const writes=objectWrites(f.s3.events);assert.equal(writes.length,2);for(const event of writes){assert.equal(event.signed,true);assert.equal(event.contentType,undefined);assert.equal(event.metadataSha256,f.exported.objects[0].sha256);assert.ok(event.signedHeaders.includes('x-amz-meta-neurocenter-sha256'));}assert.equal(publications,0);assert.ok(mutation(f.s3.events).every(e=>e.bucket.startsWith('chat-target-')));
}));
test('Unknown PUT ACK preserves source and explicit progress, blocks replay into any created target',async()=>fixture(async f=>{
 const preview=await f.preview();f.s3.setMode('unknown-put');let failure;await assert.rejects(restoreChatRecovery({source:f.source,preview,sql:f.sql}),error=>{failure=error;return true;});assert.equal(failure.chatRecoveryReceipt.phase,'put-object');assert.equal(failure.chatRecoveryReceipt.sqlOutcome,'not-started');assert.equal(failure.chatRecoveryReceipt.createdBuckets.length,2);assert.equal(failure.chatRecoveryReceipt.sourceS3Mutated,false);const writes=objectWrites(f.s3.events).length;await assert.rejects(restoreChatRecovery({source:f.source,preview,sql:f.sql}),/уже существует/);assert.equal(objectWrites(f.s3.events).length,writes);assert.ok(mutation(f.s3.events).every(e=>e.bucket.startsWith('chat-target-')));for(const row of f.exported.objects)assert.deepEqual(f.s3.buckets.get(row.bucket).objects.get(row.objectKey)[0].bytes,payload);
}));

test('Unknown CREATE ACK records attempted bucket without claiming creation and replay refuses the now-existing bucket',async()=>fixture(async f=>{
 const preview=await f.preview();f.s3.setMode('unknown-create');let failure;await assert.rejects(restoreChatRecovery({source:f.source,preview,sql:f.sql}),error=>{failure=error;return true;});assert.deepEqual(failure.chatRecoveryReceipt.attemptedBuckets,[f.config.target.projectBucket]);assert.deepEqual(failure.chatRecoveryReceipt.createdBuckets,[]);assert.equal(failure.chatRecoveryReceipt.phase,'create-bucket');assert.equal(f.s3.buckets.has(f.config.target.projectBucket),true);const writes=mutation(f.s3.events).length;await assert.rejects(restoreChatRecovery({source:f.source,preview,sql:f.sql}),/уже существует/);assert.equal(mutation(f.s3.events).length,writes);assert.equal(objectWrites(f.s3.events).length,0);
}));
test('Public target ACL is refused after creation and before first object PUT or SQL publication',async()=>fixture(async f=>{
 const preview=await f.preview();let publications=0;const sql=sqlRows(f.raw,{onPublication:()=>{publications++;}});f.s3.setHook(async e=>{if(e.bucket.startsWith('chat-target-')&&e.url.searchParams.has('acl')){e.response.writeHead(200,{'content-type':'application/xml'});e.response.end('<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList></AccessControlPolicy>');}});await assert.rejects(restoreChatRecovery({source:f.source,preview,sql}));assert.equal(objectWrites(f.s3.events).length,0);assert.equal(publications,0);assert.ok(mutation(f.s3.events).every(e=>e.bucket.startsWith('chat-target-')));
}));
test('Unexpected target object version blocks SQL publication without cleaning or changing source buckets',async()=>fixture(async f=>{
 const preview=await f.preview();let injected=false,publications=0;const sql=sqlRows(f.raw,{onPublication:()=>{publications++;}});f.s3.setHook(async e=>{if(!injected&&e.bucket===f.config.target.projectBucket&&e.url.searchParams.has('versions')&&objectWrites(f.s3.events).length===2){injected=true;f.s3.buckets.get(e.bucket).objects.set('foreign-object',[{version:'foreign-version',bytes:payload}]);}});await assert.rejects(restoreChatRecovery({source:f.source,preview,sql}),/посторонние/);assert.equal(f.s3.buckets.get(f.config.target.projectBucket).objects.has('foreign-object'),true);assert.equal(publications,0);assert.ok(mutation(f.s3.events).every(e=>e.bucket.startsWith('chat-target-')));
}));
