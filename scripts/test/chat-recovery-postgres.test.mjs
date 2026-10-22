import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';
import {chatRecoveryConfiguration} from '../production/chat-recovery-config.mjs';
import {readChatMetadata} from '../production/chat-recovery-metadata.mjs';
import {exportChatRecovery,previewChatRecovery,restoreChatRecovery} from '../production/chat-recovery-storage.mjs';
import {temporary,s3Fixture,configuration,rows,payload} from './chat-recovery.fixture.mjs';
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const adminValue=process.env.CHAT_RECOVERY_TEST_ADMIN_PG_URL;
const selected=(name,action)=>test(name,{skip:!adminValue},action);
const schema=`CREATE TABLE model_chat_conversations(id uuid PRIMARY KEY,owner_email text NOT NULL,project_id text);
CREATE TABLE model_chat_objects(id uuid PRIMARY KEY,storage_id text NOT NULL,bucket text NOT NULL,object_key text NOT NULL,version_id text,sha256 text NOT NULL,bytes integer NOT NULL,state text NOT NULL);
CREATE TABLE model_chat_attachments(id uuid PRIMARY KEY,conversation_id uuid REFERENCES model_chat_conversations,object_id uuid REFERENCES model_chat_objects,storage_state text NOT NULL,bytes integer NOT NULL,deleted_at timestamptz);
CREATE TABLE model_chat_attachment_transfers(attachment_id uuid PRIMARY KEY REFERENCES model_chat_attachments,content bytea NOT NULL,sha256 text NOT NULL,bytes integer NOT NULL);`;
async function fixture(action){
 const url=ownedTestPostgresAdmin(adminValue),{Pool}=require('pg'),admin=new Pool({connectionString:url.href,max:1}),name='chat_recovery_'+randomUUID().replaceAll('-','');let pool,created=false;
 try{await admin.query('CREATE DATABASE '+name);created=true;const child=new URL(url);child.pathname='/'+name;pool=new Pool({connectionString:child.href,max:1});await pool.query(schema);
  await temporary(root=>s3Fixture(async s3=>{await configuration(root,s3.endpoint);const config=await chatRecoveryConfiguration(root),raw=rows(config.source);s3.seed(config.source,raw);
   for(const r of raw.conversations)await pool.query('INSERT INTO model_chat_conversations VALUES($1,$2,$3)',[r.id,r.ownerEmail,r.projectId]);
   for(const r of raw.objects)await pool.query('INSERT INTO model_chat_objects VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[r.id,r.storageId,r.bucket,r.objectKey,r.versionId,r.sha256,r.bytes,r.state]);
   for(const r of raw.attachments)await pool.query('INSERT INTO model_chat_attachments VALUES($1,$2,$3,$4,$5,$6)',[r.id,r.conversationId,r.objectId,r.storageState,r.bytes,r.deletedAt]);
   for(const r of raw.transfers)await pool.query('INSERT INTO model_chat_attachment_transfers VALUES($1,$2,$3,$4)',[r.attachmentId,payload,r.sha256,r.bytes]);
   let committed=false;const sql=async(_db,text)=>{const client=await pool.connect();try{const result=await client.query(text);if(text.startsWith('BEGIN;')){committed=true;return'';}return result.rows.map(row=>Object.values(row)[0]).map(value=>typeof value==='boolean'?value?'t':'f':typeof value==='object'?JSON.stringify(value):String(value)).join('\n');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
   const source=path.join(root,'bundle');await mkdir(source,{mode:0o700});const inventory=await exportChatRecovery({directory:root,destination:source,sql});const manifest={format:'neurocenter-recovery-v4',chatObjects:inventory,entries:[{path:'chat-objects',type:'directory',mode:0o700},...inventory.objects.map(row=>({path:row.file,type:'file',mode:0o600,size:row.bytes,sha256:row.sha256}))]},before=await readChatMetadata(sql),preview=await previewChatRecovery({directory:root,source,manifest,metadata:before});await action({pool,root,s3,config,raw,sql,source,inventory,before,preview,committed:()=>committed});
  }));
 }finally{await pool?.end();if(created)await admin.query('DROP DATABASE '+name);await admin.end();}
}
selected('Actual SQL remaps both buckets atomically, deletes only validated source-only intents and retains active/deleted transfer bytes',async()=>fixture(async f=>{
 const result=await restoreChatRecovery({source:f.source,preview:f.preview,sql:f.sql});assert.equal(result.state,'completed');assert.equal(result.objects,2);assert.equal(result.discardedIntents,2);assert.equal(result.retainedDeletedTransfers,1);const after=await readChatMetadata(f.sql);assert.equal(after.objects.length,2);assert.equal(after.discardedObjects.length,0);assert.deepEqual(after.transfers,f.before.transfers);for(const row of after.objects){assert.equal(row.storageId,f.config.target.storageId);assert.ok(row.versionId.startsWith('target-version-'));assert.ok(row.bucket.startsWith('chat-target-'));}
 const bodies=await f.pool.query('SELECT content FROM model_chat_attachment_transfers');assert.equal(bodies.rowCount,2);assert.ok(bodies.rows.every(row=>row.content.equals(payload)));assert.ok(f.s3.events.filter(e=>['PUT','DELETE'].includes(e.method)).every(e=>e.bucket.startsWith('chat-target-')));
}));
selected('Actual SQL owner changes after admitted S3 copy abort every remap/delete in one transaction',async()=>fixture(async f=>{
 let changed=false;const beforeMutation=async()=>{if(!changed&&f.s3.events.filter(e=>e.method==='PUT'&&e.key).length===2){changed=true;await f.pool.query('UPDATE model_chat_conversations SET owner_email=$1 WHERE id=$2',['revoked@test',f.raw.conversations[0].id]);}};await assert.rejects(restoreChatRecovery({source:f.source,preview:f.preview,sql:f.sql,beforeMutation}),/division by zero/);const actual=await f.pool.query('SELECT storage_id,state FROM model_chat_objects');assert.equal(actual.rowCount,4);assert.ok(actual.rows.every(row=>row.storage_id===f.config.source.storageId));assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_attachment_transfers')).rows[0].count,'2');
}));
selected('Actual SQL source-version drift aborts remaps and source-only cleanup without lost rows',async()=>fixture(async f=>{
 let changed=false;await assert.rejects(restoreChatRecovery({source:f.source,preview:f.preview,sql:f.sql,beforeMutation:async()=>{if(!changed&&f.s3.events.filter(e=>e.method==='PUT'&&e.key).length===2){changed=true;await f.pool.query('UPDATE model_chat_objects SET version_id=$1 WHERE id=$2',['later-source-version',f.raw.objects[1].id]);}}}),/division by zero/);assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_objects')).rows[0].count,'4');assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_objects WHERE storage_id=$1',[f.config.target.storageId])).rows[0].count,'0');
}));
selected('Actual SQL transfer payload drift rolls back earlier S3 remaps and deletion intents',async()=>fixture(async f=>{
 let changed=false;await assert.rejects(restoreChatRecovery({source:f.source,preview:f.preview,sql:f.sql,beforeMutation:async()=>{if(!changed&&f.s3.events.filter(e=>e.method==='PUT'&&e.key).length===2){changed=true;await f.pool.query('UPDATE model_chat_attachment_transfers SET content=$1 WHERE attachment_id=$2',[Buffer.alloc(payload.length),f.raw.transfers[1].attachmentId]);}}}),/division by zero/);assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_objects')).rows[0].count,'4');assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_objects WHERE storage_id=$1',[f.config.target.storageId])).rows[0].count,'0');
}));
selected('Actual SQL abandoned object becoming referenced/LIVE is never deleted by source-only cleanup',async()=>fixture(async f=>{
 let changed=false;await assert.rejects(restoreChatRecovery({source:f.source,preview:f.preview,sql:f.sql,beforeMutation:async()=>{if(!changed&&f.s3.events.filter(e=>e.method==='PUT'&&e.key).length===2){changed=true;await f.pool.query('UPDATE model_chat_objects SET state=$1 WHERE id=$2',['LIVE',f.raw.objects[2].id]);}}}),/division by zero/);assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_objects')).rows[0].count,'4');assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_objects WHERE storage_id=$1',[f.config.target.storageId])).rows[0].count,'0');
}));
selected('Lost COMMIT acknowledgment keeps explicit unknown receipt; replay cannot upload again or alter committed target rows',async()=>fixture(async f=>{
 const sql=async(db,text)=>{const result=await f.sql(db,text);if(text.startsWith('BEGIN;'))throw Error('commit ACK lost');return result;};let failure;await assert.rejects(restoreChatRecovery({source:f.source,preview:f.preview,sql}),error=>{failure=error;return error.message==='commit ACK lost';});assert.equal(failure.chatRecoveryReceipt.sqlOutcome,'unknown');assert.equal(f.committed(),true);assert.equal((await f.pool.query('SELECT count(*) FROM model_chat_objects WHERE storage_id=$1',[f.config.target.storageId])).rows[0].count,'2');const putCount=f.s3.events.filter(e=>e.method==='PUT'&&e.key).length;await assert.rejects(restoreChatRecovery({source:f.source,preview:f.preview,sql:f.sql}));assert.equal(f.s3.events.filter(e=>e.method==='PUT'&&e.key).length,putCount);
}));
selected('Actual SQL preflight owner mismatch fails before creating either target bucket',async()=>fixture(async f=>{
 await f.pool.query('UPDATE model_chat_conversations SET owner_email=$1 WHERE id=$2',['different@test',f.raw.conversations[0].id]);await assert.rejects(restoreChatRecovery({source:f.source,preview:f.preview,sql:f.sql}));assert.equal(f.s3.events.filter(e=>['PUT','DELETE'].includes(e.method)).length,0);assert.equal(f.s3.buckets.has(f.config.target.projectBucket),false);
}));
