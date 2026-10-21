import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {applicationServices} from '../production/compose-client.mjs';
import {writeManifest,verifyBackup} from '../production/recovery-manifest.mjs';
import {restoreCheckpoints} from '../production/restore-checkpoints.mjs';
import {reserveRestoreSource,releaseSavedRestoreSource} from '../production/restore-reservations.mjs';
import {executeWebRestoreJob,acknowledgeRestoreJournal} from '../production/web-restore-job.mjs';
import {restoreRunnerApi} from '../production/web-restore-runner.mjs';
import contract from '../../services/shared/web-restore.cjs';
const image='sha256:'+'a'.repeat(64),configDigest='b'.repeat(64);
async function fixture(action){
 const root=await mkdtemp(path.join(tmpdir(),'nc-web-restore-fs-')),directory=path.join(root,'config'),backupRoot=path.join(root,'copies'),source=path.join(backupRoot,'one'),stateDirectory=path.join(root,'state');
 await mkdir(directory,{mode:0o700});await mkdir(backupRoot,{mode:0o700});await mkdir(source,{mode:0o700});await mkdir(path.join(source,'databases'),{mode:0o700});
 for(const name of ['catalog','rag'])await writeFile(path.join(source,'databases',name+'.dump'),'owned fixture '+name,{mode:0o600});
 for(const name of ['skills','projects','backups','runtime-artifacts'])await mkdir(path.join(source,'files',name),{recursive:true,mode:0o700});
 const metadata={createdAt:new Date().toISOString(),postgresMajor:16,postgresImage:image,images:Object.fromEntries(applicationServices.map(name=>[name,image])),quiesced:true,databases:['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C.UTF-8',ctype:'C.UTF-8',file:'databases/'+name+'.dump'}))};
 const {manifest,sha256}=await writeManifest(source,metadata),registry=path.join(root,'registry.json');await writeFile(registry,JSON.stringify({checkpoints:[{id:'own-copy',label:'Own complete checkpoint',source:'one',sha256}]}),{mode:0o600});
 const checkpoints=await restoreCheckpoints({directory,backupRoot,registry}),events=[],api=async(route,input)=>{events.push({route,input});return {ok:true};};
 const options={directory,backupRoot,stateDirectory,checkpoints,configuration:async()=>({configDigest,targetPrefix:'nc-restore'}),api};
 const job={id:randomUUID(),runner_id:randomUUID(),lease_id:randomUUID(),kind:'preview',state:'running',input:{requestKey:randomUUID(),checkpointId:'own-copy',checkpointSha256:sha256,targetProject:'nc-restore-own'}};
 const preview=async values=>({manifest:await verifyBackup(values.source,values.expectedHash)});
 try{await action({root,source,directory,backupRoot,stateDirectory,manifest,sha256,registry,options,job,events,preview});}finally{await rm(root,{recursive:true,force:true});}
}
const restoreJob=(job,preview)=>({...job,id:randomUUID(),lease_id:randomUUID(),kind:'restore',input:{requestKey:randomUUID(),previewId:job.id,digest:preview.digest,confirmation:'RESTORE '+preview.targetProject},preview});
test('Полный checkpoint требует отдельно сохранённый trusted SHA, а не digest произвольной описи',async()=>fixture(async f=>{
 assert.equal(f.options.checkpoints[0].sha256,f.sha256);await writeFile(f.registry,JSON.stringify({checkpoints:[{id:'bad',label:'Bad',source:'../private',sha256:f.sha256}]}),{mode:0o600});await assert.rejects(restoreCheckpoints({directory:f.directory,backupRoot:f.backupRoot,registry:f.registry}),/Небезопасная/);
}));
test('Symlink registry/source и лишние поля не становятся checkpoint paths из API',async()=>fixture(async f=>{
 await rm(f.registry);await symlink(path.join(f.source,'manifest.json'),f.registry);await assert.rejects(restoreCheckpoints({directory:f.directory,backupRoot:f.backupRoot,registry:f.registry}));
}));
test('Preview считает реальную файловую опись, exact SHA/digest и не вызывает restore',async()=>fixture(async f=>{
 let writes=0;const result=await executeWebRestoreJob(f.job,f.options,{preview:async values=>{assert.equal(await reserveRestoreSource(f.backupRoot,f.source,'other'),null);return f.preview(values);},restore:async()=>{writes++;}});
 assert.equal(result.state,'ready');assert.equal(writes,0);assert.equal(result.preview.checkpointSha256,f.sha256);assert.equal(result.preview.impact.databases.length,2);assert.equal(result.preview.impact.currentStackChanged,false);assert.equal(result.preview.impact.applicationsStarted,false);contract.previewResult(result.preview);
 const release=await reserveRestoreSource(f.backupRoot,f.source,'after');assert.ok(release);await release();await assert.rejects(lstat(path.join(f.stateDirectory,f.job.id+'.json')),{code:'ENOENT'});
}));
test('Изменённый dump блокирует preview и не публикует READY/SUCCEEDED',async()=>fixture(async f=>{
 await writeFile(path.join(f.source,'databases/rag.dump'),'bad',{mode:0o600});const result=await executeWebRestoreJob(f.job,f.options,{preview:f.preview});assert.equal(result.state,'failed');assert.equal(f.events.at(-1).input.state,'failed');assert.ok(!f.events.some(e=>e.input.state==='ready'||e.input.state==='succeeded'));
}));
test('Чужая reservation отклоняет запуск, не освобождая её при ошибке',async()=>fixture(async f=>{
 const release=await reserveRestoreSource(f.backupRoot,f.source,'different-owner');await assert.rejects(executeWebRestoreJob(f.job,f.options,{preview:f.preview}),/зарезервирована/);assert.equal(await reserveRestoreSource(f.backupRoot,f.source,'third-owner'),null);await release();
}));
test('Успех restore требует полную receipt, target и исходный SHA; приложения остаются остановлены',async()=>fixture(async f=>{
 const checked=await executeWebRestoreJob(f.job,f.options,{preview:f.preview}),job=restoreJob(f.job,checked.preview);let writes=0;
 const result=await executeWebRestoreJob(job,f.options,{restore:async values=>{await values.beforeMutation();writes++;await writeFile(path.join(f.root,'own-target'),'restored',{mode:0o600});return {ok:true,projectName:values.projectName,sha256:values.expectedHash,restoredAt:new Date().toISOString(),databases:2,durationMs:1,applicationsStarted:false};}});
 assert.equal(writes,1);assert.equal(result.state,'succeeded');assert.equal(result.receipt.applicationsStarted,false);assert.equal(await readFile(path.join(f.root,'own-target'),'utf8'),'restored');
}));
test('Смена config после проверки отклоняется до первой записи',async()=>fixture(async f=>{
 const checked=await executeWebRestoreJob(f.job,f.options,{preview:f.preview});let writes=0;
 await assert.rejects(executeWebRestoreJob(restoreJob(f.job,checked.preview),{...f.options,configuration:async()=>({configDigest:'d'.repeat(64),targetPrefix:'nc-restore'})},{restore:async()=>{writes++;}}),/изменилась/);assert.equal(writes,0);
}));
test('Отзыв разрешения между командами останавливает следующую запись',async()=>fixture(async f=>{
 const checked=await executeWebRestoreJob(f.job,f.options,{preview:f.preview});let revoked=false,writes=0;
 const result=await executeWebRestoreJob(restoreJob(f.job,checked.preview),{...f.options,api:async(route,body)=>{if(revoked&&route.endsWith('/pulse'))throw Error('revoked');return f.options.api(route,body);}},{restore:async values=>{await values.beforeMutation();writes++;revoked=true;await values.beforeMutation();writes++;}});
 assert.equal(writes,1);assert.equal(result.state,'failed');assert.ok(!f.events.some(e=>e.input.state==='succeeded'));
}));
test('Lost complete ACK retains durable exact result and reservation; replay never re-runs executor',async()=>fixture(async f=>{
 const checked=await executeWebRestoreJob(f.job,f.options,{preview:f.preview}),job=restoreJob(f.job,checked.preview);let writes=0,fail=true;
 const api=async(route,body)=>{await f.options.api(route,body);if(route.endsWith('/complete')&&fail){fail=false;throw Error('ACK lost');}return {ok:true};};
 await assert.rejects(executeWebRestoreJob(job,{...f.options,api},{restore:async values=>{await values.beforeMutation();writes++;return {ok:true,projectName:values.projectName,sha256:values.expectedHash,restoredAt:new Date().toISOString(),databases:2,durationMs:1,applicationsStarted:false};}}),/ACK lost/);
 const filename=path.join(f.stateDirectory,job.id+'.json'),journal=JSON.parse(await readFile(filename,'utf8'));assert.equal(journal.phase,'complete');assert.equal(journal.result.state,'succeeded');assert.equal(await reserveRestoreSource(f.backupRoot,f.source,'cannot-prune'),null);
 await acknowledgeRestoreJournal(filename,api);assert.equal(writes,1);const acknowledgements=f.events.filter(e=>e.route===`jobs/${job.id}/complete`);assert.equal(acknowledgements.length,2);assert.deepEqual(acknowledgements[0].input,acknowledgements[1].input);
 const release=await reserveRestoreSource(f.backupRoot,f.source,'can-prune');assert.ok(release);await release();
}));
test('Неполная fake-success receipt не приводит к SUCCEEDED',async()=>fixture(async f=>{
 const checked=await executeWebRestoreJob(f.job,f.options,{preview:f.preview});const result=await executeWebRestoreJob(restoreJob(f.job,checked.preview),f.options,{restore:async()=>({ok:true})});assert.equal(result.state,'failed');assert.ok(!f.events.some(e=>e.input.state==='succeeded'));
}));
test('Runner HTTP refuses credential redirects and public plaintext origins before sending token',async()=>{
 for(const url of ['http://example.com','https://user:pass@example.com','https://example.com/private'])assert.throws(()=>restoreRunnerApi(url,'a'.repeat(64)));
 let seen;const api=restoreRunnerApi('http://127.0.0.1:12345','a'.repeat(64),async(url,options)=>{seen={url,options};return Response.json({job:null});});assert.deepEqual(await api('claim',{runnerId:randomUUID()}),{job:null});assert.equal(seen.options.redirect,'error');assert.ok(seen.url.endsWith('/internal/maintenance/restore/claim'));
});

test('Late reservation release cannot clear a new owner after source ABA',async()=>fixture(async f=>{
 const old=await reserveRestoreSource(f.backupRoot,f.source,'old');assert.ok(old);const token=old.token;await old();const next=await reserveRestoreSource(f.backupRoot,f.source,'next');assert.ok(next);
 await assert.rejects(releaseSavedRestoreSource(f.backupRoot,f.source,'old',token),/другому/);assert.equal(await reserveRestoreSource(f.backupRoot,f.source,'third'),null);await next();
}));
