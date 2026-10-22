import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {vi} from 'vitest';
import {assetDigest,serializeAsset,type AssetIndex,type ResolvedAsset,type ToolAsset} from '@neurocenter/asset-contract';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {AccessDb} from '../src/access/access-db';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {AssetSourcesController} from '../src/asset-sources/asset-sources.controller';
import {AssetSourceSnapshots} from '../src/asset-sources/source-snapshots';
import {AssetImportRepository} from '../src/asset-sources/import-repository';
import {AssetImportWorker} from '../src/asset-sources/import-worker';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {Request} from 'express';

const require=createRequire(import.meta.url);
const {ownedTestPostgresAdmin}=require('../../../scripts/test/owned-postgres.fixture.mjs') as {ownedTestPostgresAdmin:(input:string|undefined)=>URL};
const {FEATURE_FLAG_KEYS,evaluateFeatureFlags}=require('../../shared/feature-flags.cjs') as {FEATURE_FLAG_KEYS:string[];evaluateFeatureFlags:(flags:Record<string,boolean>)=>unknown};
export const connection=process.env.ASSET_SOURCE_AVAILABILITY_TEST_ADMIN_PG_URL??process.env.TEST_ADMIN_PG_URL;
export const actor='owner@availability.test';
const cleanup:unknown[]=[];

/** Full production schema in one explicitly owned UUID database; no constructors point at the default database. */
export async function sourceAvailabilityFixture(){
    const adminUrl=ownedTestPostgresAdmin(connection),disk=await fs.statfs(process.cwd(),{bigint:true});
    if(disk.bavail*disk.bsize<4n*1024n**3n)throw Error('Source availability fixture requires 4GiB free space.');
    const admin=new Pool({connectionString:adminUrl.href,max:1}),name='nc_source_availability_'+randomUUID().replaceAll('-','');
    let root:string|undefined,pool:Pool|undefined,observer:Pool|undefined,created=false,started=false,service:AssetSourcesService|undefined;
    const workers:AssetImportWorker[]=[],extraPools:Pool[]=[];
    const before=(await admin.query<{datname:string}>('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row=>row.datname);
    async function close(){
        const errors:unknown[]=[];
        for(const worker of workers){try{await worker.stop();}catch(error){errors.push(error);}}
        try{if(started)await service!.onApplicationShutdown();else await pool?.end();}catch(error){errors.push(error);}
        for(const extra of extraPools){try{await extra.end();}catch(error){errors.push(error);}}
        try{await observer?.end();}catch(error){errors.push(error);}
        try{
            if(created)await admin.query('DROP DATABASE '+name);
            const after=(await admin.query<{datname:string}>('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row=>row.datname);
            cleanup.push({database:name,dropped:created&&!after.includes(name),originalDatabasesPreserved:before.every(value=>after.includes(value)),newDatabasesRemaining:after.filter(value=>!before.includes(value)),cleanupErrors:errors.map(String)});
            if(process.env.ASSET_SOURCE_AVAILABILITY_CLEANUP_FILE)await fs.writeFile(process.env.ASSET_SOURCE_AVAILABILITY_CLEANUP_FILE,JSON.stringify(cleanup,null,2)+'\n');
        }finally{await admin.end();if(root)await fs.rm(root,{recursive:true,force:true});}
        if(errors.length)throw errors[0];
    }
    try{
        await admin.query('CREATE DATABASE '+name);created=true;
        const url=new URL(adminUrl);url.pathname='/'+name;
        pool=new Pool({connectionString:url.href,max:4});observer=new Pool({connectionString:url.href,max:1});
        root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-source-availability-'));
        vi.stubEnv('RUNTIME_ARTIFACT_DIR',root);vi.stubEnv('ASSET_SOURCE_MODE','online');
        vi.stubEnv('FEATURE_FLAGS_SERVICE_URL','https://flags.owned.invalid');vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',randomUUID());
        const flags={off:false,unavailable:false,calls:0};
        vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
            if(String(input)!=='https://flags.owned.invalid/internal/feature-flags/evaluated')throw Error('Unexpected network request in owned source fixture');
            expectHeader(init);flags.calls++;
            return Response.json(evaluateFeatureFlags(Object.fromEntries(FEATURE_FLAG_KEYS.map(key=>[key,!(flags.off&&key==='asset_sources')]))),{status:flags.unavailable?503:200});
        }));
        function expectHeader(init?:RequestInit){if(new Headers(init?.headers).get('x-neurocenter-internal')!==process.env.NEUROCENTER_INTERNAL_TOKEN)throw Error('Missing internal fixture credential');}
        await ensureCatalogSchema(pool);
        await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true)',[actor]);
        const asset:ToolAsset={schemaVersion:1,id:'owned-tool',kind:'plugin',version:'1.0.0',source:{type:'git',repository:'https://github.com/example/owned',commit:'a'.repeat(40)},license:{spdx:'MIT'},compatibility:{packageFormat:5},
            card:{kind:'plugin',name:'Owned tool',description:'Offline ready fixture',revision:'1',origin:'upload',tags:[],files:[{path:'index.mjs',content:'export const fixture = async () => ({})'}],config:{entrypoint:'index.mjs'}},delivery:{type:'runtime-artifacts',artifacts:[]}};
        const record:ResolvedAsset={asset,sha256:assetDigest(serializeAsset(asset)),path:'assets/owned-tool/1.0.0/asset.json',current:true};
        const index:AssetIndex={schemaVersion:1,assets:[{id:asset.id,kind:asset.kind,version:asset.version,sha256:record.sha256,path:record.path,current:true}]},indexBytes=JSON.stringify(index)+'\n';
        const pin={schemaVersion:1 as const,repository:'ghost-raven1/neurocenter-assets',commit:'a'.repeat(40),index:{path:'index.json',sha256:assetDigest(indexBytes)}};
        const request=vi.fn(async()=>{throw Error('GitHub unavailable in owned fixture');}),sources=new AssetSourceSnapshots(pool,pin,request),jobs=new AssetImportRepository(pool),blobs=new AssetBlobStore(pool);
        const runtime={importArchive:vi.fn(async()=>{throw Error('Inline tool does not need a runtime archive');})} as unknown as RuntimeArtifacts;
        const access=Object.assign(Object.create(AccessDb.prototype),{pool}) as AccessDb;
        service=Object.assign(Object.create(AssetSourcesService.prototype),{pool,sources,jobs,blobs,runtime,access,catalog:{ensureSchema:()=>ensureCatalogSchema(pool!)},worker:{kick:vi.fn()}}) as AssetSourcesService;
        const controller=new AssetSourcesController(service),req={headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:'Главный админ'}))}} as unknown as Request;
        const directory=path.join(root,'.asset-source-metadata');
        async function prepare(){await fs.mkdir(directory,{recursive:true});for(const bytes of [indexBytes,serializeAsset(asset)])await fs.writeFile(path.join(directory,assetDigest(bytes)+'.json'),bytes,{mode:0o400});}
        return{pool,observer,root,name,pin,index,record,indexBytes,request,sources,jobs,blobs,service,controller,req,flags,prepare,close,
            startup:async()=>{started=true;await service!.onModuleInit();},
            flush:()=> (service as unknown as {worker:AssetImportWorker}).worker.flush(),
            worker:()=>{const worker=new AssetImportWorker(pool!,jobs,sources,blobs,runtime);workers.push(worker);return worker;},
            ownerPool:()=>{const extra=new Pool({connectionString:url.href,max:1});extraPools.push(extra);return extra;}};
    }catch(error){try{await close();}catch(cleanupError){Object.assign(error as object,{cleanupError});}throw error;}
}

