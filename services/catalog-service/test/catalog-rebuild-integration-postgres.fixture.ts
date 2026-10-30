import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {vi} from 'vitest';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';
import type {PackageBuildService as BuildService} from '../src/package-build/package-build.service';
import type {AssetSourcesService as SourceService} from '../src/asset-sources/asset-sources.service';
import type {PackageBuildRepository as BuildRepository} from '../src/package-build/package-build.repository';
import type {BuildRow} from '../src/package-build/package-build.model';
import type {CatalogRebuildCoordinator} from '../src/package-build/catalog-rebuild-coordinator';
import type {CatalogRebuildState} from '../src/package-build/catalog-rebuild-state';
import type {IAccessActor} from '../src/access/access.model';

const require=createRequire(import.meta.url);
const {ensureCatalogSchema}=require('../dist/database/catalog-schema.js') as typeof import('../src/database/catalog-schema');
const {AccessDb}=require('../dist/access/access-db.js') as typeof import('../src/access/access-db');
const {CatalogService}=require('../dist/catalog/catalog.service.js') as typeof import('../src/catalog/catalog.service');
const {RuntimeArtifacts}=require('../dist/runtime-artifacts/runtime-artifacts.js') as typeof import('../src/runtime-artifacts/runtime-artifacts');
const {AssetSourcesService}=require('../dist/asset-sources/asset-sources.service.js') as typeof import('../src/asset-sources/asset-sources.service');
const {AssetSourceSnapshots}=require('../dist/asset-sources/source-snapshots.js') as typeof import('../src/asset-sources/source-snapshots');
const {AssetImportRepository}=require('../dist/asset-sources/import-repository.js') as typeof import('../src/asset-sources/import-repository');
const {AssetBlobStore}=require('../dist/asset-sources/asset-blob-store.js') as typeof import('../src/asset-sources/asset-blob-store');
const {PackageBuildService}=require('../dist/package-build/package-build.service.js') as typeof import('../src/package-build/package-build.service');
const {PackageBuildRepository}=require('../dist/package-build/package-build.repository.js') as typeof import('../src/package-build/package-build.repository');
const {PluginRepository}=require('../dist/publication/plugin-repository.js') as typeof import('../src/publication/plugin-repository');
const {readCatalogRebuildState}=require('../dist/package-build/catalog-rebuild-state.js') as typeof import('../src/package-build/catalog-rebuild-state');
const {readBundledCatalog}=require('../../shared/bundled-catalog.cjs') as typeof import('../../shared/bundled-catalog.cjs');
const {makeCatalogRebuildRequest,catalogRebuildRequestKey}=require('../../shared/catalog-rebuild-request.cjs') as typeof import('../../shared/catalog-rebuild-request.cjs');
const {FEATURE_FLAG_KEYS,evaluateFeatureFlags}=require('../../shared/feature-flags.cjs');

export const connection=process.env.CATALOG_REBUILD_INTEGRATION_ADMIN_PG_URL;
export const actor:IAccessActor={email:'rebuild-integration-owner@example.test',activeRole:'Главный админ'};
export const keeper:IAccessActor={email:'rebuild-integration-keeper@example.test',activeRole:'Главный админ'};
type BuildPorts={pool:Pool;repository:BuildRepository;lease:PoolClient;rebuild:CatalogRebuildCoordinator;rebuildTimer?:ReturnType<typeof setInterval>;startWorker:(root:string)=>void;discardLease:(client:PoolClient)=>void;stagingRoot:()=>Promise<string>;withLease:<T>(lease:PoolClient,work:()=>Promise<T>)=>Promise<T>;execute:(row:BuildRow,root:string)=>Promise<void>;rebuildRequest:(actor:IAccessActor,key:string,kind:'build'|'inline')=>Promise<unknown>};

