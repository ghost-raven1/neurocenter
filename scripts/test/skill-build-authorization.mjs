import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,stat,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {authorizationFixture,causalAuthorizationRed,deadline,deferred,settled,until,releaseCancellationLease,inputHashes,fileInventory,output,phase,root,sha} from './skill-build-authorization.fixture.mjs';

assert.ok(process.platform!=='win32'&&Number(process.versions.node.split('.')[0])>=24,'This native acceptance requires Node24/POSIX.');
const initial=await inputHashes();await mkdir(output,{recursive:true});const runDirectory=await mkdtemp(path.join(output,phase+'-'));
const receipt={schemaVersion:1,phase,startedAt:new Date().toISOString(),inputHashes:initial,cases:[],cleanupErrors:[],limits:[
    'Actual Service.execute and public Service.importAsset, real PostgreSQL, native Skills controller/storage and immutable source receipts.',
    'Skills transport routes in-process; middleware and external authorization are not accepted. Feature HTTP uses the real evaluator and uncached feature client.',
    'Skill source compiler is real data-only production code; catalog-plugins builder is pinned as an input but no JS/native builder is executed.',
    'A delegated storage audit delivery records real generated events; external audit delivery, browser, OpenCode, other OS and production are not accepted.',
]};
const serialize=error=>({name:error.name,message:error.message,code:error.code,status:error.getStatus?.()??error.status});
const exists=filename=>stat(filename).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});