/** Fault only driver acknowledgements after actual statements; observer and later borrower use real PostgreSQL. */
export function snapshotFaultPool(pool:Pool,point:'insert'|'commit',rollback:'not-dispatched'|'ack-lost'|'normal'){
    const failure=new Error('Own snapshot '+point+' acknowledgement lost'),rollbackFailure=new Error('Own snapshot rollback acknowledgement lost');
    let pid=0,releaseError:Error|boolean|undefined,injected=false;const events:Array<{sql:string;executed:boolean}>=[];
    const wrapper={query:pool.query.bind(pool),connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return{query:async(sql:string,...args:unknown[])=>{
            if(sql==='ROLLBACK'&&rollback==='not-dispatched'){events.push({sql,executed:false});throw rollbackFailure;}
            const result=await (query as(...input:unknown[])=>Promise<unknown>)(sql,...args);events.push({sql,executed:true});
            if(sql==='ROLLBACK'&&rollback==='ack-lost')throw rollbackFailure;
            if(!injected&&(point==='insert'?sql.startsWith('INSERT INTO asset_source_snapshots'):sql==='COMMIT')){injected=true;throw failure;}return result;
        },release:(error?:Error|boolean)=>{releaseError=error;client.release(error);}} as unknown as PoolClient;
    }} as unknown as Pool;
    return{pool:wrapper,failure,events,pid:()=>pid,releaseError:()=>releaseError};
}
