import assert from 'node:assert/strict';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicationDeadlineFixture,skillDeadlineFixture,retainedArchiveControl,deadline,deferred,settled,until,sha,saveDeadlineReceipt,isPublicationDeadlineCausalRed,phase,assertTimeouts,showTimeouts,deadlineHelperProof} from './tool-build-publication-deadline.fixture.mjs';

const directory=fileURLToPath(new URL('./',import.meta.url));
const inputs=['tool-build-publication-deadline.mjs','tool-build-publication-deadline.fixture.mjs','tool-build-version-cas.fixture.mjs',
    'package-publication-rollback.fixture.mjs','tool-build-cancellation.fixture.mjs','tool-build-cancellation-lease.mjs','owned-postgres.fixture.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(inputs.map(async file=>[file,sha(await readFile(path.join(directory,file)))])));
const initialHashes=await hashes(),archives=await retainedArchiveControl(),helperProof=await deadlineHelperProof();
const receipt={schemaVersion:1,startedAt:new Date().toISOString(),scope:'Actual publishBuiltTool SQL lock deadline; finite baseline diagnostic',
    phase,helperProof,watchdogMs:8000,productBudgets:{lockMs:5000,statementMs:30000},harnessHashes:initialHashes,cases:[],failures:[],cleanupErrors:[],archiveControl:{receipt:archives.receipt,receiptSha256:archives.receiptSha256,before:archives.before},
    limits:['Actual helper and real source SQL/blob bytes; flags/events are controlled loopback services.',
        'Tool lock cases invoke the actual helper; the skill control invokes actual Service.execute. Tool worker/next-queue continuation is separate.',
        'The prior root builder archives are immutable read-only controls, not archives produced by this inline seed.']};

async function one(boundary,{lockMs=0,statementMs=0,expectedCode='55P03',label=boundary}={}){
    let f,blocker,publishing,timer,unlocked=false,result;
    const evidence={boundary,label,inherited:{lockMs,statementMs}};
    const unlock=async()=>{if(!blocker||unlocked)return;await blocker.query('ROLLBACK');unlocked=true;};
    try{
        f=await publicationDeadlineFixture();const item=await f.seed(),before=await f.snapshot(item),build=await f.build(item);
        // Remove the old CAS fixture's 10-second test cap: the product must supply its own local budget.
        await f.lease.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)",[statementMs+'ms',lockMs+'ms']);
        evidence.initialTimeouts=await f.show(f.lease);assertTimeouts(evidence.initialTimeouts,lockMs,statementMs);
        evidence.fence=await f.committedRow(build.row.id);assert.equal(evidence.fence.state,'RUNNING');assert.ok(evidence.fence.publication_started_at);
        blocker=await f.client();await blocker.query('BEGIN');
        if(boundary==='native-row')await blocker.query('SELECT id FROM ai_plugins WHERE id=$1 FOR UPDATE',[item.card.id]);
        else await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[boundary==='asset-advisory'?'asset-management:plugin:'+item.card.id:'publication:dependency-graph']);
        const trace=f.instrument(boundary,item),started=performance.now();
        publishing=settled(f.publish(item,build,trace.client)).then(value=>{result=value;return {finished:true,result:value,elapsedMs:performance.now()-started};});
        evidence.edge=await f.blocking(f.leasePid,await f.pid(blocker));
        evidence.insideBeforeBlockedQuery=trace.inside;assert.equal(trace.inside.length,1);
        if(phase==='candidate')assertTimeouts(trace.inside[0].settings,lockMs?Math.min(lockMs,5000):5000,statementMs?Math.min(statementMs,30000):30000);
        assert.deepEqual(await f.snapshot(item),before);evidence.sourceBWhileBlocked=await f.sourceB(item);
        const cancel=await f.service.cancel(f.actor,build.row.id);
        evidence.actualDeleteWhileBlocked={state:cancel.state,publicationStartedAt:cancel.publicationStartedAt};
        assert.equal(cancel.state,'RUNNING');assert.ok(cancel.publicationStartedAt);
        const watchdog=deferred(),observed=performance.now();
        timer=setTimeout(()=>watchdog.resolve({finished:false,pendingAtDeadline:result===undefined,observedBlockedMs:performance.now()-observed}),8000);
        const outcome=await Promise.race([publishing,watchdog.promise]);clearTimeout(timer);timer=undefined;
        evidence.finishedWhileBlockerHeld=outcome.finished===true;evidence.outcome=outcome.finished?
            {ok:outcome.result.ok,errorCode:outcome.result.error?.code,errorMessage:outcome.result.error?.message,elapsedMs:outcome.elapsedMs}:
            {pendingAtDeadline:outcome.pendingAtDeadline,observedBlockedMs:outcome.observedBlockedMs};
        if(!outcome.finished)evidence.edgeAtWatchdog=await f.blocking(f.leasePid,await f.pid(blocker));
        evidence.rowBeforeUnlock=await f.committedRow(build.row.id);
        assert.deepEqual(await f.snapshot(item),before);evidence.oldSnapshotExactBeforeUnlock=true;
        // Every path releases only its own blocker before awaiting the pending production call.
        await unlock();const final=await deadline(publishing,'publisher after owned blocker release',5000);
        evidence.afterHelper={ok:final.result.ok,errorCode:final.result.error?.code,row:await f.committedRow(build.row.id)};
        evidence.restoredTimeouts=await f.show(f.lease);assertTimeouts(evidence.restoredTimeouts,lockMs,statementMs);
        const after=await f.snapshot(item);f.immutable(before,after);evidence.immutableVersion1Preserved=true;
        evidence.sourceBAfter=await f.sourceB(item);assert.deepEqual(evidence.sourceBAfter,evidence.sourceBWhileBlocked);
        evidence.rootArchivesAfter=await archives.verify();evidence.sqlCalls=trace.calls;
        evidence.catalogVersionAfter=after.cards[0].version;
        if(outcome.finished){assert.equal(outcome.result.ok,false);assert.equal(outcome.result.error.code,expectedCode);assert.deepEqual(after,before);}
        assert.equal(outcome.finished,true,'Publication stayed pending through the finite 8-second observation while its committed fence prevented cancellation.');
    }catch(error){evidence.failure={name:error.name,message:error.message,code:error.code};receipt.failures.push({boundary,...evidence.failure});}
    finally{
        clearTimeout(timer);
        if(f){
            try{await unlock();}catch(error){receipt.cleanupErrors.push({boundary,resource:'blocker rollback',message:error.message});}
            if(publishing)try{await deadline(publishing,'publisher cleanup',5000);}catch(error){
                receipt.cleanupErrors.push({boundary,resource:'publisher drain',message:error.message});
                try{await f.observer.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',[f.leasePid]);await deadline(publishing,'cancelled publisher cleanup',3000);}
                catch(failure){receipt.cleanupErrors.push({boundary,resource:'owned publisher cancel',message:failure.message});}
            }
            if(blocker)try{await f.release(blocker);}catch(error){receipt.cleanupErrors.push({boundary,resource:'blocker release',message:error.message});}
            try{const cleanup=await f.close();evidence.fixtureReceipt=path.join(f.folder,'receipt.json');
                evidence.cleanup={ownDatabaseDropped:cleanup.ownDatabaseDropped,originalDatabasesPreserved:cleanup.originalDatabasesPreserved,errors:cleanup.cleanupErrors};
                assert.equal(cleanup.ownDatabaseDropped,true);assert.equal(cleanup.originalDatabasesPreserved,true);assert.deepEqual(cleanup.cleanupErrors,[]);
            }catch(error){receipt.cleanupErrors.push({boundary,resource:'fixture',message:error.message});}
        }
        receipt.cases.push(evidence);
    }
}
async function successfulCommit(){
    let f;const evidence={label:'Actual successful publication COMMIT restores original GUCs'};
    try{
        f=await publicationDeadlineFixture();const item=await f.seed(),before=await f.snapshot(item),build=await f.build(item);
        await f.lease.query('SET statement_timeout=0');await f.lease.query('SET lock_timeout=0');evidence.initialTimeouts=await f.show(f.lease);
        const trace=f.instrument('asset-advisory',item);await f.publish(item,build,trace.client);
        assert.equal(trace.inside.length,1);assertTimeouts(trace.inside[0].settings,5000,30000);evidence.insideBeforePublication=trace.inside;
        evidence.restoredTimeouts=await f.show(f.lease);assertTimeouts(evidence.restoredTimeouts,0,0);
        const after=await f.snapshot(item);f.immutable(before,after);evidence.row=await f.committedRow(build.row.id);
        assert.equal(after.cards[0].version,2);assert.equal(evidence.row.state,'SUCCEEDED');assert.equal(evidence.row.result.version,2);
        evidence.sourceB=await f.sourceB(item);evidence.rootArchivesAfter=await archives.verify();evidence.ok=true;
    }catch(error){evidence.failure={name:error.name,message:error.message,code:error.code};receipt.failures.push({label:evidence.label,...evidence.failure});}
    finally{if(f)try{const close=await f.close();evidence.cleanup={ownDatabaseDropped:close.ownDatabaseDropped,originalDatabasesPreserved:close.originalDatabasesPreserved,errors:close.cleanupErrors};assert.ok(close.ownDatabaseDropped&&close.originalDatabasesPreserved&&!close.cleanupErrors.length);}
        catch(error){receipt.cleanupErrors.push({label:evidence.label,message:error.message});}receipt.cases.push(evidence);}
}

