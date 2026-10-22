import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {versionCasFixture,sha,deadline,settled} from './tool-build-version-cas.fixture.mjs';
import {checkQaSourcesAndClose} from './package-publication-rollback.fixture.mjs';

const inputs=['tool-build-version-cas.mjs','tool-build-version-cas.fixture.mjs','package-publication-rollback.fixture.mjs',
    'tool-build-cancellation.fixture.mjs','tool-build-cancellation-lease.mjs','owned-postgres.fixture.mjs'];
const directory=fileURLToPath(new URL('./',import.meta.url));
const hashes=async()=>Object.fromEntries(await Promise.all(inputs.map(async name=>[name,sha(await readFile(path.join(directory,name)))])));
const beforeHashes=await hashes(),f=await versionCasFixture();f.receipt.harnessHashes=beforeHashes;
let fatal;
const rejected=(result,status)=>{assert.equal(result.ok,false,'The stale or unauthorized publication must reject.');assert.equal(result.error.status,status);};
const unchanged=async(item,before)=>assert.deepEqual(await f.snapshot(item),before);
async function rejectedBuild(item,build,pending,expected,before){
    const result=await deadline(pending,'rejected publication');rejected(result,expected);await unchanged(item,before);
    const row=await f.row(build.row.id);assert.notEqual(row.state,'SUCCEEDED');assert.equal(row.result,null);return {status:result.error.status,state:row.state};
}
try{
    await f.check('Healthy real publication updates one native identity and retains immutable version1/source bytes',async()=>{
        const item=await f.seed(),before=await f.snapshot(item),build=await f.build(item);await f.publish(item,build);
        const after=await f.snapshot(item),row=await f.row(build.row.id);f.immutable(before,after);
        assert.equal(after.cards[0].version,2);assert.deepEqual(after.versions.map(row=>row.version),[1,2]);assert.equal(after.sources.length,2);
        assert.equal(after.receipts[0].native_version,2);assert.equal(after.receipts[0].asset_version,'2.0.0');assert.equal(row.state,'SUCCEEDED');assert.equal(row.result.version,2);
        const b=await readFile(await f.blobs.checkedPath(item.b.prepared.asset.source.sha256,item.b.bytes.length));assert.deepEqual(b,item.b.bytes);
        return {catalogId:item.card.id,jobId:row.id,version:2,oldSourceSha256:before.oldSourceSha256,newSourceSha256:sha(b)};
    });

    for(const change of ['native-version','source-owner-revision'])await f.check('Admission rejects stale '+change+' and preserves actual source/native history',async()=>{
        const item=await f.seed(),preview=await f.target.publicationTargetPreview(f.pool,'plugin',item.card.id);
        const publicPin={catalogId:preview.catalogId,expectedVersion:preview.expectedVersion,expectedSourceHash:preview.expectedSourceHash};
        if(change==='native-version')await f.plugins.update(item.card.id,{expectedVersion:1,description:'Concurrent admitted edit'},f.actor.email);
        else await f.pool.query('UPDATE asset_source_receipts SET revision=revision+1 WHERE native_id=$1',[item.card.id]);
        const before=await f.snapshot(item),result=await settled(f.target.pinBuildPublication(f.pool,{kind:'plugin',name:item.name,publication:publicPin}));rejected(result,409);await unchanged(item,before);
        if(change==='source-owner-revision')assert.equal(before.cards[0].version,1);
        return {catalogId:item.card.id,status:409,actualNativeVersion:before.cards[0].version,receiptRevision:before.receipts[0].revision};
    });

    for(const change of ['native-version','source-owner-revision'])await f.check('Commit rejects '+change+' changed during observed SQL lock wait',async()=>{
        const item=await f.seed(),build=await f.build(item),blocker=await f.client();let pending;
        try{
            await blocker.query('BEGIN');await f.target.lockBuildPublication(blocker,build.pin);
            pending=settled(f.publish(item,build));const edge=await f.blocking(f.leasePid,await f.pid(blocker));
            if(change==='native-version')await f.plugins.update(item.card.id,{expectedVersion:1,description:'Concurrent locked edit'},f.actor.email,undefined,blocker,true);
            else await blocker.query('UPDATE asset_source_receipts SET revision=revision+1 WHERE native_id=$1',[item.card.id]);
            await blocker.query('COMMIT');const before=await f.snapshot(item),proof=await rejectedBuild(item,build,pending,409,before);
            return {...proof,edge,actualNativeVersion:before.cards[0].version,receiptRevision:before.receipts[0].revision};
        }finally{await blocker.query('ROLLBACK');if(pending)await deadline(pending,'stale publication cleanup');await f.release(blocker);}
    });

    for(const boundary of ['asset-advisory','native-row'])for(const revoke of ['main-role','feature-flag'])await f.check(revoke+' revoked while actual publisher waits on '+boundary,async()=>{
        const item=await f.seed(),build=await f.build(item),before=await f.snapshot(item),blocker=await f.client();let pending;
        try{
            await blocker.query('BEGIN');
            if(boundary==='asset-advisory')await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:plugin:'+item.card.id]);
            else await blocker.query('SELECT id FROM ai_plugins WHERE id=$1 FOR UPDATE',[item.card.id]);
            pending=settled(f.publish(item,build));const edge=await f.blocking(f.leasePid,await f.pid(blocker));
            if(revoke==='main-role')await f.pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[f.actor.email]);else f.setFlags({tool_builds:false});
            await blocker.query('COMMIT');return {...await rejectedBuild(item,build,pending,403,before),edge};
        }finally{
            await blocker.query('ROLLBACK');if(pending)await deadline(pending,'revoked publication cleanup');
            await f.pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[f.actor.email]);f.resetFlags();await f.release(blocker);
        }
    });

    for(const first of ['update','publication-key-replay'])await f.check('Same-ID update/replay uses one SQL lock order: '+first+' first',async()=>{
        const item=await f.seed(),before=await f.snapshot(item),build=await f.build(item),replayClient=await f.client();
        const updateGate=first==='update'?f.afterFirstLock(f.lease):undefined,replayGate=first!=='update'?f.afterFirstLock(replayClient):undefined;
        const replay=()=>f.plugins.create({...item.a.prepared.publication,publicationKey:item.key},f.actor.email,
            (client,card)=>f.ingest.record(client,item.a.prepared,card,f.actor.email),replayGate?.client??replayClient);
        let one,two;
        try{
            const replayPid=await f.pid(replayClient);
            one=settled(first==='update'?f.publish(item,build,updateGate.client):replay());
            const held=await deadline((updateGate??replayGate).entered,'first real advisory lock');
            two=settled(first==='update'?replay():f.publish(item,build));
            const edge=await f.blocking(first==='update'?replayPid:f.leasePid,first==='update'?f.leasePid:replayPid);
            (updateGate??replayGate).resume();const results=await deadline(Promise.all([one,two]),'same native ID lock pair');
            assert.ok(results.some(result=>result.ok),'At least the first serialized operation must complete.');
            for(const result of results)if(!result.ok){assert.notEqual(result.error.code,'40P01','Actual PostgreSQL deadlock.');assert.equal(result.error.status,409,'Only a legitimate stale source/CAS conflict is allowed.');}
            const after=await f.snapshot(item);f.immutable(before,after);assert.ok([1,2].includes(after.cards[0].version));
            assert.deepEqual(after.versions.map(row=>row.version),after.cards[0].version===2?[1,2]:[1]);assert.equal(after.receipts[0].native_version,after.cards[0].version);
            return {edge,firstLock:held,outcomes:results.map(result=>result.ok?'committed':{status:result.error.status,code:result.error.code}),version:after.cards[0].version};
        }finally{
            updateGate?.resume();replayGate?.resume();await deadline(Promise.all([one,two].filter(Boolean)),'lock pair cleanup');
            await f.release(replayClient);
        }
    });

    await f.check('Real COMMIT followed by lost ACK is all-or-nothing and exact actor/request replay returns the retained result',async()=>{
        const item=await f.seed(),before=await f.snapshot(item),build=await f.build(item),primary=Error('Owned actual COMMIT ACK lost');let injected=0;
        const wrapped=new Proxy(f.lease,{get(target,key){if(key==='query')return async(sql,...args)=>{
            const result=await target.query(sql,...args),text=typeof sql==='string'?sql:sql.text;
            if(text==='COMMIT'&&!injected++){throw primary;}return result;
        };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const result=await settled(f.publish(item,build,wrapped));assert.equal(result.ok,false);assert.equal(result.error,primary);assert.equal(injected,1);
        const after=await f.snapshot(item),row=await f.row(build.row.id);f.immutable(before,after);
        assert.equal(after.cards[0].version,2);assert.equal(after.versions.length,2);assert.equal(after.sources.length,2);assert.equal(after.receipts[0].native_version,2);
        assert.equal(after.audit.filter(row=>row.action==='plugin.update').length,1);assert.equal(row.state,'SUCCEEDED');assert.equal(row.result.catalogId,item.card.id);assert.equal(row.result.version,2);
        assert.equal(row.result.sourceVersion,'2.0.0');assert.equal(row.result.sourceSha256,item.b.prepared.sha256);
        const count=Number((await f.observer.query('SELECT count(*)::int AS count FROM tool_build_jobs')).rows[0].count);
        f.setFlags({tool_builds:false});const replay=await f.service.create(f.actor,build.input);f.resetFlags();
        assert.equal(replay.id,row.id);assert.equal(replay.result.version,2);assert.equal(replay.requestKey,build.input.requestKey);await unchanged(item,after);
        assert.equal(Number((await f.observer.query('SELECT count(*)::int AS count FROM tool_build_jobs')).rows[0].count),count);
        return {jobId:row.id,version:row.result.version,executedCommitAckLost:true,retainedReplaySameJob:true,newPublicationRows:0,replayWhileCreationOff:true};
    });
}catch(error){fatal=error;if(!f.receipt.failures.length)f.receipt.failures.push({name:'CAS runner',message:error.message,stack:error.stack});}
finally{
    const {result}=await checkQaSourcesAndClose({readHashes:hashes,expectedHashes:beforeHashes,onHashes:value=>{f.receipt.harnessHashesAfter=value;},
        onHashFailure:error=>{f.receipt.failures.push({name:'QA source stability',message:error.message});fatal??=error;},
        close:()=>f.close()});
    const file=path.join(f.folder,'receipt.json');console.log(JSON.stringify({ok:result.ok,passed:result.checks.length,failed:result.failures.length,cleanupErrors:result.cleanupErrors,receipt:file,sha256:sha(await readFile(file))}));
    if(!result.ok)fatal??=Error('CAS acceptance or owned cleanup failed.');
}
if(fatal){console.error(String(fatal.stack??fatal).replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted database]'));process.exitCode=1;}
