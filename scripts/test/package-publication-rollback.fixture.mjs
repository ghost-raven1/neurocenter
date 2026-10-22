import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

export const root=fileURLToPath(new URL('../../',import.meta.url));
export const output=path.join(root,'.run/package-publication-rollback-20261023');
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool,Client}=require('pg');
const sha=value=>createHash('sha256').update(value).digest('hex');

/** Source evidence may fail to read; the already-owned database must still be closed. */
export async function checkQaSourcesAndClose({readHashes,expectedHashes,onHashes,onHashFailure,close}){
    let primary,current;
    try{current=await readHashes();onHashes?.(current);assert.deepEqual(current,expectedHashes,'QA source changed during the run.');}
    catch(error){primary=error;try{onHashFailure(error);}catch(failure){primary=new AggregateError([error,failure],'QA source failure reporting failed',{cause:error});}}
    try{return {result:await close(),hashes:current,sourceFailure:primary};}
    catch(error){if(primary)throw new AggregateError([primary,error],'QA source verification and owned cleanup failed',{cause:primary});throw error;}
}

/** A private identity file is admitted before any PostgreSQL client or pool exists. */
export async function ownedConnection(file){
    assert.ok(file&&path.isAbsolute(file),'Select the private connection file explicitly.');
    const real=path.resolve(file);assert.ok(real.startsWith(output+path.sep+'cluster-'));
    assert.equal((await stat(real)).mode&0o777,0o600);
    const config=JSON.parse(await readFile(real,'utf8')),url=ownedTestPostgresAdmin(config.adminUrl);
    const owner=JSON.parse(await readFile(config.ownerFile,'utf8'));
    assert.equal(config.nonce,owner.nonce);assert.equal(config.postgresPid,owner.postgresPid);
    assert.equal(config.dataDirectory,owner.dataDirectory);assert.equal(url.port,String(owner.port));
    assert.equal(path.dirname(real),owner.runDirectory);assert.ok(owner.leaseSeconds<=14400);
    assert.ok(Date.now()-Date.parse(owner.startedAt)<owner.leaseSeconds*1000,'Owned PG lease expired.');
    const pid=(await readFile(path.join(owner.dataDirectory,'postmaster.pid'),'utf8')).split('\n');
    assert.equal(Number(pid[0]),owner.postgresPid);assert.equal(pid[1],owner.dataDirectory);assert.equal(Number(pid[3]),owner.port);assert.equal(pid[7].trim(),'ready');
    process.kill(owner.supervisorPid,0);process.kill(owner.postgresPid,0);
    return{config,url,owner};
}