async function skillTimeout(){
    let f,raw,blocker,service,executing,timer,pid,released=false,prepared;
    const evidence={label:'Actual skill Service.execute deadline preserves source, skips native write and records FAILED'},proceed=deferred(),fenced=deferred();
    const unlock=async()=>{if(blocker){await blocker.query('ROLLBACK');}};
    try{
        f=await skillDeadlineFixture();const slug='owned-deadline-'+randomUUID().slice(0,8),native=await f.skillSources(slug),writer=f.writer();raw=await writer.connect();
        await raw.query('SET statement_timeout=0');await raw.query('SET lock_timeout=0');evidence.initialTimeouts=await showTimeouts(raw);assertTimeouts(evidence.initialTimeouts,0,0);
        await raw.query('SELECT pg_advisory_lock(72465395)');pid=Number((await raw.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        let nativePublishCalls=0,sqlError;const inside=[];
        const lease=new Proxy(raw,{get(target,key){if(key==='query')return async(sql,...args)=>{
            const text=typeof sql==='string'?sql:sql.text;
            if(!inside.length&&text.includes('pg_advisory_xact_lock')&&args[0]?.[0]==='asset-management:skill:common/'+slug)inside.push({sql:text,settings:await showTimeouts(target)});
            try{return await target.query(sql,...args);}catch(error){if(['55P03','57014'].includes(error.code))sqlError={code:error.code,message:error.message};throw error;}
        };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const source={...native.source,prepareLocalSkill:async(...args)=>{prepared=await native.source.prepareLocalSkill(...args);return prepared;},
            publishLocalSkill:async(...args)=>{nativePublishCalls++;return native.source.publishLocalSkill(...args);}};
        service=f.createService(source);const repository=new(f.load('package-build/package-build.repository.js').PackageBuildRepository)(f.pool,client=>service.discardLease(client));
        service.repository=repository;service.lease=lease;service.releaseLease=destroy=>{if(!released){released=true;raw.release(destroy);}};
        const begin=repository.beginPublication.bind(repository);repository.beginPublication=async(...args)=>{await begin(...args);fenced.resolve();await proceed.promise;};
        const config={kind:'skill',name:'Owned '+slug,description:'Skill deadline regression',tags:[],targets:[],source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: '+slug+'\ndescription: Skill deadline regression\n---\n\nOwned deadline source.'}]}};
        const queued=await repository.enqueue(f.actor,randomUUID(),'deadline-'+slug,config),row=await repository.takeQueued(lease);assert.equal(row.id,queued.id);
        const stageRoot=path.join(native.folder,'owned-build-staging');await mkdir(stageRoot,{mode:0o700});
        executing=settled(service.execute(row,stageRoot)).then(result=>({finished:true,result}));
        await deadline(fenced.promise,'real skill beginPublication COMMIT',4000);
        evidence.fence=(await f.observer.query('SELECT id,state,publication_started_at FROM tool_build_jobs WHERE id=$1',[row.id])).rows[0];assert.ok(evidence.fence.publication_started_at);
        blocker=await f.pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:skill:common/'+slug]);
        const blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);proceed.resolve();
        evidence.edge=await until(async()=>{const blockers=(await f.observer.query('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0].blockers;return blockers.includes(blockerPid)?{waiter:pid,blocker:blockerPid,blockers}:false;},'real skill publication asset wait');
        assert.equal(inside.length,1);assertTimeouts(inside[0].settings,5000,30000);evidence.insideBeforeBlockedQuery=inside;
        const watchdog=deferred();timer=setTimeout(()=>watchdog.resolve({finished:false}),8000);const ended=await Promise.race([executing,watchdog.promise]);clearTimeout(timer);timer=undefined;
        assert.equal(ended.finished,true,'Actual skill worker must finish while the blocker is held.');assert.equal(ended.result.ok,true);assert.equal(sqlError?.code,'55P03');evidence.sqlError=sqlError;
        const final=await repository.get(row.id);assert.equal(final.state,'FAILED');assert.equal(final.result,null);assert.match(final.error,/Исходники сохранены/);assert.match(final.error,/новым запросом/);evidence.worker={state:final.state,error:final.error};
        const cancel=await service.cancel({email:f.actor,activeRole:'Главный админ'},row.id);assert.equal(cancel.state,'FAILED');evidence.actualDeleteAfterFailure=cancel.state;
        assert.equal(nativePublishCalls,0);const absent=await settled(native.skills.getSkill('common/'+slug));assert.equal(absent.ok,false);assert.equal(absent.error.getStatus(),404);evidence.nativeSkillWritten=false;
        assert.equal((await f.observer.query('SELECT count(*)::int AS count FROM asset_source_versions WHERE external_id=$1',[prepared.asset.id])).rows[0].count,0);
        assert.equal((await f.observer.query('SELECT count(*)::int AS count FROM asset_source_receipts WHERE external_id=$1',[prepared.asset.id])).rows[0].count,0);
        const expected=prepared.asset.source;assert.equal(expected.type,'archive');const bytes=await readFile(path.join(native.folder,'blobs',expected.sha256+'.blob'));
        assert.equal(bytes.length,expected.bytes);assert.equal(sha(bytes),expected.sha256);assert.deepEqual(JSON.parse(bytes).files,config.source.files);
        evidence.retainedSource={sha256:sha(bytes),bytes:bytes.length};await assert.rejects(stat(path.join(stageRoot,row.id)),error=>error.code==='ENOENT');evidence.stageRemoved=true;
        evidence.restoredTimeouts=await showTimeouts(raw);assertTimeouts(evidence.restoredTimeouts,0,0);evidence.rootArchivesAfter=await archives.verify();evidence.ok=true;
    }catch(error){evidence.failure={name:error.name,message:error.message,code:error.code};receipt.failures.push({label:evidence.label,...evidence.failure});}
    finally{
        clearTimeout(timer);proceed.resolve();try{await unlock();}catch(error){receipt.cleanupErrors.push({label:evidence.label,resource:'skill blocker',message:error.message});}
        if(executing)try{await deadline(executing,'skill execute cleanup',5000);}catch(error){
            receipt.cleanupErrors.push({label:evidence.label,resource:'skill execute drain',message:error.message});
            try{await f.observer.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',[pid]);await deadline(executing,'cancelled own skill execute cleanup',3000);}
            catch(failure){receipt.cleanupErrors.push({label:evidence.label,resource:'owned skill cancel',message:failure.message});if(raw&&!released)try{released=true;raw.release(true);}catch(releaseError){receipt.cleanupErrors.push({label:evidence.label,resource:'owned skill destroy',message:releaseError.message});}}
        }
        if(blocker)try{blocker.release();}catch(error){receipt.cleanupErrors.push({label:evidence.label,resource:'skill blocker release',message:error.message});}
        if(service){service.lease=undefined;service.releaseLease=undefined;}
        if(raw&&!released){let destroy=false;try{await raw.query('ROLLBACK');await raw.query('SELECT pg_advisory_unlock(72465395)');}
            catch(error){destroy=true;receipt.cleanupErrors.push({label:evidence.label,resource:'skill lease rollback/unlock',message:error.message});}
            try{released=true;raw.release(destroy);}catch(error){receipt.cleanupErrors.push({label:evidence.label,resource:'skill lease release',message:error.message});}}
        if(f)try{const close=await f.close();evidence.cleanup={ownDatabaseDropped:close.ownDatabaseDropped,originalDatabasesPreserved:close.originalDatabasesPreserved,errors:close.cleanupErrors};assert.ok(close.ownDatabaseDropped&&close.originalDatabasesPreserved&&!close.cleanupErrors.length);}
        catch(error){receipt.cleanupErrors.push({label:evidence.label,resource:'skill fixture',message:error.message});}receipt.cases.push(evidence);
    }
}
for(const boundary of ['asset-advisory','dependency-graph','native-row'])await one(boundary);
if(phase==='candidate'){
    await one('asset-advisory',{lockMs:100,label:'shorter inherited lock100/statement0'});
    await one('asset-advisory',{statementMs:200,expectedCode:'57014',label:'shorter inherited lock0/statement200'});
    await successfulCommit();await skillTimeout();
}
try{receipt.harnessHashesAfter=await hashes();assert.deepEqual(receipt.harnessHashesAfter,initialHashes);receipt.archiveControl.after=await archives.verify();receipt.helperProofAfter=await deadlineHelperProof();assert.deepEqual(receipt.helperProofAfter,helperProof);}
catch(error){receipt.failures.push({name:'source/archive stability',message:error.message});}
receipt.finishedAt=new Date().toISOString();receipt.ok=!receipt.failures.length&&!receipt.cleanupErrors.length;
receipt.status=receipt.ok?'GREEN':isPublicationDeadlineCausalRed(receipt)?'CAUSAL_RED':'FAILED';
const saved=await saveDeadlineReceipt(receipt);console.log(JSON.stringify({ok:receipt.ok,status:receipt.status,cases:receipt.cases.length,failures:receipt.failures.length,cleanupErrors:receipt.cleanupErrors,...saved}));
if(!receipt.ok)process.exitCode=1;
