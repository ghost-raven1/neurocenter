import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';
import {releaseCancellationLease} from './tool-build-cancellation-lease.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const {evaluateFeatureFlags,defaultFeatureFlags}=require('../../services/shared/feature-flags.cjs');
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export const settled=promise=>promise.then(value=>({ok:true,value}),error=>({ok:false,error}));

/** Conditions are observed through PostgreSQL, rather than assuming a sleep imposed a race order. */
export async function until(read,label,timeout=8000){
    const end=Date.now()+timeout;
    while(Date.now()<end){const result=await read();if(result)return result;await delay(20);}
    throw Error('Timed out waiting for '+label);
}

/** A private database and loopback notifications/flags fixture; no production fallback is accepted. */
export async function cancellationFixture(){
    const adminUrl=ownedTestPostgresAdmin(process.env.TOOL_BUILD_CANCEL_TEST_PG_URL).href;
    const dist=process.env.TOOL_BUILD_TEST_DIST;
    assert.ok(dist&&path.isAbsolute(dist),'TOOL_BUILD_TEST_DIST must select an explicitly built candidate.');
    const original={...process.env},database='nc_build_cancel_'+randomUUID().replaceAll('-','');
    const admin=new Pool({connectionString:adminUrl,max:2,application_name:'neurocenter-owned-build-cancellation-admin'});
    admin.on('error',()=>{});
    let created=false,pool,catalog,access,service,lease,server,before,folder;
    const receipt={schemaVersion:1,ok:false,checks:[],failures:[],limits:[
        'Explicit caller-owned local PostgreSQL and private fixtures only.',
        'Repository race cases use real SQL locks; fixture flags/notifications replace external services.',
        'This run is not browser, real IdP, cross-host or production acceptance.',
    ]};
    let flags=defaultFeatureFlags();const requests=[];
    async function close(){
        const errors=[];
        for(const [name,cleanup] of [['service',()=>service?.onModuleDestroy()],['access',()=>access?.onModuleDestroy()],
            ['lease',async()=>{if(lease){const owned=lease;lease=undefined;await releaseCancellationLease(owned);}}],
            ['pool',()=>pool?.end()],['catalog',()=>catalog?.close()]])try{await cleanup();}catch(error){errors.push({resource:name,message:error.message});}
        if(server)try{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}catch(error){errors.push({resource:'http fixture',message:error.message});}
        if(created)try{await admin.query('DROP DATABASE "'+database+'"');receipt.ownDatabaseDropped=true;}catch(error){errors.push({resource:'database',message:error.message});receipt.ownDatabaseDropped=false;}
        try{const after=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
            receipt.originalDatabasesPreserved=JSON.stringify(before)===JSON.stringify(after);}catch(error){errors.push({resource:'inventory',message:error.message});}
        try{await admin.end();}catch(error){errors.push({resource:'admin pool',message:error.message});}
        for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);
        receipt.cleanupErrors=errors;receipt.finishedAt=new Date().toISOString();
        receipt.ok=receipt.failures.length===0&&errors.length===0&&receipt.ownDatabaseDropped===true&&receipt.originalDatabasesPreserved===true;
        if(folder)await writeFile(path.join(folder,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
        return receipt;
    }
    try{
        await mkdir(path.join(root,'.run'),{recursive:true});folder=await mkdtemp(path.join(root,'.run/tool-build-cancellation-'));
        before=(await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
        await admin.query('CREATE DATABASE "'+database+'"');created=true;
        const url=new URL(adminUrl);url.pathname='/'+database;
        server=createServer((request,response)=>{
            requests.push({method:request.method,path:request.url});
            if(request.method==='GET'&&request.url==='/internal/feature-flags/evaluated'){
                response.setHeader('Content-Type','application/json');response.end(JSON.stringify(evaluateFeatureFlags(flags)));
            }else if(request.method==='POST'&&request.url==='/internal/events'){request.resume();response.statusCode=204;response.end();}
            else{request.resume();response.statusCode=404;response.end();}
        });
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const fixtureUrl='http://127.0.0.1:'+server.address().port;
        Object.assign(process.env,{CATALOG_PG_URL:url.href,NODE_ENV:'production',SSO_DISABLE:'false',
            FEATURE_FLAGS_SERVICE_URL:fixtureUrl,API_GATEWAY_URL:fixtureUrl,NEUROCENTER_INTERNAL_TOKEN:randomUUID(),
            RUNTIME_ARTIFACT_DIR:path.join(folder,'runtime'),CAPACITY_REQUIRED:'false'});
        const load=relative=>require(path.join(dist,relative));
        const {CatalogDb}=load('catalog/catalog-db.js'),{AccessDb}=load('access/access-db.js');
        const {PackageBuildRepository}=load('package-build/package-build.repository.js');
        const {PackageBuildService}=load('package-build/package-build.service.js');
        catalog=new CatalogDb(url.href);await catalog.setup();
        pool=new Pool({connectionString:url.href,max:8,application_name:'neurocenter-owned-build-cancellation'});pool.on('error',()=>{});
        const actor={email:'build-cancellation@example.test',activeRole:'Главный админ'};
        await pool.query("INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,'Owned cancellation fixture',true)",[actor.email]);
        access=new AccessDb();await access.ready();
        const repository=new PackageBuildRepository(pool);
        service=new PackageBuildService(access,{}, {ensureSchema:async()=>{}},{});
        lease=await pool.connect();await lease.query('SELECT pg_advisory_lock(72465395)');
        const leasePid=Number((await lease.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const releaseWorkerGate=async()=>{if(lease){const owned=lease;lease=undefined;await releaseCancellationLease(owned,false);}};
        receipt.database=database;receipt.dist=dist;receipt.startedAt=new Date().toISOString();receipt.leasePid=leasePid;
        const configuration={kind:'plugin',name:'Owned cancellation fixture',description:'Private SQL acceptance',targets:['darwin-arm64'],tags:[],
            source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default async()=>({})'}]}};
        const row=id=>repository.get(id);
        const enqueue=(key=randomUUID(),email=actor.email)=>repository.enqueue(email,key,'fixture-'+key,configuration);
        const running=async()=>{const queued=await enqueue();const claimed=await repository.takeQueued(lease);assert.equal(claimed.id,queued.id);return claimed;};
        const blockedBy=async pid=>(await pool.query('SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rows;
        async function check(name,execute){
            const started=Date.now();
            try{const evidence=await execute();receipt.checks.push({name,ok:true,durationMs:Date.now()-started,evidence:evidence??null});}
            catch(error){receipt.failures.push({name,message:error.message,stack:error.stack});throw error;}
            finally{await pool.query("UPDATE tool_build_jobs SET state='FAILED' WHERE state IN ('QUEUED','RUNNING','CANCELLING')");}
        }
        return {root,folder,receipt,pool,repository,service,access,actor,lease,leasePid,configuration,load,row,enqueue,running,blockedBy,requests,releaseWorkerGate,
            setFlags:next=>{flags={...flags,...next};},check,close};
    }catch(error){receipt.failures.push({name:'fixture initialization',message:error.message,stack:error.stack});await close();throw error;}
}
