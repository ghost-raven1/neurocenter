import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {cancellationFixture,deferred,settled,until} from './tool-build-cancellation.fixture.mjs';
import {cancellationOperations} from './tool-build-cancellation-operations.mjs';
import {waitForCancellationBarrier} from './tool-build-cancellation-barrier.mjs';

let fixture,fatal;
try{
    fixture=await cancellationFixture();
    const {pool,repository,service,actor,lease,leasePid,configuration,folder,row,enqueue,running,check}=fixture;
    const {PluginRepository}=fixture.load('publication/plugin-repository.js');
    const publication=name=>({name,kind:'plugin',description:'Owned SQL publication fixture',config:{entrypoint:'index.mjs'},
        files:[{path:'index.mjs',content:'export default async()=>({fixture:true})'}],publicationKey:randomUUID()});
    const plugins=new PluginRepository(pool),previous=await plugins.create(publication('Previously published '+randomUUID()),actor.email);
    const previousBytes=JSON.stringify((await pool.query('SELECT * FROM ai_plugins WHERE id=$1',[previous.id])).rows[0]);
    const versions=(await pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[previous.id])).rows;
    assert.ok(versions.length>0);const previousVersions=JSON.stringify(versions);
    const previousFile=path.join(folder,'previous-published-version');await writeFile(previousFile,'published-before-cancellation');

    await check('Queued cancellation skips the cancelled row and the next job can start',async()=>{
        const queued=await enqueue(),next=await enqueue();
        const cancelled=await repository.cancel(actor.email,queued.id,()=>service.requireMain(actor));
        assert.equal(cancelled.state,'CANCELLED');
        assert.equal((await repository.takeQueued(lease)).id,next.id);
        const operation=(await pool.query('SELECT state,finished_at FROM operations WHERE operation_id=$1',['tool-build-'+queued.id])).rows[0];
        assert.equal(operation.state,'CANCELLED');assert.ok(operation.finished_at);
        assert.equal((await row(queued.id)).publication_started_at,null);
        return {cancelled:queued.id,next:next.id,operationState:operation.state};
    });

    await check('A lost POST is fenced by durable actor/request cancellation before late enqueue',async()=>{
        const key=randomUUID(),first=await service.cancelRequest(actor,key),replay=await service.cancelRequest(actor,key);
        assert.equal(first.state,'CANCELLED');assert.equal(first.build,null);assert.deepEqual(replay,first);
        await assert.rejects(repository.enqueue(actor.email,key,'late',configuration),error=>error.status===409);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM tool_build_cancellations WHERE actor=$1 AND request_key=$2',[actor.email,key])).rows[0].n,1);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM tool_build_jobs WHERE actor=$1 AND request_key=$2',[actor.email,key])).rows[0].n,0);
        const independent=await repository.enqueue('other-owner@example.test',key,'independent',configuration);
        assert.equal(independent.state,'QUEUED');return {tombstones:1,lateJobs:0,otherActorIndependent:true};
    });

    await check('Cancellation wins its advisory lock first; a concurrent late POST never creates a job',async()=>{
        const key=randomUUID(),entered=deferred(),release=deferred();let cancelled,enqueued,cancelPid,blocked;
        try{
            cancelled=settled(repository.cancelRequest(actor.email,key,async()=>{
                await service.requireMain(actor);
                cancelPid=Number((await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=72465396 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].pid);
                entered.resolve();await release.promise;
            }));
            await waitForCancellationBarrier(entered,cancelled,'cancellation advisory lock');
            enqueued=settled(repository.enqueue(actor.email,key,'late-concurrent-post',configuration));
            blocked=await until(async()=>{const rows=await fixture.blockedBy(cancelPid);return rows.length?rows:null;},'late POST waits for the actual cancellation tombstone transaction');
        }finally{release.resolve();}
        const [cancellation,creation]=await Promise.all([cancelled,enqueued]);
        assert.equal(cancellation.ok,true);assert.equal(cancellation.value,undefined);
        assert.equal(creation.ok,false);assert.equal(creation.error.status,409);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM tool_build_jobs WHERE actor=$1 AND request_key=$2',[actor.email,key])).rows[0].n,0);
        return {cancelPid,enqueuePid:blocked[0].pid,noJobCreated:true};
    });

    await check('Enqueue wins its advisory lock first; a concurrent cancellation still cancels the one committed job',async()=>{
        const key=randomUUID(),entered=deferred(),release=deferred();let enqueuePid,enqueued,cancelled,blocked;
        try{
            enqueued=settled(repository.enqueue(actor.email,key,'queued-before-cancel',configuration,undefined,async client=>{
                enqueuePid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);entered.resolve();await release.promise;
            }));
            await waitForCancellationBarrier(entered,enqueued,'enqueue advisory lock');
            cancelled=settled(service.cancelRequest(actor,key));
            blocked=await until(async()=>{const rows=await fixture.blockedBy(enqueuePid);return rows.length?rows:null;},'cancellation waits for the actual enqueue transaction');
        }finally{release.resolve();}
        const [created,cancellation]=await Promise.all([enqueued,cancelled]);assert.equal(created.ok,true);assert.equal(cancellation.ok,true);
        assert.equal(cancellation.value.state,'CANCELLED');assert.equal(cancellation.value.build.id,created.value.id);
        assert.equal((await row(created.value.id)).state,'CANCELLED');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM tool_build_jobs WHERE actor=$1 AND request_key=$2',[actor.email,key])).rows[0].n,1);
        return {enqueuePid,cancelPid:blocked[0].pid,oneJob:true,cancelledAfterCommit:true};
    });

    await check('Cancellation wins a real blocked publication transaction before its native continuation',async()=>{
        const job=await running(),entered=deferred(),release=deferred(),native=path.join(folder,'cancelled-native-write');
        let publication,cancellation;const pids=[];
        try{
            cancellation=settled(repository.cancel(actor.email,job.id,async()=>{await service.requireMain(actor);entered.resolve();await release.promise;}));
            await waitForCancellationBarrier(entered,cancellation,'cancellation row lock');
            publication=settled(repository.beginPublication(job.id,lease,()=>service.requireMain(actor)).then(()=>writeFile(native,'must not publish')));
            const blocking=await until(async()=>{const values=(await pool.query('SELECT pg_blocking_pids($1) AS blockers',[leasePid])).rows[0].blockers;return values.length?values:null;},'publication blocked by the cancellation row lock');
            pids.push(leasePid,...blocking);assert.ok(blocking.every(pid=>pid!==leasePid));
        }finally{release.resolve();}
        const [cancelled,published]=await Promise.all([cancellation,publication]);
        assert.equal(cancelled.ok,true);assert.equal(cancelled.value.state,'CANCELLING');assert.equal(published.ok,false);
        const actual=await row(job.id);assert.equal(actual.state,'CANCELLING');assert.equal(actual.publication_started_at,null);
        await assert.rejects(readFile(native),{code:'ENOENT'});
        const operation=(await pool.query('SELECT state,finished_at FROM operations WHERE operation_id=$1',['tool-build-'+job.id])).rows[0];
        assert.equal(operation.state,'RUNNING');assert.equal(operation.finished_at,null);
        return {distinctBackendPids:[...new Set(pids)],publicationRejected:true,nativeWriteAbsent:true,cancellationNotYetTerminal:true};
    });

    await check('Publication wins the opposite SQL lock order; cancellation returns publishing and preserves success',async()=>{
        const job=await running(),entered=deferred(),release=deferred();let fence,cancellation,blocked;
        try{
            fence=settled(repository.beginPublication(job.id,lease,async()=>{await service.requireMain(actor);entered.resolve();await release.promise;}));
            await waitForCancellationBarrier(entered,fence,'publication row lock');
            cancellation=settled(repository.cancel(actor.email,job.id,()=>service.requireMain(actor)));
            blocked=await until(async()=>{const rows=await fixture.blockedBy(leasePid);return rows.length?rows:null;},'cancellation blocked by the publication row lock');
            assert.ok(blocked.every(value=>value.pid!==leasePid));
        }finally{release.resolve();}
        assert.equal((await fence).ok,true);const cancelled=await cancellation;assert.equal(cancelled.ok,true);
        assert.equal(cancelled.value.state,'RUNNING');assert.ok(cancelled.value.publication_started_at);
        const published=await plugins.create(publication('Published after the fence '+randomUUID()),actor.email,
            (client,plugin)=>repository.completeWithPublication(client,job.id,{catalogId:plugin.id,name:plugin.name,version:plugin.version}));
        assert.equal((await row(job.id)).result.catalogId,published.id);
        assert.equal((await service.cancel(actor,job.id)).state,'SUCCEEDED');
        return {leasePid,cancelPid:blocked[0].pid,publicationRetained:true,lateCancellationState:'SUCCEEDED'};
    });

    await check('Role revocation while cancellation waits is re-read before the actual SQL mutation',async()=>{
        const job=await running();let cancellation,blocked;
        await lease.query('BEGIN');await lease.query('SELECT id FROM tool_build_jobs WHERE id=$1 FOR UPDATE',[job.id]);
        try{
            cancellation=settled(service.cancel(actor,job.id));
            blocked=await until(async()=>{const rows=await fixture.blockedBy(leasePid);return rows.length?rows:null;},'authorized cancellation reaches its row wait');
            await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor.email]);
        }finally{await lease.query('COMMIT');}
        try{
            const result=await cancellation;assert.equal(result.ok,false);assert.equal(result.error.status,403);
            assert.equal((await row(job.id)).state,'RUNNING');
            assert.equal((await pool.query('SELECT 1 FROM tool_build_cancellations WHERE actor=$1 AND request_key=$2',[actor.email,job.request_key])).rowCount,0);
        }finally{await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actor.email]);}
        return {leasePid,cancelPid:blocked[0].pid,revokedBeforeMutation:true};
    });

    await check('Another current main administrator cannot cancel a foreign actor job',async()=>{
        const other={email:'other-admin@example.test',activeRole:'Главный админ'},job=await running();
        await pool.query("INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,'Other owned fixture',true)",[other.email]);
        await assert.rejects(service.cancel(other,job.id),error=>error.status===404);
        assert.equal((await row(job.id)).state,'RUNNING');
        return {foreignCancellationRejected:true};
    });

    await check('Creation disabled still permits cancellation/history without consulting the feature server',async()=>{
        fixture.setFlags({tool_builds:false,tool_catalog:false});const job=await enqueue();
        const reads=()=>fixture.requests.filter(value=>value.path==='/internal/feature-flags/evaluated').length;
        const before=reads();
        assert.equal((await service.cancel(actor,job.id)).state,'CANCELLED');assert.equal((await service.get(actor,job.id)).state,'CANCELLED');
        assert.equal(reads(),before);
        await assert.rejects(service.create(actor,{...configuration,requestKey:randomUUID()}),error=>error.status===403);
        assert.ok(reads()>before);fixture.setFlags({tool_builds:true,tool_catalog:true});
        return {cancelAndHistoryAvailable:true,creationRejected:true};
    });

    await check('A failed publication rolls back card and success together and never becomes fake cancelled',async()=>{
        const job=await running(),name='Rolled-back publication '+randomUUID();
        await repository.beginPublication(job.id,lease,()=>service.requireMain(actor));
        await assert.rejects(plugins.create(publication(name),actor.email,async(client,plugin)=>{
            await repository.completeWithPublication(client,job.id,{catalogId:plugin.id,name:plugin.name,version:plugin.version});
            throw Error('controlled-publication-rollback');
        }),/controlled-publication-rollback/);
        assert.equal((await pool.query('SELECT 1 FROM ai_plugins WHERE name=$1',[name])).rowCount,0);
        const actual=await row(job.id);assert.equal(actual.state,'RUNNING');assert.equal(actual.result,null);assert.ok(actual.publication_started_at);
        assert.equal((await service.cancel(actor,job.id)).state,'RUNNING');
        return {cardAbsent:true,successRolledBack:true,publicationBoundaryRetained:true};
    });

    await check('The previous catalog row, its stored versions and a separate file sentinel survive cancellation races',async()=>{
        assert.equal(JSON.stringify((await pool.query('SELECT * FROM ai_plugins WHERE id=$1',[previous.id])).rows[0]),previousBytes);
        assert.equal(JSON.stringify((await pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[previous.id])).rows),previousVersions);
        assert.equal(await readFile(previousFile,'utf8'),'published-before-cancellation');
        return {previousCatalogId:previous.id,previousCatalogRowUnchanged:true,storedVersionsUnchanged:versions.length,separateFileSentinelUnchanged:true,runtimeArchivesTested:false};
    });

    await cancellationOperations(fixture);

    await check('Unproved cancellations retain their stages but cannot exhaust admission of other jobs',async()=>{
        const pending=[];
        for(let index=0;index<10;index++){
            const job=await enqueue();
            await pool.query("UPDATE tool_build_jobs SET state='CANCELLING',execution_host='unavailable-owner.invalid',execution_nonce=$2 WHERE id=$1",[job.id,randomUUID()]);
            pending.push(job.id);
        }
        const next=await enqueue();assert.equal(next.state,'QUEUED');
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM tool_build_jobs WHERE id=ANY($1::uuid[]) AND state='CANCELLING'",[pending])).rows[0].n,10);
        assert.equal((await repository.takeQueued(lease)).id,next.id);
        return {unprovedCancellationsRetained:10,newJobAdmitted:true,newJobStarted:true};
    });
}catch(error){fatal=error;process.exitCode=1;console.error(error.message);}
finally{
    if(fixture){
        if(fatal&&!fixture.receipt.failures.length)fixture.receipt.failures.push({name:'acceptance',message:fatal.message,stack:fatal.stack});
        const result=await fixture.close();
        console.log(JSON.stringify({ok:result.ok,scenarios:result.checks.length,receipt:path.join(fixture.folder,'receipt.json')}));
        if(!result.ok)process.exitCode=1;
    }
}