/** Actual compiled services use bounded main/auth pools; only automatic executor wakeups are held. */
export async function integrationFixture({lostAck=false,revision}:{lostAck?:boolean;revision?:string}={}){
 const url=callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:connection}),expected=process.env.CATALOG_REBUILD_INTEGRATION_SYSTEM_IDENTIFIER;
 if(!expected||!/^\d+$/.test(expected))throw Error('Explicit owned PostgreSQL system identifier is required.');
 const admin=new Pool({connectionString:url.href,max:1,statement_timeout:10000,connectionTimeoutMillis:5000});
 const system=(await admin.query<{id:string}>('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
 if(system!==expected){await admin.end();throw Error('Owned PostgreSQL system identifier changed.');}
 const database='nc_rebuild_integ_'+randomUUID().replaceAll('-','');let created=false;
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-rebuild-integration-'))),file=path.join(temporary,'rebuild-request.json');
 const receipt={database,systemIdentifier:system,poolMaximum:2,authorizationPoolMaximum:1,maximumDataSessions:3,temporary,dropped:false,sessionsBeforeDrop:-1,externalCalls:[] as string[],checks:[] as string[],executor:'actual compiled production worker; automatic queue wakeup held',snapshots:[] as unknown[]};
 let pool:Pool,accessPool:Pool|undefined,build:BuildService|undefined,sources:SourceService,ports:BuildPorts;
 const ownRuntime=path.join(temporary,'runtime'),inlineKick=vi.fn(),buildWake=vi.fn();
 const close=async()=>{
  try{
   if(build){await build.onModuleDestroy();build=undefined;}else await pool?.end();
   await accessPool?.end();accessPool=undefined;
   if(created){receipt.sessionsBeforeDrop=Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].count);await admin.query('DROP DATABASE '+database);receipt.dropped=!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount;}
  }finally{
   await admin.end();await fs.rm(temporary,{recursive:true,force:true});
   if(process.env.CATALOG_REBUILD_INTEGRATION_RECEIPT_FILE)await fs.appendFile(process.env.CATALOG_REBUILD_INTEGRATION_RECEIPT_FILE,JSON.stringify(receipt)+'\n');
   vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
  }
 };
 try{
  await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
  await fs.mkdir(ownRuntime,{mode:0o700});
  vi.stubEnv('CATALOG_PG_URL',url.href);vi.stubEnv('CATALOG_REBUILD_REQUEST_FILE',file);vi.stubEnv('NODE_ENV','production');
  vi.stubEnv('SSO_DISABLE','true');vi.stubEnv('DEV_USER_EMAIL',actor.email);vi.stubEnv('CAPACITY_REQUIRED','false');
  vi.stubEnv('RUNTIME_ARTIFACT_DIR',ownRuntime);vi.stubEnv('ASSET_BLOB_DIR',path.join(temporary,'blobs'));vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',randomUUID());
  vi.stubEnv('TOOL_BUILD_SCRIPT',path.resolve('..','..','scripts/catalog-plugins/build.mjs'));
  vi.stubEnv('FEATURE_FLAGS_SERVICE_URL','http://rebuild-integration-qa.invalid');vi.stubEnv('API_GATEWAY_URL','http://rebuild-integration-qa.invalid');
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
   const target=typeof input==='string'?input:input instanceof URL?input.href:input.url;
   if(target==='http://rebuild-integration-qa.invalid/internal/feature-flags/evaluated')return Response.json(evaluateFeatureFlags(Object.fromEntries(FEATURE_FLAG_KEYS.map((key:string)=>[key,true]))));
   if(target==='http://rebuild-integration-qa.invalid/internal/events')return Response.json({ok:true});
   receipt.externalCalls.push(target);throw Error('External request forbidden in rebuild integration fixture.');
  }));
  const bundle=await readBundledCatalog();
  let intent=makeCatalogRebuildRequest(revision??bundle.revision);
  await fs.writeFile(file,JSON.stringify(intent)+'\n',{flag:'wx',mode:0o600});
  const start=async(fault=false)=>{
   pool=new Pool({connectionString:url.href,max:2,statement_timeout:10000,connectionTimeoutMillis:5000});
   accessPool=new Pool({connectionString:url.href,max:1,statement_timeout:10000,connectionTimeoutMillis:5000});
   await ensureCatalogSchema(pool);
   await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true),($2,true,true) ON CONFLICT DO NOTHING',[actor.email,keeper.email]);
   const access=new AccessDb(),catalog=new CatalogService();
   const accessPorts=access as unknown as {pool:Pool};await accessPorts.pool.end();accessPorts.pool=accessPool;
   const catalogDb=(catalog as unknown as {db:{pool:Pool;plugins:InstanceType<typeof PluginRepository>}}).db;await catalogDb.pool.end();catalogDb.pool=pool;catalogDb.plugins=new PluginRepository(pool);
   const artifacts=new RuntimeArtifacts({pool} as never);
   sources=new AssetSourcesService(catalog,access,artifacts);
   const sourcePorts=sources as unknown as {pool:Pool;worker:{kick:()=>void};blobs:InstanceType<typeof AssetBlobStore>;jobs:InstanceType<typeof AssetImportRepository>;sources:InstanceType<typeof AssetSourceSnapshots>};
   await sourcePorts.pool.end();sourcePorts.pool=pool;sourcePorts.worker={kick:inlineKick};sourcePorts.blobs=new AssetBlobStore(pool,path.join(temporary,'blobs'));sourcePorts.jobs=new AssetImportRepository(pool);sourcePorts.sources=new AssetSourceSnapshots(pool,async()=>bundle.pin);
   await sourcePorts.sources.refresh();
   build=new PackageBuildService(access,artifacts,catalog,sources);ports=build as unknown as BuildPorts;
   await ports.pool.end();ports.pool=pool;ports.repository=new PackageBuildRepository(pool,client=>ports.discardLease(client));
   vi.spyOn(ports,'startWorker').mockImplementation(buildWake);
   if(fault){
    const inline=sources.start.bind(sources),create=build.create.bind(build);
    vi.spyOn(sources,'start').mockImplementationOnce(async(...args)=>{await inline(...args);throw Error('Own lost inline ACK after commit.');});
    vi.spyOn(build,'create').mockImplementationOnce(async(...args)=>{await create(...args);throw Error('Own lost build ACK after commit.');});
   }
   await build.onModuleInit();
   if(ports.rebuildTimer){clearInterval(ports.rebuildTimer);ports.rebuildTimer=undefined;}
   await ports.rebuild.tick();
  };
  await start(lostAck);
  return {
   receipt,file,bundle,inlineKick,buildWake,
   get pool(){return pool;},get build(){return build!;},get ports(){return ports;},get sources(){return sources;},
   async state():Promise<CatalogRebuildState|undefined>{return readCatalogRebuildState(file);},
   key:(component:string)=>catalogRebuildRequestKey(intent.requestId,component),
   async jobs(){return {builds:(await pool.query<BuildRow>('SELECT * FROM tool_build_jobs ORDER BY created_at,id')).rows,inline:(await pool.query('SELECT * FROM asset_source_jobs ORDER BY created_at,id')).rows};},
   async tick(){await ports.rebuild.tick();},
   async restart(){await build!.onModuleDestroy();build=undefined;await accessPool!.end();accessPool=undefined;await start();},
   async newIntent(sourceRevision=bundle.revision){intent=makeCatalogRebuildRequest(sourceRevision);await fs.writeFile(file,JSON.stringify(intent)+'\n',{mode:0o600});return intent;},
   async executeOnly(id:string){
    const rows=(await pool.query<BuildRow>("SELECT * FROM tool_build_jobs WHERE state='QUEUED' ORDER BY created_at,id")).rows;
    for(const row of rows)if(row.id!==id)await build!.cancel(actor,row.id);
    const selected=await ports.withLease(ports.lease,()=>ports.repository.takeQueued(ports.lease));
    if(selected?.id!==id)throw Error('Bounded executor selected a different own job.');
    await ports.execute(selected,await ports.stagingRoot());
    return ports.repository.get(id);
   },
   plugins:()=>new PluginRepository(pool),close,
  };
 }catch(error){await close();throw error;}
}
