import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {versionCasFixture,deadline,deferred,settled,until} from './tool-build-version-cas.fixture.mjs';
import {root,publicationFixture} from './package-publication-rollback.fixture.mjs';

export {deadline,deferred,settled,until};
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const output=path.join(root,'.run/packaging-publication-deadline-20261023');
export const phase=process.env.TOOL_BUILD_PUBLICATION_DEADLINE_PHASE??'candidate';
assert.ok(['baseline','candidate'].includes(phase),'Choose baseline or candidate deadline acceptance.');
export function timeoutMilliseconds(value){const match=/^(\d+(?:\.\d+)?)(ms|s|min)?$/.exec(value);assert.ok(match,'Unexpected PostgreSQL SHOW timeout: '+value);return Number(match[1])*({ms:1,s:1000,min:60000}[match[2]]??1);}
export function assertTimeouts(actual,lockMs,statementMs){assert.equal(timeoutMilliseconds(actual.lock_timeout),lockMs);assert.equal(timeoutMilliseconds(actual.statement_timeout),statementMs);}
export async function showTimeouts(client){return {lock_timeout:(await client.query('SHOW lock_timeout')).rows[0].lock_timeout,
    statement_timeout:(await client.query('SHOW statement_timeout')).rows[0].statement_timeout};}

/** Candidate admission also pins the new compiled helper, not only its callers. */
export async function deadlineHelperProof(){
    if(phase==='baseline')return {phase,helperAbsentExpected:true};
    const dist=process.env.TOOL_BUILD_TEST_DIST;assert.ok(dist&&path.isAbsolute(dist));
    const manifest=JSON.parse(await readFile(path.resolve(dist,'../../../../catalog-service-artifacts.json'),'utf8'));
    const relative='package-build/publication-deadline.js',digest=sha(await readFile(path.join(dist,relative)));
    assert.equal(digest,manifest.files[relative]);
    const sourceFile=process.env.TOOL_BUILD_PUBLICATION_DEADLINE_SOURCE_RECEIPT;assert.ok(sourceFile&&path.isAbsolute(sourceFile));
    const bytes=await readFile(sourceFile),freeze=JSON.parse(bytes),sources={},compiled={};
    for(const file of freeze.sourceFiles){sources[file]=sha(await readFile(path.resolve(dist,'../../..',file)));assert.equal(sources[file],freeze.hashes[file]);}
    for(const file of ['package-build/publication-deadline.js','package-build/publish-built-tool.js','package-build/package-build.service.js','publication/plugin-repository.js']){
        compiled[file]=sha(await readFile(path.join(dist,file)));assert.equal(compiled[file],manifest.files[file]);
    }
    return {phase,compiledHelper:relative,sha256:digest,sourceReceiptSha256:sha(bytes),sources,compiled};
}
const aliases={TOOL_BUILD_VERSION_CAS_CONNECTION_FILE:'TOOL_BUILD_PUBLICATION_DEADLINE_CONNECTION_FILE',
    TOOL_BUILD_VERSION_CAS_SOURCE_RECEIPT:'TOOL_BUILD_PUBLICATION_DEADLINE_SOURCE_RECEIPT'};

/** Old real-builder archives are read-only sentinels; the inline CAS seed itself has no runtime archive. */
export async function retainedArchiveControl(){
    const file=process.env.TOOL_BUILD_PUBLICATION_DEADLINE_ARCHIVE_RECEIPT;
    assert.ok(file&&path.isAbsolute(file),'Select an explicit accepted real-builder archive receipt.');
    assert.ok(file.startsWith(path.join(root,'.run/tool-build-cancellation-')));
    const bytes=await readFile(file),receipt=JSON.parse(bytes);assert.equal(receipt.ok,true);
    const inventory=new Map();
    for(const check of receipt.checks)for(const archive of check.evidence?.source?.archives??[]){
        assert.match(archive.sha256,/^[a-f0-9]{64}$/);assert.ok(archive.bytes>0);
        inventory.set(archive.sha256,{...archive,path:path.join(path.dirname(file),'runtime',archive.sha256+'.tar.gz')});
    }
    assert.ok(inventory.size,'The external control must contain actual runtime archive evidence.');
    const inspect=async()=>Promise.all([...inventory.values()].map(async item=>{
        const bytes=await readFile(item.path);assert.equal(bytes.length,item.bytes);assert.equal(sha(bytes),item.sha256);
        return {path:item.path,sha256:item.sha256,bytes:bytes.length};
    }));
    const before=await inspect();return {receipt:file,receiptSha256:sha(bytes),before,verify:async()=>{const after=await inspect();assert.deepEqual(after,before);return after;}};
}

