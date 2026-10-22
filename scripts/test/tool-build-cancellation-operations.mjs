import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {settled,until} from './tool-build-cancellation.fixture.mjs';

/** The journal dispatches into the actual build executor and PostgreSQL receipts, with current AccessDb claims. */
export async function cancellationOperations(fixture){
    const {pool,actor,access,service,enqueue,running,row,check,lease,leasePid}=fixture;
    const {OperationRepository}=fixture.load('operations/operation-repository.js');
    const {OperationActionsService}=fixture.load('operations/operation-actions.service.js');
    const operations=new OperationRepository(pool);
    const models={pool,actor:async()=>({...actor,claims:await access.claims(actor.email)})};
    const catalog={getOperation:async(id,scope)=>{
        const value=await operations.get(id,scope);assert.ok(value,'Owned journal row must exist');return value;
    }};
    const actions=new OperationActionsService(catalog,models,{}, {},service);
    const request={};
    const input=async id=>({requestKey:randomUUID(),expectedDigest:(await actions.decorate(request,await operations.get(id))).actions.digest});

    await check('Operations dispatches one queued cancellation for two tabs and real durable receipts',async()=>{
        const job=await enqueue(),id='tool-build-'+job.id,first=await input(id),second={...first,requestKey:randomUUID()};
        fixture.setFlags({tool_builds:false,tool_catalog:false});
        try{
            const [a,b]=await Promise.all([actions.dispatch(request,id,'cancel',first),actions.dispatch(request,id,'cancel',second)]);
            assert.deepEqual(b,a);assert.equal(a.state,'CANCELLED');assert.equal((await row(job.id)).state,'CANCELLED');
            const receipts=(await pool.query('SELECT result FROM operation_action_requests WHERE actor=$1 AND operation_id=$2',[actor.email,id])).rows;
            assert.equal(receipts.length,2);assert.ok(receipts.every(item=>item.result.state==='CANCELLED'));
            assert.equal((await pool.query('SELECT count(*)::int AS n FROM tool_build_cancellations WHERE actor=$1 AND request_key=$2',[actor.email,job.request_key])).rows[0].n,1);
            return {twoTabReceipts:2,oneCancellationIntent:true,creationOffRecoveryAvailable:true};
        }finally{fixture.setFlags({tool_builds:true,tool_catalog:true});}
    });

    await check('Operations never reports a running builder terminal before cleanup and reap',async()=>{
        const job=await running(),id='tool-build-'+job.id,result=await actions.dispatch(request,id,'cancel',await input(id));
        assert.equal(result.state,'RUNNING');assert.equal((await row(job.id)).state,'CANCELLING');
        const operation=await operations.get(id);assert.equal(operation.state,'RUNNING');assert.equal(operation.finishedAt,null);
        const receipt=(await pool.query('SELECT result FROM operation_action_requests WHERE operation_id=$1',[id])).rows[0].result;
        assert.equal(receipt.state,'RUNNING');return {executorState:'CANCELLING',journalState:'RUNNING',terminalTimestampAbsent:true};
    });

    await check('Operations refuses a stale cancel preview after the actual publication fence commits',async()=>{
        const job=await running(),id='tool-build-'+job.id,preview=await input(id);
        await fixture.repository.beginPublication(job.id,lease,()=>service.requireMain(actor));
        await assert.rejects(actions.dispatch(request,id,'cancel',preview),error=>error.status===409);
        assert.equal((await row(job.id)).state,'RUNNING');assert.ok((await row(job.id)).publication_started_at);
        assert.equal((await pool.query('SELECT 1 FROM operation_action_requests WHERE operation_id=$1',[id])).rowCount,0);
        return {stalePreviewRejected:true,publicationPreserved:true};
    });

    await check('Operations re-reads revoked Main rights after its SQL action lock and before a completed replay',async()=>{
        const job=await enqueue(),id='tool-build-'+job.id,preview=await input(id),lock='operation-action:'+actor.email+':'+id;
        let pending,blocked;
        await lease.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
        try{
            pending=settled(actions.dispatch(request,id,'cancel',preview));
            blocked=await until(async()=>{const rows=await fixture.blockedBy(leasePid);return rows.length?rows:null;},'journal dispatch reaches its advisory lock');
            await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor.email]);
        }finally{await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}
        try{
            const denied=await pending;assert.equal(denied.ok,false);assert.equal(denied.error.status,403);
            assert.equal((await row(job.id)).state,'QUEUED');
            await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actor.email]);
            assert.equal((await actions.dispatch(request,id,'cancel',preview)).state,'CANCELLED');
            await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor.email]);
            await assert.rejects(actions.dispatch(request,id,'cancel',preview),error=>error.status===403);
        }finally{await pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actor.email]);}
        return {leasePid,dispatchPid:blocked[0].pid,currentRightsCheckedAfterWait:true,completedReplayAlsoDenied:true};
    });
}
