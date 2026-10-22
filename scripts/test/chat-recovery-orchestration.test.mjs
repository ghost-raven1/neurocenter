import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,readFile,mkdir,readdir,rm} from 'node:fs/promises';
import {writeManifest,manifestDigest} from '../production/recovery-manifest.mjs';
import {previewRestoreProduction,restoreProduction} from '../production/recovery.mjs';
import {volumeKeys} from '../production/recovery-files.mjs';
import {applicationServices} from '../production/compose-client.mjs';
import {temporary} from './chat-recovery.fixture.mjs';

const image='sha256:'+'a'.repeat(64),empty={objects:[],discardedObjects:[],transfers:[]};
async function fixture(action){return temporary(async root=>{
 const directory=path.join(root,'operator'),source=path.join(root,'bundle');await mkdir(directory,{mode:0o700});await mkdir(path.join(source,'databases'),{recursive:true,mode:0o700});for(const db of ['catalog','rag'])await writeFile(path.join(source,'databases',db+'.dump'),'owned fixture '+db,{mode:0o600});for(const key of volumeKeys)await mkdir(path.join(source,'files',key),{recursive:true,mode:0o700});
 const databases=['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C',ctype:'C',file:'databases/'+name+'.dump'}));const saved=await writeManifest(source,{createdAt:new Date().toISOString(),postgresMajor:16,postgresImage:image,images:Object.fromEntries(applicationServices.map(name=>[name,image])),quiesced:true,databases});
 const calls=[];let started=false,revoked=false;const catalogEnvironment={},names=Object.fromEntries(['postgres',...volumeKeys].map(name=>[name,{name:'owned-'+name}]));
 const deps={composeClient:options=>({files:options.files||[],run:async args=>{calls.push(['compose',...args]);if(args[0]==='up')started=true;return'';}}),composeConfiguration:async()=>({volumes:names,services:{postgres:{image},'catalog-service':{environment:catalogEnvironment}}}),serviceImageIds:async()=>Object.fromEntries(applicationServices.map(name=>[name,image])),productionModelKeyIdentity:async()=>{},assertProductionModelKey:async()=>{},containers:async()=>started?[{Id:'owned-postgres',Config:{Labels:{'com.docker.compose.service':'postgres'}},State:{Running:true}}]:[],maintenanceLock:async(_client,_image,_kind,action)=>{calls.push(['lock']);return action();},volumeTransfer:async mode=>{calls.push(['files',mode]);},
  docker:async(args,options={})=>{calls.push(['docker',...args]);if(args[0]==='image')return JSON.stringify([{Id:image}]);if(args[0]==='volume')return'';if(args.includes('pg_restore'))return'';const text=options.input;if(text)calls.push(['sql',text]);if(text?.includes('to_regclass'))return'f';if(text?.includes('server_version_num'))return'160000';if(text?.includes('json_agg(rolname'))return JSON.stringify(['nc_backup','nc_catalog','nc_owner','nc_provisioner','nc_rag']);if(text?.includes('json_agg(json_build_object'))return JSON.stringify(databases);if(text?.includes('neurocenter_project_databases'))return'[]';if(text?.includes('count(*)'))return'0';if(text?.startsWith('CREATE DATABASE')){if(revokeOnCreate)revoked=true;return'';}if(text?.startsWith('ANALYZE')){return'';}if(text?.startsWith('DROP DATABASE')||text?.startsWith('BEGIN; DELETE FROM bridge_pairs'))return'';throw Error('Unexpected fixture docker '+args+' '+text);},
  dumpSnapshotMetadata:async()=>({blobs:[],signatures:[]}),dumpChatMetadata:async()=>empty};
 let revokeOnCreate=false;const options={directory,source,projectName:'owned-recovery',expectedHash:saved.sha256,beforeMutation:async()=>{calls.push(['admit']);if(revoked)throw Error('revoked');}};
 await action({root,directory,source,saved,options,deps,calls,catalogEnvironment,revoke(){revoked=true;},revokeOnCreate(){revokeOnCreate=true;}});
});}
const writes=calls=>calls.filter(c=>c[0]==='compose'&&['up','create','--profile'].includes(c[1])||c[0]==='docker'&&c.includes('exec'));
test('Corrupt verified source fails actual restore orchestrator before any new-target mutation',async()=>fixture(async f=>{
 await writeFile(path.join(f.source,'databases/catalog.dump'),'bad');await assert.rejects(restoreProduction(f.options,f.deps),/описи/);assert.equal(writes(f.calls).length,0);assert.ok(!f.calls.some(c=>c[0]==='lock'));
}));
test('Runtime chat S3 with no refs requires explicit target during preview, before maintenance lock and PG up',async()=>fixture(async f=>{
 Object.assign(f.catalogEnvironment,{CHAT_S3_ENDPOINT:'https://source.example.test',CHAT_S3_PROJECT_BUCKET:'chat-source-project',CHAT_S3_PERSONAL_BUCKET:'chat-source-personal'});await assert.rejects(restoreProduction(f.options,f.deps),/target/);assert.equal(writes(f.calls).length,0);assert.ok(!f.calls.some(c=>c[0]==='lock'));
}));
test('Legacy v1-v3 no-chat-table bundles restore without source migration or chat publication SQL',async()=>{
 for(const format of ['neurocenter-recovery-v1','neurocenter-recovery-v2','neurocenter-recovery-v3'])await fixture(async f=>{const manifest=structuredClone(f.saved.manifest);manifest.format=format;delete manifest.chatObjects;if(format==='neurocenter-recovery-v1'){manifest.entries=manifest.entries.filter(e=>!e.path.startsWith('files/runtime-artifacts'));await rm(path.join(f.source,'files/runtime-artifacts'),{recursive:true});}const raw=JSON.stringify(manifest)+'\n';await writeFile(path.join(f.source,'manifest.json'),raw);const options={...f.options,expectedHash:manifestDigest(raw)},p=await previewRestoreProduction(options,f.deps);assert.equal(p.manifest.format,format);assert.deepEqual(p.chatRecovery.metadata,empty);assert.equal(writes(f.calls).length,0);const receipt=await restoreProduction(options,f.deps);assert.equal(receipt.ok,true);assert.ok(!f.calls.some(c=>c[0]==='sql'&&/CREATE TABLE|UPDATE model_chat|DELETE FROM model_chat|count\(\*\) FROM model_chat/.test(c[1])));});
});
test('Revocation during CREATE prevents next pg_restore and ANALYZE in actual orchestration',async()=>fixture(async f=>{
 f.revokeOnCreate();await assert.rejects(restoreProduction(f.options,f.deps),/revoked/);assert.equal(f.calls.filter(c=>c.includes('pg_restore')).length,0);assert.ok(!f.calls.some(c=>c.includes('ANALYZE;')));assert.equal(f.calls.filter(c=>c.some(value=>typeof value==='string'&&value.startsWith('CREATE DATABASE'))).length,1);
}));
test('Revocation during pg_restore prevents ANALYZE; no later DB or storage publication starts',async()=>fixture(async f=>{
 const docker=f.deps.docker;f.deps.docker=async(args,options)=>{const result=await docker(args,options);if(args.includes('pg_restore'))f.revoke();return result;};await assert.rejects(restoreProduction(f.options,f.deps),/revoked/);assert.equal(f.calls.filter(c=>c.includes('pg_restore')).length,1);assert.ok(!f.calls.some(c=>c.includes('ANALYZE;')));
}));
test('Revocation while target overlay awaits prevents PostgreSQL up after operator files persist',async()=>fixture(async f=>{
 f.deps.chatTargetOverlay=async()=>{f.revoke();return'/owned-overlay';};await assert.rejects(restoreProduction(f.options,f.deps),/revoked/);assert.ok(!f.calls.some(c=>c[0]==='compose'&&c[1]==='up'));
}));
test('Unknown storage attempt writes a private failure receipt and never emits success/apps-started',async()=>fixture(async f=>{
 f.deps.restoreChatRecovery=async()=>{const failure=Error('unknown PUT');failure.chatRecoveryReceipt={state:'failed',phase:'put-object',sourceS3Mutated:false,sqlOutcome:'not-started',attemptedBuckets:['new-owned'],createdBuckets:['new-owned']};throw failure;};await assert.rejects(restoreProduction(f.options,f.deps),/unknown PUT/);const files=await readdir(path.join(f.directory,'recovery-receipts'));assert.equal(files.length,1);const receipt=JSON.parse(await readFile(path.join(f.directory,'recovery-receipts',files[0]),'utf8'));assert.equal(receipt.ok,false);assert.equal(receipt.chatStorage.phase,'put-object');assert.equal(receipt.applicationsStarted,false);assert.ok(!f.calls.some(c=>c[0]==='compose'&&c[1]==='start'));assert.ok(!f.calls.some(c=>c.some(v=>typeof v==='string'&&v.includes('DELETE FROM bridge_pairs'))));
}));
test('Full injected orchestrator retains stopped applications and success receipt with chat result; no Docker process runs',async()=>fixture(async f=>{
 const receipt=await restoreProduction(f.options,f.deps);assert.equal(receipt.ok,true);assert.equal(receipt.applicationsStarted,false);const files=await readdir(path.join(f.directory,'recovery-receipts'));assert.equal(files.length,1);const stored=JSON.parse(await readFile(path.join(f.directory,'recovery-receipts',files[0]),'utf8'));assert.equal(stored.chatStorage.objects,0);assert.ok(!f.calls.some(c=>c[0]==='compose'&&c[1]==='start'));
}));