/** Real SQL proves this connection reaches the owned data directory, not another local database. */
export async function admit(file){
    const admitted=await ownedConnection(file),client=new Client({connectionString:admitted.url.href,connectionTimeoutMillis:3000});
    try{
        await client.connect();
        const row=(await client.query("SELECT pg_backend_pid() AS pid,current_setting('server_version') AS version,current_setting('data_directory') AS data_directory,current_setting('port')::int AS port,current_setting('listen_addresses') AS listen_addresses,current_setting('unix_socket_directories') AS sockets,current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,host(inet_server_addr()) AS server_addr,current_user AS role")).rows[0];
        assert.match(row.version,/^16\.15/);assert.equal(row.data_directory,admitted.owner.dataDirectory);assert.equal(row.port,admitted.owner.port);
        assert.equal(row.server_addr,'127.0.0.1');assert.equal(row.listen_addresses,'127.0.0.1');assert.equal(row.sockets,'');assert.equal(row.fsync,'on');assert.equal(row.full_page_writes,'on');assert.equal(row.role,'qa_owner');
        assert.equal((await client.query("SELECT rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname=current_user")).rows[0].scram,true);
        const receipt={ok:true,checkedAt:new Date().toISOString(),settings:row,privateConnectionFile:file,ownerNonce:admitted.owner.nonce,mainPostgresContacted:false};
        await writeFile(path.join(admitted.owner.runDirectory,'sql-admission.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
    }finally{await client.end();}
}

/** Fault only the driver ACK; normal writes and all observation still use actual PostgreSQL. */
export function faultClient(raw,{rollback='normal',writePattern,primary=new Error('Owned publication write ACK lost')}={}){
    const rollbackError=new Error('Owned ROLLBACK ACK lost'),events=[],notices=[];
    const query=raw.query.bind(raw);let injected=false,released=false,releaseArgument;
    raw.on('notice',notice=>notices.push({code:notice.code,message:notice.message}));
    const client=new Proxy(raw,{get(target,key){
        if(key==='query')return async(sql,...args)=>{
            const text=typeof sql==='string'?sql:sql.text;
            if(text==='ROLLBACK'&&rollback==='not-dispatched'){events.push({sql:text,executed:false});throw rollbackError;}
            const value=await query(sql,...args);events.push({sql:text,executed:true});
            if(text==='ROLLBACK'&&rollback==='ack-lost')throw rollbackError;
            if(writePattern?.test(text)&&!injected){injected=true;throw primary;}
            return value;
        };
        if(key==='release')return destroy=>{if(released)throw Error('Owned double release');released=true;releaseArgument=destroy;raw.release(destroy);};
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    return{client,primary,rollbackError,events,notices,rawQuery:query,released:()=>released,releaseArgument:()=>releaseArgument??false};
}

export async function publicationFixture(){
    await admit(process.env.PACKAGE_PUBLICATION_ROLLBACK_CONNECTION_FILE);
    const admitted=await ownedConnection(process.env.PACKAGE_PUBLICATION_ROLLBACK_CONNECTION_FILE);
    const candidate=process.env.PACKAGE_PUBLICATION_ROLLBACK_CANDIDATE;
    assert.ok(candidate&&path.isAbsolute(candidate),'Select the frozen compiled candidate repository.');
    const load=relative=>require(path.join(candidate,'services/catalog-service/dist',relative));
    const loadSkills=relative=>require(path.join(candidate,'services/skills-service/dist',relative));
    const sourceFiles=['services/catalog-service/src/package-build/package-build.service.ts','services/catalog-service/src/publication/plugin-repository.ts'];
    const sourceReceiptFile=process.env.PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT;
    const frozenReceipt=sourceReceiptFile?JSON.parse(await readFile(sourceReceiptFile,'utf8')):undefined;
    const baselineCommit=execFileSync('git',['rev-parse','365d973'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes={},liveSourceHashes={};
    for(const file of frozenReceipt?.sourceFiles??sourceFiles){
        const frozen=sha(await readFile(path.join(candidate,file))),expected=frozenReceipt?.hashes[file]??sha(execFileSync('git',['show',baselineCommit+':'+file],{cwd:root}));
        assert.equal(frozen,expected,'Candidate source mismatch with explicit frozen receipt/baseline '+file);
        sourceHashes[file]=frozen;liveSourceHashes[file]=sha(await readFile(path.join(root,file)));
    }
    const receiptName=process.env.PACKAGE_PUBLICATION_ROLLBACK_RECEIPT_NAME??'rollback-receipt.json';
    assert.match(receiptName,/^[a-z0-9-]+\.json$/);
    const artifacts=JSON.parse(await readFile(path.join(candidate,'../catalog-service-artifacts.json'),'utf8'));
    for(const file of ['package-build/package-build.service.js','publication/plugin-repository.js','asset-sources/local-skill-ingest.js'])assert.equal(sha(await readFile(path.join(candidate,'services/catalog-service/dist',file))),artifacts.files[file],'Compiled artifact mismatch '+file);
    const original={...process.env},name='nc_publication_rb_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:admitted.url.href,max:1});
    const before=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
    let created=false,pool,observer,server,access;const extras=[],receipt={schemaVersion:1,startedAt:new Date().toISOString(),baselineCommit,candidate,sourceReceiptFile,sourceReceiptSha256:sourceReceiptFile?sha(await readFile(sourceReceiptFile)):undefined,sourceHashes,liveSourceHashes,liveSourceDrift:Object.keys(sourceHashes).filter(file=>sourceHashes[file]!==liveSourceHashes[file]),ownerNonce:admitted.owner.nonce,cases:[],limits:[frozenReceipt?'Explicit final candidate checked against the selected backend source freeze.':'Explicit frozen main365d973/b7be baseline; live production files may be changing under their assigned author.','Real PostgreSQL and compiled production methods; only driver ACK failures are injected.','Real native skill storage/controller journal is routed in-process, not an external Skills service.','No production, IdP, Ceph, global coverage or full deployment claim.']};
    const close=async()=>{
        const errors=[];
        for(const close of [...extras.reverse(),()=>access?.onModuleDestroy(),()=>pool?.end(),()=>observer?.end(),()=>server&&new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})])try{await close();}catch(error){errors.push({name:error.name,message:error.message});}
        if(created)try{await admin.query('DROP DATABASE "'+name+'"');receipt.ownDatabaseDropped=true;}catch(error){errors.push({resource:'own database',message:error.message});}
        try{const after=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;receipt.originalDatabasesPreserved=JSON.stringify(before)===JSON.stringify(after);}catch(error){errors.push({resource:'database inventory',message:error.message});}
        try{await admin.end();}catch(error){errors.push({resource:'admin',message:error.message});}
        for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);
        receipt.cleanupErrors=errors;receipt.finishedAt=new Date().toISOString();await writeFile(path.join(output,receiptName),JSON.stringify(receipt,null,2)+'\n');return receipt;
    };
    try{
        await mkdir(output,{recursive:true});await admin.query('CREATE DATABASE "'+name+'"');created=true;
        const url=new URL(admitted.url);url.pathname='/'+name;
        const {FEATURE_FLAG_KEYS,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');
        const evaluated=evaluateFeatureFlags(Object.fromEntries(FEATURE_FLAG_KEYS.map(key=>[key,true]))),token=randomUUID();
        server=createServer((req,res)=>{if(req.headers['x-neurocenter-internal']!==token){req.resume();res.writeHead(403).end();return;}if(req.url==='/internal/feature-flags/evaluated'){res.setHeader('content-type','application/json');res.end(JSON.stringify(evaluated));}else{req.resume();res.writeHead(req.url==='/internal/events'?204:404).end();}});
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const gateway='http://127.0.0.1:'+server.address().port;
        Object.assign(process.env,{CATALOG_PG_URL:url.href,NODE_ENV:'production',SSO_DISABLE:'false',FEATURE_FLAGS_SERVICE_URL:gateway,API_GATEWAY_URL:gateway,NEUROCENTER_INTERNAL_TOKEN:token,CAPACITY_REQUIRED:'false',RUNTIME_ARTIFACT_DIR:path.join(output,'runtime')});
        pool=new Pool({connectionString:url.href,max:6,connectionTimeoutMillis:3000,statement_timeout:5000,application_name:'owned-publication-rollback-control'});observer=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,application_name:'owned-publication-rollback-observer'});
        await load('database/catalog-schema.js').ensureCatalogSchema(pool);
        const actor='publication-rollback@example.test';await pool.query("INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,'Owned rollback QA',true)",[actor]);
        access=new (load('access/access-db.js').AccessDb)();await access.ready();
        receipt.database=name;receipt.adminPort=admitted.owner.port;receipt.compiledHashes=Object.fromEntries(await Promise.all(['package-build/package-build.service.js','publication/plugin-repository.js','asset-sources/local-skill-ingest.js'].map(async file=>[file,sha(await readFile(path.join(candidate,'services/catalog-service/dist',file)))])));
        const writer=()=>{const value=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,application_name:'owned-publication-rollback-writer'});extras.push(()=>value.end());return value;};
        const createService=sources=>{const service=new (load('package-build/package-build.service.js').PackageBuildService)(access,{}, {ensureSchema:async()=>{}},sources);const originalPool=service.pool;service.scheduleOwnershipRetry=()=>{};extras.push(()=>originalPool.end());return service;};
        const skillSources=async slug=>{
            const folder=await mkdtemp(path.join(output,'skills-'));
            const {FsSkillsStorage}=loadSkills('storage/fs-skills-storage.js'),{SkillsService}=loadSkills('skills/skills.service.js'),{SkillAssetImportController}=loadSkills('skills/asset-import.controller.js');
            const storage=new FsSkillsStorage(path.join(folder,'native'),entries=>load('publication/skill-dependency-registry.js').reserveSkillDependencies(pool,{entries}),async()=>undefined),skills=new SkillsService(storage),controller=new SkillAssetImportController(skills);
            extras.push(()=>storage.onModuleDestroy());
            const request=async(url,options)=>{const req={headers:{'x-neurocenter-internal':options.headers['x-neurocenter-internal']}},body=JSON.parse(options.body),method=String(url).split('/').at(-1);try{return Response.json(await controller[method](req,body));}catch(error){return Response.json({message:error.message},{status:error.status??500});}};
            const {SkillAssetAdapter,SkillAssetClient}=load('asset-sources/skill-adapter.js'),{LocalSkillIngest}=load('asset-sources/local-skill-ingest.js'),{AssetBlobStore}=load('asset-sources/asset-blob-store.js');
            const ingest=new LocalSkillIngest(pool,new AssetBlobStore(pool,path.join(folder,'blobs')),new SkillAssetAdapter(new SkillAssetClient(request)));
            return{folder,skills,ingest,source:{prepareLocalSkill:(...args)=>ingest.prepare(...args),publishLocalSkill:(...args)=>ingest.publish(...args),recordLocalSkill:(...args)=>ingest.record(...args)}};
        };
        return{receipt,pool,observer,actor,load,writer,createService,skillSources,close,extras};
    }catch(error){receipt.initializationError={name:error.name,message:error.message};await close();throw error;}
}

if(process.argv[2]==='--admit'){try{console.log(JSON.stringify(await admit(process.argv[3])));}catch(error){console.error(JSON.stringify({ok:false,name:error.name,message:error.message}));process.exitCode=1;}}
