import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {cancellationFixture,deferred,until} from './tool-build-cancellation.fixture.mjs';
import {ownedProcessSnapshot,observeOwnedProcesses,ownedGroupsToSignal} from './tool-build-roundtrip-process.mjs';
import {remainingObservedPids} from './tool-build-publication-recovery-guard.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),builder=process.env.TOOL_BUILD_SCRIPT;
if(process.platform==='win32'||Number(process.versions.node.split('.')[0])<24)throw Error('Owned publication recovery requires Node24/POSIX; other platforms are separate acceptance.');
assert.ok(builder&&path.isAbsolute(builder)&& (await stat(builder)).isFile(),'Select the explicitly built real TOOL_BUILD_SCRIPT candidate.');
const inputs=['tool-build-publication-recovery.mjs','tool-build-publication-recovery-guard.mjs','tool-build-publication-recovery-guard.test.mjs','tool-build-cancellation.fixture.mjs','tool-build-cancellation-lease.mjs','owned-postgres.fixture.mjs','tool-build-roundtrip-process.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(inputs.map(async name=>[name,createHash('sha256').update(await readFile(path.join(root,'scripts/test',name))).digest('hex')])));
const beforeHashes=await hashes(),builderSHA=createHash('sha256').update(await readFile(builder)).digest('hex'),f=await cancellationFixture(),{pool,service,repository,lease,actor,load,receipt}=f;
let sources,PUBLICATION_DEADLINE_MESSAGE;
receipt.scope='Actual service/queue/real JS builder: publication lock deadline, exact replay, next queued job and explicit new UUID recovery';
receipt.harnessHashes=beforeHashes;receipt.realBuilder=builder;receipt.realBuilderSHA=builderSHA;
receipt.limits.push('Only plugin create/update paths; skill, HTTP/Gateway/device authorization, browser, ordinary OpenCode and production are not accepted here.');
receipt.limits.push('Loopback flags/events are fixture-controlled. One real repository enqueue proves already-queued draining, not concurrent API admission while withLease is busy.');
receipt.limits.push('Instrumentation delegates prepareLocal/child assignment for byte/process tracing, and gates real beginPublication only after COMMIT: faulted target once and next queued job once. Compiler, SQL and publication are never replaced.');
const prepared=new Map();let gate,nextGate;
const known=new Map(),blockers=new Set();let inventoryError;
function observe(){try{const rows=ownedProcessSnapshot();observeOwnedProcesses(known,rows);return rows;}catch(error){inventoryError??=error;return new Map();}}
const observer=setInterval(observe,100);observer.unref();
const source=value=>({type:'files',entrypoint:'plugin.mjs',files:[{path:'plugin.mjs',content:`export default async()=>({'experimental.chat.system.transform':async(_request,output)=>output.system.push(${JSON.stringify(value)})});\n`}]});
const input=(name,value)=>({requestKey:randomUUID(),kind:'plugin',name,description:'Owned real publication recovery',targets:[process.platform+'-'+process.arch],source:source(value)});
const terminal=id=>until(async()=>{const row=await f.row(id);return ['FAILED','SUCCEEDED','CANCELLED'].includes(row.state)?row:false;},'actual builder terminal row',120000);
const gone=filename=>stat(filename).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;});
const guc=async()=> (await lease.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows[0];
const json=value=>JSON.parse(JSON.stringify(value));
const cards=async name=>json((await pool.query('SELECT * FROM ai_plugins WHERE name=$1 ORDER BY id',[name])).rows);
const versions=async id=>json((await pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=1',[id])).rows);
const origins=async id=>json((await pool.query('SELECT * FROM asset_source_receipts WHERE native_id=$1 ORDER BY repository,external_id',[id])).rows);
async function bytes(value,expected){
    assert.equal(value.asset.source.type,'archive');const descriptor=value.asset.source;
    const raw=await readFile(await sources.blobs.checkedPath(descriptor.sha256,descriptor.bytes));
    assert.equal(raw.length,descriptor.bytes);assert.equal(createHash('sha256').update(raw).digest('hex'),descriptor.sha256);
    assert.deepEqual(JSON.parse(raw.toString('utf8')).files,expected.files);
    const archives=[];
    for(const {descriptor:artifact}of value.asset.delivery.artifacts){
        const data=await readFile(path.join(f.folder,'runtime',artifact.sha256+'.tar.gz'));
        assert.equal(data.length,artifact.compressedBytes);assert.equal(createHash('sha256').update(data).digest('hex'),artifact.sha256);
        archives.push({sha256:artifact.sha256,bytes:data.length});
    }
    return {sourceSha256:descriptor.sha256,sourceBytes:raw.length,archives};
}
async function releaseBlocker(client){
    if(!blockers.delete(client))return;let failure;
    try{await client.query('ROLLBACK');}catch(error){failure=error;}
    try{client.release(!!failure);}catch(error){failure??=error;}
    if(failure)throw failure;
}
async function idle(){await until(()=>!service.worker,'actual queue drain complete',15000);}
async function observedStopped(ms){
    const end=Date.now()+ms;
    do{const rows=observe();if(!inventoryError&&!remainingObservedPids(known,rows).length)return true;await delay(50);}while(Date.now()<end);
    return false;
}
let failure,baseline,old,oldProof,oldSourceReceipt,oldVersions;
try{
    const runtime=new(load('runtime-artifacts/runtime-artifacts.js').RuntimeArtifacts)({pool});
    sources=new(load('asset-sources/asset-sources.service.js').AssetSourcesService)({ensureSchema:async()=>{}},f.access,runtime);
    ({PUBLICATION_DEADLINE_MESSAGE}=load('package-build/publication-deadline.js'));assert.ok(PUBLICATION_DEADLINE_MESSAGE);
    // Constructor-owned pools remain owned by their real lifecycles; only dependencies/lease are injected.
    Object.assign(service,{artifacts:runtime,sources,repository,lease});
    let observedChild=service.child;
    Object.defineProperty(service,'child',{configurable:true,enumerable:true,get:()=>observedChild,set:child=>{
        observedChild=child;if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
        try{
            const rows=ownedProcessSnapshot(),row=rows.get(child.pid);
            if(row?.parent!==process.pid)return;
            if(known.has(child.pid)&&known.get(child.pid).stamp!==row.stamp)throw Error('Observed native PID was reused; no inherited ownership admitted');
            observeOwnedProcesses(known,rows,[child.pid]);
        }catch(error){inventoryError??=error;}
    }});
    const realPrepare=sources.prepareLocal.bind(sources),realBegin=repository.beginPublication.bind(repository);
    sources.prepareLocal=async(...args)=>{const value=await realPrepare(...args);prepared.set(value.requestKey,structuredClone(value));return value;};
    repository.beginPublication=async(...args)=>{
        const value=await realBegin(...args);
        const row=gate||nextGate?await f.row(args[0]):undefined,active=[gate,nextGate].find(item=>item&&!item.used&&item.key===row?.request_key);
        if(active){
            active.used=true;assert.ok(row.publication_started_at,'Barrier must follow actual fence COMMIT');
            active.entered.resolve({id:row.id,fence:row.publication_started_at});await active.resume.promise;
        }
        return value;
    };
    // A nonzero lower session setting exercises clamping and restoration without changing server/global GUCs.
    await lease.query("SELECT set_config('lock_timeout','1250ms',false),set_config('statement_timeout','20s',false)");baseline=await guc();
    const warmup=input('Owned recovery A '+randomUUID().slice(0,8),'A');
    old=await terminal((await service.create(actor,warmup)).id);assert.equal(old.state,'SUCCEEDED',old.error??old.message);await idle();
    oldProof=await bytes(prepared.get(warmup.requestKey),warmup.source);oldSourceReceipt=json(await sources.exportLocalReceipt(old.result));oldVersions=await versions(old.result.catalogId);
    for(const kind of ['create','update'])await f.check('Actual '+kind+' deadline keeps source/old bytes, drains next job and accepts explicit new UUID',async()=>{
        const publicInput=input(kind==='update'?warmup.name:'Owned recovery create '+randomUUID().slice(0,8),'B-'+kind);
        if(kind==='update'){
            const target=await service.publicationTarget(actor,'plugin',old.result.catalogId);
            publicInput.publication={catalogId:target.catalogId,expectedVersion:target.expectedVersion,expectedSourceHash:target.expectedSourceHash};
        }
        const oldCards=await cards(warmup.name),oldOrigins=await origins(old.result.catalogId);
        gate={key:publicInput.requestKey,entered:deferred(),resume:deferred(),used:false};const active=gate;
        const queued=await service.create(actor,publicInput);const committed=await Promise.race([active.entered.promise,terminal(queued.id).then(row=>{throw Error('Target terminated before real committed fence: '+row.state+' '+row.error);})]);
        const targetPrepared=prepared.get(publicInput.requestKey),retained=await bytes(targetPrepared,publicInput.source);
        const blocker=await pool.connect();blockers.add(blocker);let released=false;
        try{
            await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['publication:dependency-graph']);
            const blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            const nextInput=input('Owned queued next '+kind+' '+randomUUID().slice(0,8),'C-'+kind),nextKey=nextInput.requestKey;
            const {requestKey:_request,...nextConfig}=nextInput;
            nextGate={key:nextKey,entered:deferred(),resume:deferred(),used:false};const queuedGate=nextGate;
            const next=await repository.enqueue(actor.email,nextKey,'owned-independent-'+nextKey,{...nextConfig,tags:[]});assert.equal(next.state,'QUEUED');
            active.resume.resolve();
            const edge=await until(async()=>{const rows=await f.blockedBy(blockerPid);return rows.find(row=>Number(row.pid)===f.leasePid);},'actual post-fence graph lock wait');
            const failed=await terminal(queued.id);assert.equal(failed.state,'FAILED',failed.error??failed.message);assert.ok(failed.publication_started_at);assert.equal(failed.error,PUBLICATION_DEADLINE_MESSAGE);assert.equal(failed.message,PUBLICATION_DEADLINE_MESSAGE);assert.equal(failed.result,null);assert.equal(failed.execution_started,true);
            assert.equal((await pool.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND granted) AS held',[blockerPid])).rows[0].held,true,'Deadline must fail while blocker is still held');
            assert.deepEqual(await bytes(targetPrepared,publicInput.source),retained);assert.deepEqual(await cards(warmup.name),oldCards);assert.deepEqual(await origins(old.result.catalogId),oldOrigins);
            assert.deepEqual(json(await sources.exportLocalReceipt(old.result)),oldSourceReceipt);assert.deepEqual(await bytes(prepared.get(warmup.requestKey),warmup.source),oldProof);assert.deepEqual(await versions(old.result.catalogId),oldVersions);
            if(kind==='create')assert.deepEqual(await cards(publicInput.name),[]);
            const sourceRows=(await pool.query("SELECT count(*)::int AS count FROM asset_source_versions WHERE repository='local-archive' AND external_id=$1 AND asset_version=$2",[targetPrepared.asset.id,targetPrepared.asset.version])).rows[0].count;assert.equal(sourceRows,0,'Failed publication must not record the prepared B source');
            const jobCount=Number((await pool.query('SELECT count(*)::int AS count FROM tool_build_jobs')).rows[0].count),replayed=await service.create(actor,publicInput);
            assert.equal(replayed.id,failed.id);assert.equal(replayed.state,'FAILED');assert.equal(replayed.error,PUBLICATION_DEADLINE_MESSAGE);assert.equal(Number((await pool.query('SELECT count(*)::int AS count FROM tool_build_jobs')).rows[0].count),jobCount);assert.deepEqual(await cards(warmup.name),oldCards);
            await until(()=>gone(path.join(f.folder,'runtime/.build-staging',failed.id)),'failed real builder stage removed');
            const nextFence=await Promise.race([queuedGate.entered.promise,terminal(next.id).then(row=>{throw Error('Next queued builder terminated before real fence: '+row.state+' '+row.error);})]);
            await releaseBlocker(blocker);released=true;queuedGate.resume.resolve();
            const drained=await terminal(next.id);assert.equal(drained.state,'SUCCEEDED',drained.error??drained.message);assert.equal(drained.execution_started,true);await idle();assert.deepEqual(await guc(),baseline);
            const retryInput={...publicInput,requestKey:randomUUID()},retry=await terminal((await service.create(actor,retryInput)).id);
            assert.equal(retry.state,'SUCCEEDED',retry.error??retry.message);assert.equal(retry.execution_started,true);assert.notEqual(retry.request_key,failed.request_key);assert.deepEqual(retry.config.source,failed.config.source);assert.deepEqual(retry.config.publication,failed.config.publication);
            assert.equal(retry.result.version,kind==='update'?2:1);if(kind==='update')assert.equal(retry.result.catalogId,old.result.catalogId);
            await idle();assert.deepEqual(await guc(),baseline);assert.deepEqual(json(await sources.exportLocalReceipt(old.result)),oldSourceReceipt);assert.deepEqual(await versions(old.result.catalogId),oldVersions);assert.deepEqual(await bytes(prepared.get(warmup.requestKey),warmup.source),oldProof);
            const retryHead=(await pool.query('SELECT id,version FROM ai_plugins WHERE id=$1',[retry.result.catalogId])).rows[0],retryReceipt=json(await sources.exportLocalReceipt(retry.result));
            assert.deepEqual(retryHead,{id:retry.result.catalogId,version:retry.result.version});assert.equal(retryReceipt.native_id,retry.result.catalogId);assert.equal(retryReceipt.native_version,retry.result.version);
            const currentOrigins=(await origins(retry.result.catalogId)).filter(row=>row.active);assert.equal(currentOrigins.length,1);
            const current=currentOrigins[0];for(const field of ['repository','external_id','asset_version','descriptor_sha256','native_id','native_version','native_hash'])assert.deepEqual(current[field],retryReceipt[field]);
            assert.equal(current.external_id,retry.result.assetId);assert.equal(current.asset_version,retry.result.sourceVersion);assert.equal(current.descriptor_sha256,retry.result.sourceSha256);
            const retryProof=await bytes(prepared.get(retryInput.requestKey),retryInput.source);assert.deepEqual(await bytes(targetPrepared,publicInput.source),retained);
            for(const id of [failed.id,next.id,retry.id])assert.ok(await gone(path.join(f.folder,'runtime/.build-staging',id)),'Known job stage must be removed');
            return {fence:committed,edge,failedId:failed.id,failedBeforeUnlock:true,retainedSource:retained,oldSource:oldProof,exactReplaySameFailed:true,nextQueuedId:next.id,nextFence,nextState:drained.state,retryId:retry.id,retryVersion:retry.result.version,retryHead,currentSource:{repository:current.repository,assetId:current.external_id,sourceVersion:current.asset_version,sourceSha256:current.descriptor_sha256,nativeId:current.native_id,nativeVersion:current.native_version},retrySource:retryProof,sessionGUC:await guc(),stagesRemoved:true};
        }finally{active.resume.resolve();nextGate?.resume.resolve();if(!released)await releaseBlocker(blocker);gate=undefined;nextGate=undefined;}
    });
    assert.ok(known.size>0,'Actual native builder processes must be observed with birth identity');
}catch(error){failure=error;if(!receipt.failures.length)receipt.failures.push({name:'Actual publication recovery',message:error.message,stack:error.stack});}
finally{
    gate?.resume.resolve();nextGate?.resume.resolve();gate=undefined;nextGate=undefined;
    for(const blocker of [...blockers])try{await releaseBlocker(blocker);}catch(error){receipt.failures.push({name:'Owned blocker cleanup',message:error.message});}
    try{await idle();}catch(error){receipt.failures.push({name:'Owned worker drain',message:error.message});}
    clearInterval(observer);observe();
    try{
        if(!await observedStopped(2000)){
            const rows=observe();for(const group of ownedGroupsToSignal(known,rows))try{process.kill(-group,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
            if(!await observedStopped(2000)){const rows=observe();for(const group of ownedGroupsToSignal(known,rows))try{process.kill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
            receipt.failures.push({name:'Owned native cleanup',message:'Real builder did not stop normally; forced only observed birth-matched native groups.'});
        }
        receipt.allObservedProcessesExited=await observedStopped(3000);
    }catch(error){receipt.failures.push({name:'Owned process proof',message:error.message});}
    receipt.remainingObservedPids=remainingObservedPids(known,observe());receipt.processInventoryOkay=!inventoryError;
    receipt.allObservedProcessesExited=receipt.allObservedProcessesExited===true&&receipt.remainingObservedPids.length===0&&receipt.processInventoryOkay;
    if(!receipt.allObservedProcessesExited)receipt.failures.push({name:'Owned process proof',message:inventoryError?.message??'Observed builder/supervisor PIDs remain present or process inventory is unproven'});
    receipt.observedProcesses=[...known.values()];
    try{await sources?.onApplicationShutdown();}catch(error){receipt.failures.push({name:'Owned sources cleanup',message:error.message});}
    try{receipt.finalHarnessHashes=await hashes();assert.deepEqual(receipt.finalHarnessHashes,beforeHashes);}catch(error){receipt.failures.push({name:'Harness source drift',message:error.message});}
    const final=await f.close();console.log(JSON.stringify({ok:final.ok,checks:final.checks.length,failures:final.failures.map(item=>({name:item.name,message:String(item.message).replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted database]')})),receipt:path.relative(root,path.join(f.folder,'receipt.json'))}));
    if(failure||!final.ok)process.exitCode=1;
}
