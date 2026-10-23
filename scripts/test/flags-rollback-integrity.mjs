import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {admit,ownedConnection,faultClient} from './package-publication-rollback.fixture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),phase=process.env.FLAGS_ROLLBACK_PHASE;
assert.ok(['baseline','candidate'].includes(phase));assert.ok(Number(process.versions.node.split('.')[0])>=24);
const candidate=process.env.FLAGS_ROLLBACK_CANDIDATE,sourceFile=process.env.FLAGS_ROLLBACK_SOURCE_RECEIPT,connection=process.env.FLAGS_ROLLBACK_CONNECTION_FILE;
for(const file of [candidate,sourceFile,connection])assert.ok(file&&path.isAbsolute(file),'Select explicit frozen candidate, source receipt and private owned connection.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const freeze=JSON.parse(await readFile(sourceFile));
async function hashes(){
    const result={sourceReceipt:sha(await readFile(sourceFile))};
    for(const name of freeze.sourceFiles){
        assert.ok(!path.isAbsolute(name)&&!name.split('/').includes('..'));
        const digest=sha(await readFile(path.join(candidate,name)));assert.equal(digest,freeze.hashes[name]);result['source:'+name]=digest;
        const live=sha(await readFile(path.join(root,name)));result['live:'+name]=live;if(phase==='candidate')assert.equal(live,digest);
    }
    const manifestFile=path.join(candidate,'../feature-flags-service-artifacts.json'),manifest=JSON.parse(await readFile(manifestFile));result.artifactManifest=sha(await readFile(manifestFile));
    for(const [file,digest]of Object.entries(manifest.files)){const actual=sha(await readFile(path.join(candidate,'services/feature-flags-service/dist',file)));assert.equal(actual,digest);result['compiled:'+file]=actual;}
    for(const name of ['flags-rollback-integrity.mjs','package-publication-rollback.fixture.mjs','owned-postgres.fixture.mjs'])result['qa:'+name]=sha(await readFile(path.join(root,'scripts/test',name)));
    return result;
}
const beforeHashes=await hashes(),require=createRequire(path.join(candidate,'services/feature-flags-service/package.json'));
const {Pool}=require('pg'),{FlagsRepository}=require(path.join(candidate,'services/feature-flags-service/dist/flags/flags.repository.js'));
const {migrateFeatureFlags,checkFeatureFlagsMigrations}=require(path.join(candidate,'services/feature-flags-service/dist/database/migrations.js'));
const {FEATURE_FLAGS}=require(path.join(candidate,'services/shared/feature-flags.cjs'));
const a=FEATURE_FLAGS[0],b=FEATURE_FLAGS.find(item=>item.key!==a.key);assert.ok(a&&b);
const output=path.join(root,'.run/flags-rollback-20261023');await mkdir(output,{recursive:true});const directory=await mkdtemp(path.join(output,phase+'-'));
const receipt={schemaVersion:1,phase,candidate,startedAt:new Date().toISOString(),inputHashes:beforeHashes,cases:[],cleanupErrors:[],limits:[
    'Compiled production repository and migrations with actual PostgreSQL; only driver ACK/ROLLBACK dispatch faults are injected into the owned session.',
    'Pool max1 matches deterministic reuse; production query/statement5s and idle-in-transaction15s remain enabled. Observer uses a separate pool.',
    'No HTTP, Gateway/RBAC middleware, browser, real network failure, CI or production acceptance. Other B09 service candidates remain separate.',
]};
const failure=error=>({name:error?.name,code:error?.code,message:String(error?.message??error).slice(0,1000)});
async function snapshot(db){
    const history=(await db.query("SELECT to_regclass('feature_flags_schema_migrations') AS relation")).rows[0].relation;
    return {flags:(await db.query('SELECT * FROM feature_flags ORDER BY flag_key')).rows,events:(await db.query('SELECT * FROM security_events ORDER BY event_id')).rows,
        history:history?(await db.query('SELECT * FROM feature_flags_schema_migrations ORDER BY version')).rows:null};
}
async function one(boundary,rollback){
    const e={boundary,rollback,control:rollback!=='not-dispatched'},name='nc_flags_rb_'+randomUUID().replaceAll('-','');let admin,writer,observer,fault,created=false,databases;
    try{
        await admit(connection);const admitted=await ownedConnection(connection);admin=new Pool({connectionString:admitted.url.href,max:1,connectionTimeoutMillis:3000,query_timeout:5000});
        databases=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
        await admin.query('CREATE DATABASE "'+name+'"');created=true;const url=new URL(admitted.url);url.pathname='/'+name;
        writer=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000,idle_in_transaction_session_timeout:15000});writer.on('error',()=>{});
        observer=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,query_timeout:5000,statement_timeout:5000});observer.on('error',()=>{});
        const repo=new FlagsRepository(writer);await repo.setup();
        if(boundary==='setup')await writer.query('DELETE FROM feature_flags WHERE flag_key=$1',[a.key]);
        if(boundary==='migrate')await writer.query('DROP TABLE feature_flags_schema_migrations');
        e.before=await snapshot(observer);const initialA=e.before.flags.find(row=>row.flag_key===a.key),initialB=e.before.flags.find(row=>row.flag_key===b.key);
        const primary=Object.assign(Error('Owned '+boundary+' response lost after SQL'),{code:'OWNED_ACK_LOST'}),pattern=boundary==='patch'?/^INSERT INTO security_events/:boundary==='setup'?/^INSERT INTO feature_flags\(/:boundary==='migrate'?/^INSERT INTO feature_flags_schema_migrations/:/^SELECT version,name,checksum/;
        let checkouts=0;const pool=new Proxy(writer,{get(target,key){
            if(key==='connect')return async()=>{
                const raw=await writer.connect();if(++checkouts!==(boundary==='setup'?2:1))return raw;e.firstPid=raw.processID;
                try{
                e.firstSettings=(await raw.query("SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS statement_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout")).rows[0];
                assert.equal(e.firstSettings.pid,e.firstPid);assert.equal(e.firstSettings.statement_timeout,'5s');assert.equal(e.firstSettings.idle_in_transaction_session_timeout,'15s');
                e.queryTimeoutMs=writer.options.query_timeout;assert.equal(e.queryTimeoutMs,5000);
                const observed=new Proxy(raw,{get(client,property){
                    if(property==='query')return async(sql,...args)=>{const result=await raw.query(sql,...args);if(pattern.test(typeof sql==='string'?sql:sql.text))e.faultTarget={sql,values:args[0],rowCount:result.rowCount,rows:result.rows};return result;};
                    const value=Reflect.get(client,property);return typeof value==='function'?value.bind(client):value;
                }});
                fault=faultClient(observed,{rollback,writePattern:pattern,primary});return fault.client;
                }catch(error){raw.release(true);throw error;}
            };
            const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
        }}),first=new FlagsRepository(pool);
        let error;try{if(boundary==='patch')await first.patch(a.key,{enabled:!a.defaultEnabled,expectedRevision:Number(initialA.revision)},async()=>'failed@example.test');else if(boundary==='setup')await first.setup();else if(boundary==='migrate')await migrateFeatureFlags(pool);else await checkFeatureFlagsMigrations(pool,true);}catch(caught){error=caught;}
        assert.equal(error,primary);assert.ok(fault.events.some(item=>pattern.test(item.sql)&&item.executed));assert.equal(e.faultTarget.rowCount,1);
        if(boundary==='setup')assert.deepEqual(e.faultTarget.values,[a.key]);if(boundary==='migrate')assert.equal(e.faultTarget.values[0],1);
        e.primaryError=failure(error);e.firstReleaseDestroy=fault.releaseArgument();
        const failedAt=performance.now();e.afterFailure=await snapshot(observer);assert.deepEqual(e.afterFailure,e.before);
        e.sessionAfterFailure=(await observer.query('SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1',[e.firstPid])).rows;
        let secondPid;const acquired=client=>{secondPid=client.processID;};writer.on('acquire',acquired);
        const body={enabled:!b.defaultEnabled,expectedRevision:Number(initialB.revision)};let secondError;
        try{e.secondStartedAfterFailureMs=performance.now()-failedAt;assert.ok(e.secondStartedAfterFailureMs<5000);e.second=await repo.patch(b.key,body,async()=>'next@example.test');}
        catch(caught){secondError=caught;e.secondError=failure(caught);}finally{writer.off('acquire',acquired);}
        e.secondPid=secondPid;e.afterSecond=await snapshot(observer);e.sql=fault.events;e.notices=fault.notices;
        const unsafe=phase==='baseline'&&rollback==='not-dispatched';
        if(unsafe){
            assert.equal(secondPid,e.firstPid);assert.equal(e.firstReleaseDestroy,false);assert.equal(e.sessionAfterFailure[0]?.state,'idle in transaction');
            assert.ok(e.notices.some(item=>item.code==='25001'));
            if(boundary==='readonly'){assert.equal(secondError?.code,'25006');assert.deepEqual(e.afterSecond,e.before);e.recoveredSecond=await repo.patch(b.key,body,async()=>'next@example.test');}
            else{assert.equal(secondError,undefined);if(boundary==='patch'){const row=e.afterSecond.flags.find(row=>row.flag_key===a.key);assert.equal(Number(row.revision),Number(initialA.revision)+1);assert.equal(row.overrides.enabled,!a.defaultEnabled);assert.equal(e.afterSecond.events.filter(row=>row.resource_id===a.key).length,1);}
                else if(boundary==='setup')assert.ok(e.afterSecond.flags.some(row=>row.flag_key===a.key));else assert.equal(e.afterSecond.history.length,1);}
            e.expectedRed=true;
        }else{
            assert.equal(secondError,undefined);assert.equal(e.firstReleaseDestroy,phase==='candidate'&&rollback!=='normal');
            assert.equal(secondPid===e.firstPid,rollback==='normal'||phase==='baseline');
            assert.deepEqual(e.afterSecond.flags.filter(row=>row.flag_key!==b.key),e.before.flags.filter(row=>row.flag_key!==b.key));assert.deepEqual(e.afterSecond.history,e.before.history);
            assert.equal(e.afterSecond.events.filter(row=>row.resource_id===a.key).length,0);
        }
        const after=await snapshot(observer),changed=after.flags.find(row=>row.flag_key===b.key);assert.equal(Number(changed.revision),Number(initialB.revision)+1);assert.equal(changed.overrides.enabled,body.enabled);
        const events=after.events.filter(row=>row.resource_id===b.key);assert.equal(events.length,1);assert.equal(events[0].actor,'next@example.test');assert.equal(events[0].action,'feature_flag.update');assert.equal(events[0].before_state.revision,Number(initialB.revision));assert.equal(events[0].after_state.revision,Number(initialB.revision)+1);
        await repo.setup();const stable=await snapshot(observer),current=(await repo.list()).find(flag=>flag.key===b.key);assert.equal(current.revision,Number(initialB.revision)+1);assert.equal(current.enabled,body.enabled);
        let authorizations=0;await repo.patch(b.key,{...body,expectedRevision:current.revision},async()=>{authorizations++;return'next@example.test';});
        await assert.rejects(repo.patch(b.key,{enabled:!body.enabled,expectedRevision:current.revision-1},async()=>{authorizations++;return'next@example.test';}),error=>error.getStatus?.()===409);
        assert.equal(authorizations,2);assert.deepEqual(await snapshot(observer),stable);e.retrySetupAndCasHealthy=true;e.ok=!e.expectedRed;
    }catch(error){e.failure=failure(error);}
    finally{
        const errors=[];if(fault&&!fault.released())try{fault.client.release(true);}catch(error){errors.push(failure(error));}
        for(const pool of [writer,observer])if(pool)try{await pool.end();}catch(error){errors.push(failure(error));}
        if(created)try{await admin.query('DROP DATABASE "'+name+'"');e.ownDatabaseDropped=true;}catch(error){errors.push(failure(error));}
        if(admin){
            try{e.originalDatabasesPreserved=JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows)===JSON.stringify(databases);}catch(error){errors.push({resource:'database inventory',...failure(error)});}
            try{await admin.end();}catch(error){errors.push({resource:'admin close',...failure(error)});}
        }
        e.cleanupErrors=errors;if(errors.length||created&&(!e.ownDatabaseDropped||!e.originalDatabasesPreserved))receipt.cleanupErrors.push({boundary,rollback,errors});receipt.cases.push(e);
    }
}
try{for(const boundary of ['patch','setup','migrate','readonly'])for(const rollback of ['normal','not-dispatched','ack-lost'])await one(boundary,rollback);}
catch(error){receipt.initializationFailure=failure(error);}
finally{
    try{receipt.finalInputHashes=await hashes();assert.deepEqual(receipt.finalInputHashes,beforeHashes);}catch(error){receipt.cleanupErrors.push({resource:'input binding',...failure(error)});}
    const reds=receipt.cases.filter(item=>!item.control),controls=receipt.cases.filter(item=>item.control);
    receipt.causalRed=phase==='baseline'&&reds.length===4&&reds.every(item=>item.expectedRed&&!item.failure)&&controls.length===8&&controls.every(item=>item.ok)&&!receipt.cleanupErrors.length;
    receipt.ok=receipt.cases.length===12&&receipt.cases.every(item=>item.ok)&&!receipt.initializationFailure&&!receipt.cleanupErrors.length;receipt.finishedAt=new Date().toISOString();
    const file=path.join(directory,'receipt.json');await writeFile(file,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    process.stdout.write(JSON.stringify({phase,receipt:file,sha256:sha(await readFile(file)),ok:receipt.ok,causalRed:receipt.causalRed,cases:receipt.cases.map(({boundary,rollback,ok,expectedRed,failure})=>({boundary,rollback,ok,expectedRed,failure})),cleanupErrors:receipt.cleanupErrors})+'\n');process.exitCode=receipt.ok?0:1;
}
