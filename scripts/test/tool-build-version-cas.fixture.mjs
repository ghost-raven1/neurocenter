import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {cancellationFixture,deferred,until,settled} from './tool-build-cancellation.fixture.mjs';
import {admit,ownedConnection,root} from './package-publication-rollback.fixture.mjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {Pool}=require('pg');
const {FEATURE_FLAG_KEYS}=require('../../services/shared/feature-flags.cjs');
export const sha=value=>createHash('sha256').update(value).digest('hex');
export {deferred,until,settled};
export async function deadline(promise,label,ms=12000){
    let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' deadline')),ms);})]);}
    finally{clearTimeout(timer);}
}

/** No pool is created until the explicit owned cluster, frozen source and compiled bytes are admitted. */
export async function versionCasFixture(){
    const file=process.env.TOOL_BUILD_VERSION_CAS_CONNECTION_FILE,dist=process.env.TOOL_BUILD_TEST_DIST;
    const sourceFile=process.env.TOOL_BUILD_VERSION_CAS_SOURCE_RECEIPT;
    assert.ok(dist&&path.isAbsolute(dist),'Select the explicit compiled Catalog candidate.');
    assert.ok(sourceFile&&path.isAbsolute(sourceFile),'Select the explicit backend freeze receipt.');
    const source=JSON.parse(await readFile(sourceFile,'utf8')),candidate=path.resolve(dist,'../../..');
    const sourceHashes={},compiledHashes={},manifest=JSON.parse(await readFile(path.resolve(candidate,'../catalog-service-artifacts.json'),'utf8'));
    for(const name of source.sourceFiles){
        const digest=sha(await readFile(path.join(candidate,name)));assert.equal(digest,source.hashes[name],'Frozen candidate source changed: '+name);sourceHashes[name]=digest;
    }
    for(const name of ['package-build/publish-built-tool.js','package-build/publication-target.js','package-build/package-build.repository.js',
        'publication/plugin-repository.js','asset-sources/local-asset-ingest.js','asset-sources/asset-blob-store.js','asset-sources/import-repository.js']){
        const digest=sha(await readFile(path.join(dist,name)));assert.equal(digest,manifest.files[name],'Compiled candidate changed: '+name);compiledHashes[name]=digest;
    }
    await admit(file);const owned=await ownedConnection(file),prior=process.env.TOOL_BUILD_CANCEL_TEST_PG_URL;
    process.env.TOOL_BUILD_CANCEL_TEST_PG_URL=owned.url.href;
    let f;
    try{f=await cancellationFixture();}catch(error){if(prior===undefined)delete process.env.TOOL_BUILD_CANCEL_TEST_PG_URL;else process.env.TOOL_BUILD_CANCEL_TEST_PG_URL=prior;throw error;}
    const url=new URL(owned.url);url.pathname='/'+f.receipt.database;
    let observer;
    try{
    observer=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,statement_timeout:8000,application_name:'owned-version-cas-observer'});
    observer.on('error',()=>{});
    const extras=new Set(),barriers=new Set();let discarded=false;
    const {PluginRepository}=f.load('publication/plugin-repository.js');
    const {LocalAssetIngest}=f.load('asset-sources/local-asset-ingest.js'),{AssetBlobStore}=f.load('asset-sources/asset-blob-store.js');
    const target=f.load('package-build/publication-target.js'),{publishBuiltTool}=f.load('package-build/publish-built-tool.js');
    const {validateBuildInput,requestHash}=f.load('package-build/package-build.model.js');
    const {requireFeaturesEnabled}=f.load('features/require-feature-enabled.js');
    const blobs=new AssetBlobStore(f.pool,path.join(f.folder,'runtime/.asset-source-blobs')),ingest=new LocalAssetIngest(f.pool,blobs);
    const plugins=new PluginRepository(f.pool),allFlags=Object.fromEntries(FEATURE_FLAG_KEYS.map(key=>[key,true]));f.setFlags(allFlags);
    const guard=async()=>{await f.service.requireMain(f.actor);await requireFeaturesEnabled(['tool_builds','tool_catalog']);};
    f.receipt.scope='Actual PostgreSQL publication CAS/authorization/lock order and unknown COMMIT ACK';
    Object.assign(f.receipt,{sourceReceipt:sourceFile,sourceReceiptSha256:sha(await readFile(sourceFile)),sourceHashes,compiledHashes,ownerNonce:owned.owner.nonce});
    f.receipt.limits.push('Source JSON bytes use actual LocalAssetIngest/AssetBlobStore; runtime archives/builders/bridge installation are covered by the separate roundtrip.');
    f.receipt.limits.push('Fault injection changes the ACK of one real COMMIT; SQL writes, locks and independent observation remain real.');
    await f.lease.query("SET statement_timeout='10s'");
    async function client(){const value=await f.pool.connect();extras.add(value);await value.query("SET statement_timeout='10s'");return value;}
    async function release(value){if(!extras.delete(value))return;try{await value.query('ROLLBACK');value.release();}catch(error){value.release(true);throw error;}}
    async function seed(){
        const id='cas-tool-'+randomUUID().slice(0,8),name='Owned CAS '+randomUUID().slice(0,8),key=randomUUID();
        const prepare=async label=>{
            const declaration={type:'files',entrypoint:'index.mjs'},files=[{path:'index.mjs',content:'export default async()=>({version:'+JSON.stringify(label)+'});\n'}];
            const bytes=Buffer.from(JSON.stringify({declaration,files})+'\n'),digest=sha(bytes),stage=path.join(f.folder,'source-'+randomUUID());
            await mkdir(stage,{mode:0o700});const archivePath=path.join(stage,'source.json');await writeFile(archivePath,bytes,{flag:'wx',mode:0o600});
            const asset={schemaVersion:1,id,version:label==='A'?'1.0.0':'2.0.0',kind:'plugin',source:{type:'archive',sha256:digest,bytes:bytes.length},
                license:{spdx:'NOASSERTION'},compatibility:{packageFormat:5},card:{kind:'plugin',name,description:'Owned CAS source '+label,revision:label,origin:'upload',tags:[],files,config:{entrypoint:'index.mjs'}},delivery:{type:'runtime-artifacts',artifacts:[]}};
            return {prepared:await ingest.prepare(asset,[],randomUUID(),undefined,{archivePath,stagingRoot:stage}),bytes,files,declaration};
        };
        const a=await prepare('A'),b=await prepare('B');
        const card=await plugins.create({...a.prepared.publication,publicationKey:key},f.actor.email,(client,native)=>ingest.record(client,a.prepared,native,f.actor.email));
        return {id,name,key,a,b,card};
    }
    async function snapshot(item){
        const {rows:cards}=await observer.query('SELECT * FROM ai_plugins WHERE id=$1',[item.card.id]);
        const {rows:versions}=await observer.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[item.card.id]);
        const {rows:sources}=await observer.query('SELECT * FROM asset_source_versions WHERE native_id=$1 ORDER BY repository,external_id,asset_version',[item.card.id]);
        const {rows:receipts}=await observer.query('SELECT * FROM asset_source_receipts WHERE native_id=$1 ORDER BY repository,external_id',[item.card.id]);
        const {rows:audit}=await observer.query('SELECT * FROM security_events WHERE resource_id=$1 ORDER BY event_id',[item.card.id]);
        assert.equal(cards.length,1);assert.ok(versions.some(row=>row.version===1));
        const old=sources.find(row=>row.asset_version==='1.0.0');assert.ok(old);assert.equal(old.descriptor_sha256,item.a.prepared.sha256);
        assert.equal(old.external_id,item.id);assert.equal(old.native_id,item.card.id);assert.equal(old.native_version,1);
        const actual=await readFile(await blobs.checkedPath(item.a.prepared.asset.source.sha256,item.a.bytes.length));assert.deepEqual(actual,item.a.bytes);
        const decoded=JSON.parse(actual);assert.deepEqual(decoded.files,item.a.files);assert.deepEqual(decoded.declaration,item.a.declaration);
        return {cards,versions,sources,receipts,audit,oldSourceSha256:sha(actual)};
    }
    function immutable(before,after){assert.deepEqual(after.versions.find(row=>row.version===1),before.versions.find(row=>row.version===1));
        assert.deepEqual(after.sources.find(row=>row.asset_version==='1.0.0'),before.sources.find(row=>row.asset_version==='1.0.0'));assert.equal(after.oldSourceSha256,before.oldSourceSha256);}
    async function build(item){
        const preview=await target.publicationTargetPreview(f.pool,'plugin',item.card.id);
        const publication={catalogId:preview.catalogId,expectedVersion:preview.expectedVersion,expectedSourceHash:preview.expectedSourceHash};
        const input=validateBuildInput({requestKey:randomUUID(),kind:'plugin',name:item.name,description:item.b.prepared.publication.description,tags:[],targets:[process.platform+'-'+process.arch],source:{type:'files',entrypoint:'index.mjs',files:item.b.files},publication});
        const pin=await target.pinBuildPublication(f.pool,input),{requestKey:_key,publication:_public,...config}=input;
        const queued=await f.repository.enqueue(f.actor.email,input.requestKey,requestHash(input),{...config,publication:pin});
        const row=await f.repository.takeQueued(f.lease);assert.equal(row.id,queued.id);
        await f.repository.beginPublication(row.id,f.lease,guard);
        return {row:await f.row(row.id),input,pin};
    }
    const publish=(item,build,lease=f.lease)=>publishBuiltTool({pool:f.pool,lease,sources:{recordLocal:(...args)=>ingest.record(...args)},repository:f.repository,
        row:build.row,publication:item.b.prepared.publication,prepared:item.b.prepared,guard,discard:value=>{discarded=true;value.release(true);}});
    const pid=async value=>Number((await value.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    async function blocking(waiter,blocker){return until(async()=>{const row=(await observer.query('SELECT pg_blocking_pids($1) AS blockers',[waiter])).rows[0];return row?.blockers.includes(blocker)?{waiter,blocker,blockers:row.blockers}:false;},'actual SQL waiter/blocker edge');}
    /** Hold only after a real advisory lock succeeded, before the next production query proceeds. */
    function afterFirstLock(raw){
        const entered=deferred(),resume=deferred();let held=false;barriers.add(resume);
        const proxy=new Proxy(raw,{get(target,key){if(key==='query')return async(sql,...args)=>{
            const value=await raw.query(sql,...args),text=typeof sql==='string'?sql:sql.text;
            if(!held&&text.includes('pg_advisory_xact_lock')){held=true;entered.resolve({sql:text,params:args[0]});await resume.promise;}return value;
        };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        return {client:proxy,entered:entered.promise,resume:()=>{resume.resolve();barriers.delete(resume);}};
    }
    async function close(){
        const cleanup=[];for(const gate of barriers)gate.resolve();
        for(const value of [...extras])try{await release(value);}catch(error){cleanup.push({resource:'extra SQL client',message:error.message});}
        try{await observer.end();}catch(error){cleanup.push({resource:'observer',message:error.message});}
        for(const [name,digest]of Object.entries(sourceHashes))try{assert.equal(sha(await readFile(path.join(candidate,name))),digest,'Candidate source changed: '+name);}
        catch(error){f.receipt.failures.push({name:'candidate source stability',message:error.message});}
        for(const [name,digest]of Object.entries(compiledHashes))try{assert.equal(sha(await readFile(path.join(dist,name))),digest,'Compiled candidate changed: '+name);}
        catch(error){f.receipt.failures.push({name:'compiled candidate stability',message:error.message});}
        if(discarded)f.receipt.failures.push({name:'unexpected tainted publication lease',message:'CAS fixture lease was discarded.'});
        const result=await f.close();result.cleanupErrors.push(...cleanup);result.ok=result.ok&&!cleanup.length;
        if(prior===undefined)delete process.env.TOOL_BUILD_CANCEL_TEST_PG_URL;else process.env.TOOL_BUILD_CANCEL_TEST_PG_URL=prior;
        await writeFile(path.join(f.folder,'receipt.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
    }
    return {...f,observer,plugins,ingest,blobs,target,guard,seed,snapshot,immutable,build,publish,client,release,pid,blocking,afterFirstLock,close,resetFlags:()=>f.setFlags(allFlags)};
    }catch(primary){
        const errors=[primary];try{await observer?.end();}catch(error){errors.push(error);}
        f.receipt.failures.push({name:'CAS fixture initialization',message:primary.message});
        try{const cleanup=await f.close();if(!cleanup.ok)errors.push(Error('Owned fixture initialization cleanup failed; see private receipt.'));}catch(error){errors.push(error);}
        if(prior===undefined)delete process.env.TOOL_BUILD_CANCEL_TEST_PG_URL;else process.env.TOOL_BUILD_CANCEL_TEST_PG_URL=prior;
        if(errors.length>1)throw new AggregateError(errors,'CAS fixture initialization/cleanup failed',{cause:primary});throw primary;
    }
}
