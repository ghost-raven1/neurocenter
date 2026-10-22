import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {cancellationFixture,deferred,until} from './tool-build-cancellation.fixture.mjs';
import {executionStartBarrier,recordOwnedProcessReap} from './tool-build-cancellation-worker-guard.mjs';

if(process.platform==='win32')throw Error('This native worker fixture requires POSIX process groups. Windows acceptance is separate.');
const root=fileURLToPath(new URL('../../',import.meta.url));
const builder=fileURLToPath(new URL('./tool-build-cancellation-worker-builder.mjs',import.meta.url));
const bootstrap=fileURLToPath(new URL('./tool-build-cancellation-worker-child.mjs',import.meta.url));
const inputs=[import.meta.filename,builder,bootstrap,...['tool-build-cancellation.fixture.mjs','tool-build-cancellation-lease.mjs','owned-postgres.fixture.mjs','tool-build-cancellation-worker-guard.mjs','tool-build-cancellation-worker-guard.test.mjs'].map(file=>fileURLToPath(new URL('./'+file,import.meta.url)))];
const hashFile=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const inputHashes=Object.fromEntries(await Promise.all(inputs.map(async file=>[path.relative(root,file),await hashFile(file)])));
const buildReceipt=path.resolve(process.env.TOOL_BUILD_TEST_DIST??'.','../../../../receipt.json'),buildReceiptSha256=await hashFile(buildReceipt);
const output=path.join(root,'.run/packaging-cancellation-worker-20261023');await mkdir(output,{recursive:true});
const fixture=await cancellationFixture(),workers=[],knownPids=new Set(),stoppedSupervisors=new Set();
const controlRoot=path.join(fixture.folder,'worker-controls'),runtime=path.join(fixture.folder,'runtime'),staging=path.join(runtime,'.build-staging');
await mkdir(controlRoot,{recursive:true});
fixture.receipt.scope='Native PackageBuildService + PostgreSQL + real supervised builder/descendant; no product builder mocks, no installs/publication/inference.';
fixture.receipt.limits.push('Trusted fake builder replaces package compilation; this proves cancellation lifecycle, not actual package publication or installation.','Darwin/POSIX process-group evidence only; Windows and cross-host recovery remain separate.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const absent=async file=>{try{await stat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const json=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return undefined;throw error;}};
const row=id=>fixture.repository.get(id);
const enqueue=()=>{const key=randomUUID();return fixture.repository.enqueue(fixture.actor.email,key,'native-worker-'+key,{...fixture.configuration,description:JSON.stringify({controlRoot})});};
const signal=(pid,value)=>{assert.ok(knownPids.has(pid),'Only a positively owned PID may be signalled');process.kill(pid,value);};
const resume=pid=>{if(stoppedSupervisors.delete(pid)&&alive(pid))signal(pid,'SIGCONT');};
async function startWorker(label){
    const home=path.join(controlRoot,label+'-home');await mkdir(home,{recursive:true});
    const env={PATH:process.env.PATH,HOME:home,USERPROFILE:home,NODE_ENV:'production',CAPACITY_REQUIRED:'false',
        CATALOG_PG_URL:process.env.CATALOG_PG_URL,FEATURE_FLAGS_SERVICE_URL:process.env.FEATURE_FLAGS_SERVICE_URL,API_GATEWAY_URL:process.env.API_GATEWAY_URL,
        NEUROCENTER_INTERNAL_TOKEN:process.env.NEUROCENTER_INTERNAL_TOKEN,RUNTIME_ARTIFACT_DIR:runtime,TOOL_BUILD_SCRIPT:builder,TOOL_BUILD_WORKER_DIST:process.env.TOOL_BUILD_TEST_DIST};
    const child=spawn(process.execPath,[bootstrap],{cwd:fixture.folder,env,detached:true,stdio:['ignore','pipe','pipe','ipc']});
    assert.ok(child.pid);knownPids.add(child.pid);const ready=deferred(),closed=deferred(),logs=[];let bytes=0;
    const record=chunk=>{bytes+=chunk.length;if(bytes>256*1024){ready.reject(Error('Worker output exceeded bound'));return;}logs.push(String(chunk).replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted database]'));};
    child.stdout.on('data',record);child.stderr.on('data',record);
    child.on('message',message=>{if(message?.type==='ready')ready.resolve(message);else if(message?.type==='fatal')ready.reject(Error(message.message));});
    child.once('error',error=>{ready.reject(error);closed.resolve({error:error.code});});
    child.once('close',(code,exitSignal)=>{ready.reject(Error('Worker closed before readiness'));closed.resolve({code,signal:exitSignal});});
    const worker={child,closed:closed.promise,label,logs};workers.push(worker);
    let timer;try{await Promise.race([ready.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker ready deadline')),10000);})]);}finally{clearTimeout(timer);}
    return worker;
}
async function stopWorker(worker){
    if(!alive(worker.child.pid))return worker.closed;
    if(worker.child.connected)worker.child.send({type:'stop'});
    let timer;try{return await Promise.race([worker.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker stop deadline')),10000);})]);}
    finally{clearTimeout(timer);}
}
async function running(job){
    const active=await until(async()=>{const current=await row(job.id);return current.execution_started?current:false;},'durable SQL execution START '+job.id);
    const info=await until(()=>json(path.join(controlRoot,job.id+'.builder.json')),'real trusted builder '+job.id);
    const writer=await until(()=>json(path.join(controlRoot,job.id+'.writer.json')),'real descendant ready '+job.id);
    assert.equal(writer.pid,info.writerPid);assert.equal(writer.parentPid,info.builderPid);assert.equal(info.stage,path.join(staging,job.id));
    for(const pid of [info.builderPid,info.supervisorPid,info.writerPid]){assert.ok(Number.isSafeInteger(pid)&&pid>0);knownPids.add(pid);assert.equal(alive(pid),true);}
    assert.equal(active.execution_host,(await import('node:os')).hostname());assert.ok(active.execution_nonce);assert.equal(active.execution_started,true);
    await until(async()=>{try{return (await stat(path.join(controlRoot,job.id+'.heartbeat'))).size>0;}catch(error){if(error.code==='ENOENT')return false;throw error;}},'descendant heartbeat');
    return {...info,execution:active};
}
async function proveStopped(info){
    await until(()=>[info.builderPid,info.supervisorPid,info.writerPid].every(pid=>!alive(pid)),'supervisor, builder and real descendant reaped',10000);
    const heartbeat=path.join(controlRoot,info.id+'.heartbeat'),before=await readFile(heartbeat);await delay(80);assert.deepEqual(await readFile(heartbeat),before,'Descendant must not continue writing after cancellation');
    return {pids:[info.supervisorPid,info.builderPid,info.writerPid],allExited:true,heartbeatSha256:sha(before),heartbeatStable:true};
}
async function currentLeasePid(){
    const result=await fixture.pool.query("SELECT a.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.objid=$1 AND l.granted AND a.datname=current_database()",[72465395]);
    assert.equal(result.rows.length,1);return Number(result.rows[0].pid);
}
async function cancelled(id){return until(async()=>{const current=await row(id);return current.state==='CANCELLED'?current:false;},'durable CANCELLED '+id,12000);}

let fatal;
try{
    await fixture.releaseWorkerGate();
    const foreign=randomUUID(),foreignFile=path.join(staging,foreign,'keep.txt'),previousFile=path.join(runtime,'previous-version.fixture');
    await mkdir(path.dirname(foreignFile),{recursive:true});await writeFile(foreignFile,'Foreign stage must survive\n');await writeFile(previousFile,'Previous published-version fixture bytes\0\xff');
    const expectedForeign=sha(await readFile(foreignFile)),expectedPrevious=sha(await readFile(previousFile));
    await fixture.check('Native running cancel reaps owned tree before CANCELLED and proceeds to next queued job',async()=>{
        const barrier=await executionStartBarrier(fixture.pool);let first,worker,admission,admissionFailure;
        try{
            first=await enqueue();worker=await startWorker('running-cancel');
            const blocked=await until(async()=>{const result=await fixture.pool.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[barrier.pid]);return result.rows.length?result.rows:false;},'SQL execution-start transaction blocked after supervisor READY');
            const supervisor=Number(execFileSync('pgrep',['-P',String(worker.child.pid)],{encoding:'utf8'}).trim());assert.ok(Number.isSafeInteger(supervisor)&&supervisor>0);knownPids.add(supervisor);
            assert.equal(alive(supervisor),true);assert.equal((await row(first.id)).execution_started,false);
            assert.equal(await absent(path.join(controlRoot,first.id+'.builder.json')),true);assert.equal(await absent(path.join(controlRoot,first.id+'.heartbeat')),true);
            admission={readySupervisorPid:supervisor,blockedSqlPid:Number(blocked[0].pid),executionStartedBeforeCommit:false,builderStartedBeforeCommit:false};
            await barrier.release();
        }catch(error){admissionFailure=error;throw error;}
        finally{try{await barrier.close();}catch(error){if(admissionFailure)fixture.receipt.failures.push({name:'execution barrier cleanup after primary failure',message:error.message});else throw error;}}
        const info=await running(first);
        assert.equal(info.execution.execution_pid,worker.child.pid);
        const reply=await fixture.service.cancel(fixture.actor,first.id);assert.equal(reply.state,'CANCELLING');
        const second=await enqueue();await cancelled(first.id);const stopped=await proveStopped(info);assert.equal(await absent(info.stage),true);
        const next=await running(second);assert.notEqual(next.builderPid,info.builderPid);assert.equal((await row(first.id)).state,'CANCELLED');
        await fixture.service.cancel(fixture.actor,second.id);await cancelled(second.id);await proveStopped(next);assert.equal(await absent(next.stage),true);
        const operation=(await fixture.pool.query('SELECT state,finished_at FROM operations WHERE operation_id=$1',['tool-build-'+first.id])).rows[0];assert.equal(operation.state,'CANCELLED');assert.ok(operation.finished_at);
        const exit=await stopWorker(worker);assert.equal(exit.code,0);
        return {firstId:first.id,nextId:second.id,admission,executionNonce:info.execution.execution_nonce,executionStarted:true,nextJobStarted:true,stageRemoved:true,...stopped};
    });
    await fixture.check('SIGKILL owner leaves live stage until same-host nonce reap proof then replacement completes cancellation',async()=>{
        const job=await enqueue(),worker=await startWorker('crashed-owner'),info=await running(job);
        signal(info.supervisorPid,'SIGSTOP');stoppedSupervisors.add(info.supervisorPid);
        signal(worker.child.pid,'SIGSTOP');await fixture.service.cancel(fixture.actor,job.id);assert.equal((await row(job.id)).state,'CANCELLING');
        signal(worker.child.pid,'SIGKILL');const killed=await worker.closed;assert.equal(killed.signal,'SIGKILL');
        const proofFile=path.join(staging,'.process-reaped',job.id+'.'+info.execution.execution_nonce+'.json');assert.equal(await absent(proofFile),true);
        const replacement=await startWorker('replacement-owner');assert.equal((await row(job.id)).state,'CANCELLING');assert.equal(await absent(info.stage),false);assert.equal(alive(info.writerPid),true);
        const heartbeat=path.join(controlRoot,job.id+'.heartbeat'),before=(await stat(heartbeat)).size;await until(async()=>(await stat(heartbeat)).size>before,'writer survives while reaper intentionally stopped');
        const pending=await row(job.id);assert.match(pending.message,/подтверж|владельц|останов/i);
        resume(info.supervisorPid);
        const proof=await until(()=>json(proofFile),'durable exact-nonce process reap proof',10000);assert.equal(proof.nonce,info.execution.execution_nonce);assert.equal(proof.reaped,true);assert.equal(proof.builderPid,info.builderPid);
        const result=await cancelled(job.id),stopped=await proveStopped(info);assert.equal(result.execution_nonce,info.execution.execution_nonce);assert.equal(await absent(info.stage),true);
        const exit=await stopWorker(replacement);assert.equal(exit.code,0);
        return {id:job.id,ownerPid:worker.child.pid,parentKilled:true,proof,waitedForPositiveProof:true,foreignHostRecovery:false,...stopped};
    });
    await fixture.check('Lease loss while old owner lives cannot clean a still-writing stage or claim cancellation early',async()=>{
        const job=await enqueue(),old=await startWorker('lost-lease-owner'),info=await running(job),leasePid=await currentLeasePid();
        signal(info.supervisorPid,'SIGSTOP');stoppedSupervisors.add(info.supervisorPid);
        await fixture.service.cancel(fixture.actor,job.id);assert.equal((await row(job.id)).state,'CANCELLING');
        assert.equal((await fixture.pool.query('SELECT pg_terminate_backend($1) AS terminated',[leasePid])).rows[0].terminated,true);
        const replacement=await startWorker('lease-replacement');const replacementLeasePid=await currentLeasePid();assert.notEqual(replacementLeasePid,leasePid);
        assert.equal(alive(old.child.pid),true);assert.equal(alive(info.writerPid),true);assert.equal(await absent(info.stage),false);assert.equal((await row(job.id)).state,'CANCELLING');
        const heartbeat=path.join(controlRoot,job.id+'.heartbeat'),before=(await stat(heartbeat)).size;await until(async()=>(await stat(heartbeat)).size>before,'writer stage retained while old worker remains alive');
        resume(info.supervisorPid);await cancelled(job.id);const stopped=await proveStopped(info);assert.equal(await absent(info.stage),true);
        const oldExit=await stopWorker(old),newExit=await stopWorker(replacement);assert.equal(oldExit.code,0);assert.equal(newExit.code,0);
        return {id:job.id,oldOwnerAliveDuringRecovery:true,leasePid,replacementLeasePid,noEarlyCancellation:true,stagePreservedUntilReap:true,...stopped};
    });
    assert.equal(sha(await readFile(foreignFile)),expectedForeign);assert.equal(sha(await readFile(previousFile)),expectedPrevious);
    fixture.receipt.foreignStagePreserved=true;fixture.receipt.previousVersionBytesPreserved=true;
}catch(error){fatal=error;if(!fixture.receipt.failures.some(item=>item.message===error.message))fixture.receipt.failures.push({name:'worker acceptance',message:error.message,stack:error.stack});}
finally{
    for(const pid of stoppedSupervisors)try{resume(pid);}catch{}
    for(const worker of workers)try{await stopWorker(worker);}catch(error){fixture.receipt.failures.push({name:'worker cleanup',message:error.message});if(alive(worker.child.pid))signal(worker.child.pid,'SIGKILL');}
    await recordOwnedProcessReap(fixture.receipt,[...knownPids],alive);
    for(const worker of workers)await writeFile(path.join(output,worker.label+'.log'),worker.logs.join(''),{mode:0o600});
    fixture.receipt.ownedWorkerPids=workers.map(worker=>worker.child.pid);
    const receipt=await fixture.close();
    receipt.harnessHashes=Object.fromEntries(await Promise.all(inputs.map(async file=>[path.relative(root,file),await hashFile(file)])));
    receipt.sourceStable=JSON.stringify(inputHashes)===JSON.stringify(receipt.harnessHashes);
    receipt.candidateBuildReceipt={path:path.relative(root,buildReceipt),sha256:buildReceiptSha256,stable:buildReceiptSha256===await hashFile(buildReceipt)};
    if(!receipt.sourceStable||!receipt.candidateBuildReceipt.stable){receipt.ok=false;receipt.failures.push({name:'source admission',message:'Frozen harness or candidate receipt changed during native acceptance'});}
    await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({ok:receipt.ok,checks:receipt.checks.length,failures:receipt.failures.map(item=>({name:item.name,message:item.message})),allOwnedProcessesExited:receipt.allOwnedProcessesExited,ownDatabaseDropped:receipt.ownDatabaseDropped,receipt:path.relative(root,path.join(output,'receipt.json'))}));
    if(fatal||!receipt.ok||!receipt.allOwnedProcessesExited)process.exitCode=1;
}