/** Reuse existing ownership/source admission unchanged; only explicit B11 inputs are translated. */
export async function publicationDeadlineFixture(){
    const original={};
    for(const source of Object.values(aliases))assert.ok(process.env[source]&&path.isAbsolute(process.env[source]),'Explicit '+source+' is required.');
    for(const [target,source]of Object.entries(aliases)){
        const value=process.env[source];
        original[target]=process.env[target];process.env[target]=value;
    }
    const restore=()=>{for(const [key,value]of Object.entries(original))if(value===undefined)delete process.env[key];else process.env[key]=value;};
    let f;
    try{f=await versionCasFixture();}catch(error){restore();throw error;}
    f.receipt.scope='Helper-only real publication SQL deadline diagnostic after a committed publication fence';
    f.receipt.limits.push('No worker FAILED/queue continuation claim: this baseline invokes actual publishBuiltTool, not Service.execute.');
    f.receipt.limits.push('Finite 8-second lock observation only; this does not claim empirically infinite waiting.');
    const show=showTimeouts;
    const committedRow=async id=>(await f.observer.query('SELECT id,state,publication_started_at,result,error FROM tool_build_jobs WHERE id=$1',[id])).rows[0];
    const matches=(boundary,text,args,item)=>boundary==='native-row'?/^SELECT \* FROM ai_plugins WHERE id=\$1 AND kind=\$2 FOR UPDATE$/.test(text):
        text.includes('pg_advisory_xact_lock')&&args[0]?.[0]===(boundary==='asset-advisory'?'asset-management:plugin:'+item.card.id:'publication:dependency-graph');
    function instrument(boundary,item){
        const calls=[],inside=[];
        const client=new Proxy(f.lease,{get(target,key){if(key==='query')return async(sql,...args)=>{
            const text=typeof sql==='string'?sql:sql.text;calls.push({sql:text,at:new Date().toISOString()});
            if(!inside.length&&matches(boundary,text,args,item))inside.push({settings:await show(target),at:new Date().toISOString(),sql:text});
            return target.query(sql,...args);
        };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        return {client,calls,inside};
    }
    async function sourceB(item){const bytes=await readFile(await f.blobs.checkedPath(item.b.prepared.asset.source.sha256,item.b.bytes.length));
        assert.deepEqual(bytes,item.b.bytes);return {sha256:sha(bytes),bytes:bytes.length};}
    async function close(){try{return await f.close();}finally{restore();}}
    return {...f,show,committedRow,instrument,sourceB,close};
}

/** The existing native skill fixture supplies real storage/controller calls, not a fake publication result. */
export async function skillDeadlineFixture(){
    const mapping={PACKAGE_PUBLICATION_ROLLBACK_CONNECTION_FILE:process.env.TOOL_BUILD_PUBLICATION_DEADLINE_CONNECTION_FILE,
        PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT:process.env.TOOL_BUILD_PUBLICATION_DEADLINE_SOURCE_RECEIPT,
        PACKAGE_PUBLICATION_ROLLBACK_CANDIDATE:path.resolve(process.env.TOOL_BUILD_TEST_DIST,'../../..'),
        PACKAGE_PUBLICATION_ROLLBACK_RECEIPT_NAME:'b11-skill-'+randomUUID()+'.json'};
    for(const value of Object.values(mapping))assert.ok(typeof value==='string'&&value.length);
    const prior=Object.fromEntries(Object.keys(mapping).map(key=>[key,process.env[key]]));Object.assign(process.env,mapping);
    const restore=()=>{for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;};
    let f;try{f=await publicationFixture();}catch(error){restore();throw error;}
    f.receipt.limits.push('B11 calls actual Service.execute for a skill; native Skills controller is routed in-process.');
    return {...f,close:async()=>{try{return await f.close();}finally{restore();}}};
}

export async function saveDeadlineReceipt(receipt){
    await mkdir(output,{recursive:true});const file=path.join(output,'deadline-'+randomUUID()+'.json');
    await writeFile(file,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});return {file,sha256:sha(await readFile(file))};
}

/** A causal RED is narrower than any test failure: every required real-boundary witness must exist. */
export function isPublicationDeadlineCausalRed(receipt){
    const zero=value=>value?.lock_timeout==='0'&&value?.statement_timeout==='0';
    const edge=value=>Number.isInteger(value?.waiter)&&Number.isInteger(value?.blocker)&&value.blockers?.includes(value.blocker);
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    return receipt.cases.length===3&&receipt.failures.length===3&&!receipt.cleanupErrors.length
        &&same(receipt.harnessHashes,receipt.harnessHashesAfter)&&same(receipt.archiveControl.before,receipt.archiveControl.after)
        &&receipt.cases.every(item=>item.failure?.code==='ERR_ASSERTION'&&item.failure.message.startsWith('Publication stayed pending through the finite 8-second observation')
            &&zero(item.initialTimeouts)&&item.insideBeforeBlockedQuery?.length===1&&zero(item.insideBeforeBlockedQuery[0].settings)
            &&item.fence?.state==='RUNNING'&&!!item.fence.publication_started_at&&edge(item.edge)&&edge(item.edgeAtWatchdog)
            &&item.edge.waiter===item.edgeAtWatchdog.waiter&&item.edge.blocker===item.edgeAtWatchdog.blocker
            &&item.finishedWhileBlockerHeld===false&&item.outcome?.pendingAtDeadline===true&&item.outcome.observedBlockedMs>=receipt.watchdogMs
            &&item.actualDeleteWhileBlocked?.state==='RUNNING'&&!!item.actualDeleteWhileBlocked.publicationStartedAt
            &&item.oldSnapshotExactBeforeUnlock===true&&item.immutableVersion1Preserved===true
            &&item.sourceBWhileBlocked?.bytes>0&&same(item.sourceBWhileBlocked,item.sourceBAfter)
            &&same(item.rootArchivesAfter,receipt.archiveControl.before)&&item.afterHelper?.ok===true&&item.afterHelper.row.state==='SUCCEEDED'
            &&item.afterHelper.row.result?.version===2&&item.catalogVersionAfter===2&&zero(item.restoredTimeouts)
            &&item.cleanup?.ownDatabaseDropped===true&&item.cleanup.originalDatabasesPreserved===true&&item.cleanup.errors.length===0);
}
