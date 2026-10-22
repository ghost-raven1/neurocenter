import assert from 'node:assert/strict';
import {test as nativeTest} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {checkQaSourcesAndClose,faultClient,publicationFixture} from '../package-publication-rollback.fixture.mjs';

const harnessFiles=[new URL('./package-publication-rollback.test.mjs',import.meta.url),new URL('../package-publication-rollback.fixture.mjs',import.meta.url)];
const hashes=async()=>Object.fromEntries(await Promise.all(harnessFiles.map(async file=>[file.pathname,createHash('sha256').update(await readFile(file)).digest('hex')])));
const initialHashes=await hashes();
const fixture=await publicationFixture();
const {receipt,pool,observer,actor,load,writer,createService,skillSources}=fixture;
receipt.harnessHashes=initialHashes;receipt.harnessFailures=[];
/** Harness setup failures must never leave a misleading GREEN receipt beside a nonzero TAP run. */
const test=(name,run)=>nativeTest(name,async()=>{try{return await run();}catch(error){receipt.harnessFailures.push({name,message:error.message});throw error;}});
const {PluginRepository}=load('publication/plugin-repository.js'),{PackageBuildRepository}=load('package-build/package-build.repository.js');
const observedError=async run=>{try{await run();return undefined;}catch(error){return error;}};
const invariant=(name,passed)=>({name,passed});
async function pluginRows(key){
    const card=(await observer.query('SELECT * FROM ai_plugins WHERE publication_key=$1',[key])).rows;
    const ids=card.map(row=>row.id);
    const versions=(await observer.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=ANY($1::text[]) ORDER BY ai_plugin_id,version',[ids])).rows;
    const audit=(await observer.query("SELECT * FROM security_events WHERE actor=$1 AND resource_id=ANY($2::text[]) ORDER BY event_id",[actor,ids])).rows;
    return{card,versions,audit};
}
async function skillRows(id){
    return{versions:(await observer.query('SELECT * FROM asset_source_versions WHERE external_id=$1 ORDER BY asset_version',[id])).rows,
        receipts:(await observer.query('SELECT * FROM asset_source_receipts WHERE external_id=$1',[id])).rows};
}
async function cleanFault(fault){
    if(!fault.released()){
        try{await fault.rawQuery('ROLLBACK');}finally{fault.client.release(true);}
    }
}
const config=slug=>({kind:'skill',name:'Owned '+slug,description:'Actual PostgreSQL rollback boundary',tags:[],targets:[],source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: '+slug+'\ndescription: Owned rollback regression\n---\n\nPrivate fixture instruction.'}]}});

try{
    for(const rollback of ['not-dispatched','normal'])await test('PluginRepository own transaction: '+rollback+' ROLLBACK preserves primary and prevents later borrower ghost COMMIT',async()=>{
        const key=randomUUID(),source=writer(),raw=await source.connect(),fault=faultClient(raw,{rollback});
        const pid=Number((await fault.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid),primary=new Error('Owned afterCreate receipt failed');
        const repository=new PluginRepository({connect:async()=>fault.client});
        let evidence;
        try{
            const error=await observedError(()=>repository.create({name:'Owned plugin '+key,kind:'mcp',description:'Publication rollback regression',origin:'upload',tags:[],files:[],config:{transport:'remote',url:'https://example.test/mcp'},publicationKey:key},actor,async()=>{throw primary;}));
            const before=await pluginRows(key),next=await source.connect();let nextPid;
            try{nextPid=Number((await next.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await next.query('SELECT 1 AS unrelated_borrower');await next.query('COMMIT');}finally{next.release();}
            const after=await pluginRows(key);
            const invariants=[invariant('primary error identity retained',error===primary),invariant('observer sees no failed publication before unrelated COMMIT',before.card.length===0),invariant('observer sees no failed publication after unrelated COMMIT',after.card.length===0),invariant('normal rollback reuses PID; unknown rollback discards it',rollback==='normal'?nextPid===pid:nextPid!==pid),invariant('release destroys unknown rollback session',rollback==='normal'?!fault.releaseArgument():!!fault.releaseArgument())];
            evidence={owner:'PluginRepository',rollback,pid,nextPid,error:{name:error?.name,message:error?.message,primaryRetained:error===primary,rollbackErrorReturned:error===fault.rollbackError},releaseArgument:fault.releaseArgument(),beforeCounts:Object.fromEntries(Object.entries(before).map(([name,rows])=>[name,rows.length])),afterCounts:Object.fromEntries(Object.entries(after).map(([name,rows])=>[name,rows.length])),events:fault.events,invariants};
            receipt.cases.push(evidence);assert.ok(invariants.every(item=>item.passed),JSON.stringify(evidence));
        }finally{await cleanFault(fault);}
    });

    for(const rollback of ['not-dispatched','normal'])await test('executeSkill borrowed lease: '+rollback+' ROLLBACK cannot ghost-commit source receipt when next queue item starts',async()=>{
        const slug='owned-lease-'+randomUUID().slice(0,8),native=await skillSources(slug),source=writer(),raw=await source.connect();
        const fault=faultClient(raw,{rollback,writePattern:/^INSERT INTO asset_source_receipts\(/});
        const pid=Number((await fault.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid),service=createService(native.source),repository=new PackageBuildRepository(pool,client=>service.discardLease(client));
        service.repository=repository;service.lease=fault.client;service.releaseLease=destroy=>{if(!fault.released())fault.client.release(destroy);};
        let queued,row,next;
        try{
            await fault.rawQuery('SELECT pg_advisory_lock(72465395)');
            queued=await repository.enqueue(actor,randomUUID(),'first-'+slug,config(slug));row=await repository.takeQueued(fault.client);
            assert.equal(row.id,queued.id);const stage=path.join(native.folder,'stage');await mkdir(stage);
            const error=await observedError(()=>service.executeSkill(row,stage)),before=await skillRows('skill-'+slug);
            const active=(await pool.query("SELECT pid,state,xact_start IS NOT NULL AS transaction_open FROM pg_stat_activity WHERE pid=$1",[pid])).rows;
            await repository.progress(row.id,'FAILED',0,'Owned primary failure recorded outside the uncertain lease');
            next=await repository.enqueue(actor,randomUUID(),'next-'+slug,{kind:'plugin',name:'Next unrelated '+slug,description:'Next queue item',tags:[],targets:[],source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default {}'}]}});
            let nextResult,nextError;
            try{nextResult=await service.withLease(fault.client,()=>repository.takeQueued(fault.client));}catch(error){nextError=error;}
            const after=await skillRows('skill-'+slug),nativeSkill=await native.skills.getSkill('common/'+slug),state=(await pool.query('SELECT state FROM tool_build_jobs WHERE id=$1',[row.id])).rows[0].state;
            const invariants=[invariant('primary ACK error retained',error===fault.primary),invariant('observer sees no failed SQL receipt before next work',before.versions.length===0&&before.receipts.length===0),invariant('observer sees no failed SQL receipt after next work',after.versions.length===0&&after.receipts.length===0),invariant('tainted lease invalidated; healthy rolled back lease remains usable',rollback==='normal'?!!nextResult&&nextResult.id===next.id:service.lease!==fault.client),invariant('native journal retained one actual version',nativeSkill.meta.version===1),invariant('failed first job is not reported as succeeded',state==='FAILED')];
            const evidence={owner:'executeSkill',rollback,pid,firstJob:row.id,nextJob:next.id,nextClaimed:nextResult?.id,nextError:nextError?.message,error:{name:error?.name,message:error?.message,primaryRetained:error===fault.primary},leaseRetained:service.lease===fault.client,activityAfterFailure:active,nativeVersion:nativeSkill.meta.version,beforeCounts:{versions:before.versions.length,receipts:before.receipts.length},afterCounts:{versions:after.versions.length,receipts:after.receipts.length},events:fault.events,notices:fault.notices,invariants};receipt.cases.push(evidence);assert.ok(invariants.every(item=>item.passed),JSON.stringify(evidence));
        }finally{
            service.lease=undefined;service.releaseLease=undefined;
            try{await fault.rawQuery('SELECT pg_advisory_unlock(72465395)');}catch{}
            await cleanFault(fault);
            await pool.query("UPDATE tool_build_jobs SET state='FAILED' WHERE id=ANY($1::uuid[]) AND state IN ('QUEUED','RUNNING')",[[queued?.id,next?.id].filter(Boolean)]);
        }
    });

    for(const rollback of ['not-dispatched','normal'])await test('importSkillAsset own client: '+rollback+' ROLLBACK prevents later borrower source receipt COMMIT',async()=>{
        const slug='owned-import-'+randomUUID().slice(0,8),native=await skillSources(slug),source=writer(),raw=await source.connect(),fault=faultClient(raw,{rollback,writePattern:/^INSERT INTO asset_source_receipts\(/});
        const pid=Number((await fault.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid),service=createService(native.source),key=randomUUID(),stage=path.join(native.folder,'stage');await mkdir(stage);
        const built=await load('package-build/build-skill.js').buildSkillAsset(config(slug),stage);
        await native.ingest.prepare(built.asset,key,built.sourceFile);
        service.pool={connect:async()=>fault.client};
        try{
            const error=await observedError(()=>service.importSkillAsset({email:actor,activeRole:'Главный админ'},built.asset,key)),before=await skillRows(built.asset.id),next=await source.connect();let nextPid;
            try{nextPid=Number((await next.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await next.query('SELECT 1 AS unrelated_borrower');await next.query('COMMIT');}finally{next.release();}
            const after=await skillRows(built.asset.id),nativeSkill=await native.skills.getSkill('common/'+slug);
            const invariants=[invariant('primary ACK error retained',error===fault.primary),invariant('observer sees no failed SQL receipt before unrelated COMMIT',before.versions.length===0&&before.receipts.length===0),invariant('observer sees no failed SQL receipt after unrelated COMMIT',after.versions.length===0&&after.receipts.length===0),invariant('normal rollback reuses PID; unknown rollback discards it',rollback==='normal'?nextPid===pid:nextPid!==pid),invariant('release destroys unknown rollback session',rollback==='normal'?!fault.releaseArgument():!!fault.releaseArgument()),invariant('native journal retained one actual version',nativeSkill.meta.version===1)];
            const evidence={owner:'importSkillAsset',rollback,pid,nextPid,error:{name:error?.name,message:error?.message,primaryRetained:error===fault.primary},releaseArgument:fault.releaseArgument(),nativeVersion:nativeSkill.meta.version,beforeCounts:{versions:before.versions.length,receipts:before.receipts.length},afterCounts:{versions:after.versions.length,receipts:after.receipts.length},events:fault.events,invariants};receipt.cases.push(evidence);assert.ok(invariants.every(item=>item.passed),JSON.stringify(evidence));
        }finally{await cleanFault(fault);}
    });
}finally{
    receipt.causalFailures=receipt.cases.filter(row=>row.invariants.some(item=>!item.passed)).map(row=>({owner:row.owner,rollback:row.rollback,failedInvariants:row.invariants.filter(item=>!item.passed).map(item=>item.name)}));
    await checkQaSourcesAndClose({readHashes:hashes,expectedHashes:receipt.harnessHashes,onHashes:value=>{receipt.harnessHashesAfter=value;},
        onHashFailure:error=>{receipt.harnessFailures.push({name:'QA source stability',message:error.message});process.exitCode=1;},
        close:async()=>{
            receipt.status=receipt.causalFailures.length?'CAUSAL_RED':receipt.harnessFailures.length?'HARNESS_FAILED':'GREEN';
            return fixture.close();
        }});
}