async function one(mode,policy){
    const label=mode+'-'+policy,evidence={path:mode,policy,sqlTimeouts:[],nativeImports:[],auditEvents:[]};let f,native,service,raw,blocker,executing,pid,prepared,stageRoot,roleSave,publicAsset,released=false,unlockDone=false,sequence=0;
    const fenced=deferred(),proceed=deferred(),nativeEntered=deferred(),nativeWritten=deferred(),allowNative=deferred(),allowAck=deferred();
    const unlock=async()=>{if(blocker&&!unlockDone){await blocker.query('ROLLBACK');unlockDone=true;}};
    try{
        f=await authorizationFixture(label,runDirectory);const slug='owned-auth-'+mode+'-'+policy+'-'+randomUUID().slice(0,8),nativeId='common/'+slug;
        native=await f.skillSources(slug);
        const storage=native.skills.storage,outbox=storage.auditOutbox,deliver=outbox.deliver.bind(outbox);
        outbox.deliver=async events=>{evidence.auditEvents.push(...structuredClone(events));return deliver(events);};
        await native.skills.onApplicationBootstrap();const before=await fileInventory(path.join(native.folder,'native'));
        const importNative=native.skills.importAssetSkill.bind(native.skills);
        native.skills.importAssetSkill=async(...args)=>{
            const event={order:++sequence,actor:args[2],requestKey:args[1],completed:false};evidence.nativeImports.push(event);nativeEntered.resolve(event);
            if(policy==='role-lock')await allowNative.promise;
            const value=await importNative(...args);event.completed=true;event.nativeVersion=value.meta.version;nativeWritten.resolve(value);
            if(policy==='inflight-flag')await allowAck.promise;return value;
        };
        const source={...native.source,prepareLocalSkill:async(...args)=>{prepared=await native.source.prepareLocalSkill(...args);return prepared;}};
        service=f.createService(source);const writer=f.writer(),repository=new(f.load('package-build/package-build.repository.js').PackageBuildRepository)(f.pool,client=>service.discardLease(client));service.repository=repository;
        const recordQuery=client=>new Proxy(client,{get(target,key){if(key==='query')return async(sql,...args)=>{try{return await target.query(sql,...args);}catch(error){if(['55P03','57014'].includes(error.code))evidence.sqlTimeouts.push(serialize(error));throw error;}};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const config={kind:'skill',name:'Owned '+slug,description:'Authorization after publication lock',tags:[],targets:[],source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: '+slug+'\ndescription: Authorization after publication lock\n---\n\nOwned authorization source.'}]}};
        const key=randomUUID(),actor={email:f.actor,activeRole:'Главный админ'};let build;
        const secondActor={email:'authorization-second-admin@example.test',activeRole:'Главный админ'};
        await service.access.save({email:secondActor.email,displayName:'Owned second administrator',isMainAdmin:true},actor);
        stageRoot=path.join(f.own,'stage');await mkdir(stageRoot,{recursive:true,mode:0o700});
        blocker=await f.pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:skill:'+nativeId]);
        const blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        if(mode==='build'){
            raw=await writer.connect();await raw.query('SET statement_timeout=0');await raw.query('SET lock_timeout=0');await raw.query('SELECT pg_advisory_lock(72465395)');pid=Number((await raw.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            const lease=recordQuery(raw);service.lease=lease;service.releaseLease=destroy=>{if(!released){released=true;raw.release(destroy);}};
            const begin=repository.beginPublication.bind(repository);repository.beginPublication=async(...args)=>{await begin(...args);fenced.resolve();await proceed.promise;};
            const queued=await repository.enqueue(f.actor,key,'owned-auth-'+key,config);build=await repository.takeQueued(lease);assert.equal(build.id,queued.id);
            executing=settled(service.execute(build,stageRoot));await deadline(fenced.promise,'actual committed skill fence');
            evidence.fence=(await f.observer.query('SELECT id,state,publication_started_at FROM tool_build_jobs WHERE id=$1',[build.id])).rows[0];assert.ok(evidence.fence.publication_started_at);proceed.resolve();
        }else{
            const built=await f.load('package-build/build-skill.js').buildSkillAsset(config,stageRoot),descriptor=built.asset.source;publicAsset=built.asset;assert.equal(descriptor.type,'archive');
            const blobs=new(f.load('asset-sources/asset-blob-store.js').AssetBlobStore)(f.pool,path.join(native.folder,'blobs'));
            await blobs.ingestLocal([{archivePath:built.sourceFile.archivePath,sha256:descriptor.sha256,bytes:descriptor.bytes,filename:descriptor.sha256+'.source'}],key);
            const connect=writer.connect.bind(writer);writer.connect=async()=>{const client=await connect();raw=client;released=false;pid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);const proxy=recordQuery(client);return new Proxy(proxy,{get(target,name){if(name==='release')return destroy=>{released=true;client.release(destroy);};return Reflect.get(target,name);}});};
            service.pool=writer;executing=settled(service.importAsset(actor,{requestKey:key,asset:built.asset}));
        }
        evidence.edge=await until(async()=>{if(!pid)return false;const row=(await f.observer.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0];return row.blockers.includes(blockerPid)?{waiter:pid,blocker:blockerPid,blockers:row.blockers}:false;},'actual skill publication advisory lock wait',3000);
        const blockedAt=performance.now();assert.ok(prepared);evidence.preparedRequestKey=prepared.item.requestKey;
        const absent=await settled(native.skills.inspectAssetSkill(nativeId));assert.equal(absent.ok,false);assert.equal(absent.error.getStatus(),404);assert.deepEqual(await fileInventory(path.join(native.folder,'native')),before);
        if(policy==='role'){
            evidence.roleRevoke=await service.access.save({email:f.actor,isMainAdmin:false},secondActor);
            evidence.roleAudit=(await f.observer.query("SELECT actor,action,resource_id,before_state,after_state FROM security_events WHERE actor=$1 AND action='user.update' AND resource_id=$2",[secondActor.email,f.actor])).rows;
            assert.equal(evidence.roleRevoke.isMainAdmin,false);assert.equal(evidence.roleAudit.length,1);assert.equal(evidence.roleAudit[0].after_state.isMainAdmin,false);
        }
        if(policy==='flag')f.flags.setBuilds(false);
        const role=(await f.observer.query('SELECT is_main_admin FROM platform_users WHERE email=$1',[f.actor])).rows[0],evaluated=await f.flags.read();
        evidence.effectivePolicy={isMainAdmin:role.is_main_admin,tool_builds:evaluated.flags.tool_builds,tool_catalog:evaluated.flags.tool_catalog};
        assert.equal(evaluated.flags.tool_catalog,true);assert.equal(role.is_main_admin,policy!=='role');assert.equal(evaluated.flags.tool_builds,policy!=='flag');
        evidence.policyOrder=++sequence;await unlock();evidence.revokeBeforeUnlock=true;evidence.blockedMs=performance.now()-blockedAt;assert.ok(evidence.blockedMs<4500,'Policy change must precede the B11 deadline.');
        if(policy==='role-lock'){
            await deadline(nativeEntered.promise,'native dispatch holding authorization transaction');let saved;
            roleSave=settled(service.access.save({email:f.actor,isMainAdmin:false},secondActor)).then(value=>{saved=value;return value;});
            evidence.roleShareEdge=await until(async()=>{
                const rows=(await f.observer.query('SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rows;
                const row=rows.find(item=>Number(item.pid)!==pid);return row?{waiter:Number(row.pid),blocker:pid,blockers:row.blockers}:false;
            },'actual AccessDb.save blocked by publication role SHARE',3000);
            assert.equal(saved,undefined);assert.equal((await f.observer.query('SELECT is_main_admin FROM platform_users WHERE email=$1',[f.actor])).rows[0].is_main_admin,true);
            evidence.revokePendingBeforeNative=true;allowNative.resolve();
        }else if(policy==='inflight-flag'){
            await deadline(nativeWritten.promise,'real native journal write before ACK');const snapshot=await native.skills.inspectAssetSkill(nativeId);
            assert.equal(snapshot.importRequestKey,evidence.preparedRequestKey);assert.equal(snapshot.version,1);evidence.nativeBeforeOff=snapshot;
            f.flags.setBuilds(false);const fresh=await f.flags.read();assert.equal(fresh.flags.tool_builds,false);assert.equal(fresh.flags.tool_catalog,true);
            evidence.inflightOff={tool_builds:fresh.flags.tool_builds,tool_catalog:fresh.flags.tool_catalog,order:++sequence};allowAck.resolve();
        }
        const ended=await deadline(executing,'actual skill operation after unlock',10000);evidence.operation=ended.ok?{ok:true,result:ended.value}:{ok:false,error:serialize(ended.error)};
        if(roleSave){
            const saved=await deadline(roleSave,'role revoke after publication COMMIT');assert.equal(saved.ok,true);assert.equal(saved.value.isMainAdmin,false);evidence.roleRevokeAfterCommit=saved.value;
            evidence.roleAuditAfterCommit=(await f.observer.query("SELECT actor,action,resource_id,after_state FROM security_events WHERE actor=$1 AND action='user.update' AND resource_id=$2",[secondActor.email,f.actor])).rows;assert.equal(evidence.roleAuditAfterCommit.length,1);assert.equal(evidence.roleAuditAfterCommit[0].after_state.isMainAdmin,false);
        }
        if(build){const row=await repository.get(build.id);evidence.job={id:row.id,state:row.state,result:row.result,error:row.error,publicationStartedAt:row.publication_started_at};assert.ok(['SUCCEEDED','FAILED'].includes(row.state));}
        const inspect=await settled(native.skills.inspectAssetSkill(nativeId));if(inspect.ok)evidence.native={exists:true,...inspect.value};else{assert.equal(inspect.error.getStatus(),404);evidence.native={exists:false};}
        await storage.flushSkillAudit();
        evidence.nativeFiles=await fileInventory(path.join(native.folder,'native'));
        evidence.sql={versions:(await f.observer.query('SELECT * FROM asset_source_versions WHERE external_id=$1',[prepared.asset.id])).rows,receipts:(await f.observer.query('SELECT * FROM asset_source_receipts WHERE external_id=$1',[prepared.asset.id])).rows,jobCount:Number((await f.observer.query('SELECT count(*)::int AS count FROM tool_build_jobs')).rows[0].count)};
        const descriptor=prepared.asset.source,bytes=await readFile(path.join(native.folder,'blobs',descriptor.sha256+'.blob'));assert.equal(bytes.length,descriptor.bytes);assert.equal(sha(bytes),descriptor.sha256);assert.deepEqual(JSON.parse(bytes).files,config.source.files);evidence.retainedSource={sha256:sha(bytes),bytes:bytes.length,exact:true};
        evidence.flagsRequests=f.flags.requests;assert.deepEqual(evidence.sqlTimeouts,[],'A publication timeout is not an authorization race witness.');
        if(mode==='build')assert.equal(await exists(path.join(stageRoot,build.id)),false);else{assert.equal(evidence.sql.jobCount,0);await rm(stageRoot,{recursive:true});}evidence.stageRemoved=true;
        if(policy==='healthy'||policy==='role-lock'){
            assert.equal(ended.ok,true);if(build)assert.equal(evidence.job.state,'SUCCEEDED');assert.equal(evidence.native.exists,true);assert.equal(evidence.native.importRequestKey,prepared.item.requestKey);assert.equal(evidence.nativeImports.filter(event=>event.completed).length,1);
            assert.ok(evidence.auditEvents.some(event=>event.resourceId===nativeId),'Healthy control must observe actual storage audit.');assert.equal(evidence.sql.versions.length,1);assert.equal(evidence.sql.receipts.length,1);assert.equal(evidence.sql.receipts[0].native_id,nativeId);assert.equal(evidence.sql.receipts[0].native_version,evidence.native.version);assert.equal(evidence.sql.receipts[0].native_hash,evidence.native.hash);
            const current=evidence.sql.receipts[0];assert.equal(current.descriptor_sha256,prepared.sha256);assert.equal(current.external_id,prepared.asset.id);assert.equal(current.asset_version,prepared.asset.version);for(const field of ['repository','external_id','asset_version','descriptor_sha256','native_id','native_version','native_hash'])assert.deepEqual(evidence.sql.versions[0][field],current[field]);
        }else if(policy==='inflight-flag'){
            assert.equal(evidence.native.exists,true);assert.equal(evidence.native.version,1);assert.equal(evidence.native.importRequestKey,evidence.preparedRequestKey);assert.equal(evidence.sql.versions.length,0);assert.equal(evidence.sql.receipts.length,0);
            if(build){assert.equal(evidence.job.state,'FAILED');assert.equal(evidence.job.result,null);assert.match(evidence.job.error,/отключена/);}else{assert.equal(ended.ok,false);assert.equal(evidence.operation.error.status,403);}
            evidence.noFalseSuccessBeforeRetry=true;const firstImports=evidence.nativeImports.length,firstAudit=evidence.auditEvents.length,nativeBeforeRetry=evidence.native;
            assert.equal(firstImports,1);assert.equal(firstAudit,1);f.flags.setBuilds(true);assert.equal((await f.flags.read()).flags.tool_builds,true);
            const retryKey=randomUUID();assert.notEqual(retryKey,key);let retryResult;
            if(mode==='build'){
                const queued=await repository.enqueue(f.actor,retryKey,'owned-auth-'+retryKey,config),retryRow=await repository.takeQueued(service.lease);assert.equal(retryRow.id,queued.id);
                executing=settled(service.execute(retryRow,stageRoot));const retryEnded=await deadline(executing,'explicit build retry with retained native journal',10000);assert.equal(retryEnded.ok,true);const retry=await repository.get(retryRow.id);assert.equal(retry.state,'SUCCEEDED',retry.error);retryResult=retry.result;evidence.retryJob={id:retry.id,state:retry.state};
            }else{executing=settled(service.importAsset(actor,{requestKey:retryKey,asset:publicAsset}));const retryEnded=await deadline(executing,'explicit import retry with retained native journal',10000);assert.equal(retryEnded.ok,true);retryResult=retryEnded.value;}
            const restored=await native.skills.inspectAssetSkill(nativeId);await storage.flushSkillAudit();assert.deepEqual(restored,nativeBeforeOffShape(nativeBeforeRetry));assert.equal(restored.version,1);assert.equal(prepared.item.requestKey,evidence.preparedRequestKey);
            assert.equal(evidence.nativeImports.length,firstImports);assert.equal(evidence.auditEvents.length,firstAudit);assert.deepEqual(await fileInventory(path.join(native.folder,'native')),evidence.nativeFiles);
            const versions=(await f.observer.query('SELECT * FROM asset_source_versions WHERE external_id=$1',[prepared.asset.id])).rows,receipts=(await f.observer.query('SELECT * FROM asset_source_receipts WHERE external_id=$1',[prepared.asset.id])).rows;
            assert.equal(versions.length,1);assert.equal(receipts.length,1);const current=receipts[0];assert.equal(current.native_id,nativeId);assert.equal(current.native_version,1);assert.equal(current.native_hash,restored.hash);assert.equal(current.descriptor_sha256,retryResult.sourceSha256);assert.equal(current.asset_version,retryResult.sourceVersion);assert.equal(current.external_id,retryResult.assetId);assert.equal(retryResult.version,1);
            for(const field of ['repository','external_id','asset_version','descriptor_sha256','native_id','native_version','native_hash'])assert.deepEqual(versions[0][field],current[field]);
            const retained=await readFile(path.join(native.folder,'blobs',prepared.asset.source.sha256+'.blob'));assert.equal(sha(retained),evidence.retainedSource.sha256);
            if(build)assert.equal(await exists(path.join(stageRoot,evidence.retryJob.id)),false);
            evidence.retry={requestKey:retryKey,result:retryResult,native:restored,stablePublicationKey:prepared.item.requestKey,noAdditionalNativeWrite:true,noAdditionalAudit:true,immutableReceipt:{assetId:current.external_id,sourceVersion:current.asset_version,sourceSha256:current.descriptor_sha256,nativeId:current.native_id,nativeVersion:current.native_version,nativeHash:current.native_hash},nativeFilesUnchanged:true,sourceBytesUnchanged:true};
        }else{
            assert.equal(evidence.native.exists,false,'Revoked policy reached native skill write');assert.equal(evidence.nativeImports.length,0);assert.equal(evidence.auditEvents.length,0);assert.deepEqual(evidence.nativeFiles,before);assert.equal(evidence.sql.versions.length,0);assert.equal(evidence.sql.receipts.length,0);
            if(build){assert.equal(evidence.job.state,'FAILED');assert.equal(evidence.job.result,null);assert.match(evidence.job.error,/отозван|отключена/);}else{assert.equal(ended.ok,false);assert.equal(evidence.operation.error.status,403);}
        }
        evidence.ok=true;
    }catch(error){evidence.failure=serialize(error);receipt.failures??=[];receipt.failures.push({label,...evidence.failure});}
    finally{
        proceed.resolve();allowNative.resolve();allowAck.resolve();try{await unlock();}catch(error){receipt.cleanupErrors.push({label,resource:'blocker rollback',...serialize(error)});}
        if(executing)try{await deadline(executing,'owned skill operation cleanup',5000);}catch(error){receipt.cleanupErrors.push({label,resource:'operation drain',...serialize(error)});if(f&&pid)try{await f.observer.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',[pid]);await deadline(executing,'cancelled owned operation cleanup',5000);}catch(failure){receipt.cleanupErrors.push({label,resource:'operation cancel',...serialize(failure)});}}
        if(blocker)try{blocker.release();}catch(error){receipt.cleanupErrors.push({label,resource:'blocker release',...serialize(error)});}
        if(service){service.lease=undefined;service.releaseLease=undefined;}
        if(raw&&!released)try{released=true;await releaseCancellationLease(raw,mode==='build');}catch(error){receipt.cleanupErrors.push({label,resource:'lease release',...serialize(error)});}
        if(roleSave)try{await deadline(roleSave,'owned pending role save cleanup',5000);}catch(error){receipt.cleanupErrors.push({label,resource:'role save drain',...serialize(error)});}
        if(mode==='import'&&stageRoot)try{await rm(stageRoot,{recursive:true,force:true});}catch(error){receipt.cleanupErrors.push({label,resource:'owned source staging',...serialize(error)});}
        if(f)try{const final=await f.close();evidence.cleanup={ownDatabaseDropped:final.ownDatabaseDropped,originalDatabasesPreserved:final.originalDatabasesPreserved,errors:final.cleanupErrors};if(!final.ownDatabaseDropped||!final.originalDatabasesPreserved||final.cleanupErrors.length)throw Error('Owned fixture cleanup failed.');}catch(error){receipt.cleanupErrors.push({label,resource:'fixture',...serialize(error)});}
        receipt.cases.push(evidence);
    }
}
function nativeBeforeOffShape({exists:_exists,...snapshot}){return snapshot;}
try{for(const mode of ['build','import'])for(const policy of ['role','flag','healthy',...(phase==='candidate'?['role-lock','inflight-flag']:[])])await one(mode,policy);}
catch(error){receipt.failures??=[];receipt.failures.push({label:'QA initialization',...serialize(error)});}
finally{
    try{receipt.finalInputHashes=await inputHashes();assert.deepEqual(receipt.finalInputHashes,initial);}catch(error){receipt.cleanupErrors.push({resource:'final source proof',...serialize(error)});}
    receipt.finishedAt=new Date().toISOString();receipt.causalRed=causalAuthorizationRed(receipt);receipt.expectedCases=phase==='candidate'?10:6;receipt.ok=receipt.cases.length===receipt.expectedCases&&receipt.cases.every(item=>item.ok)&&!receipt.failures?.length&&!receipt.cleanupErrors.length;
    const filename=path.join(runDirectory,'receipt.json');await writeFile(filename,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({ok:receipt.ok,causalRed:receipt.causalRed,cases:receipt.cases.length,receipt:path.relative(root,filename),sha256:sha(await readFile(filename))}));if(!receipt.ok)process.exitCode=1;
}
