import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {statfs,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assetDigest,serializeAsset,type ResolvedAsset,type ToolAsset} from '@neurocenter/asset-contract';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import {AssetImportWorker} from '../src/asset-sources/import-worker';
import {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {DeviceStore} from '../src/devices/device-store';
const state=vi.hoisted(()=>({off:false,calls:[] as string[][],gate:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async(keys:string[])=>{state.calls.push(keys);const gate=state.gate;state.gate=undefined;await gate?.();if(state.off)throw new Error('Own feature disabled after supply');}),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import {databaseFixture,tool,actor} from './asset-import-db.fixture';

const connection=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!connection).sequential('Earlier asset worker actual PostgreSQL boundaries',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>,observer:Pool,worker:ReturnType<Awaited<ReturnType<typeof databaseFixture>>['worker']>|undefined;
 const key="neurocenter:asset-import-worker:public";
 beforeEach(async()=>{
  const value=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL;if(!value)throw new Error('Explicit owned PostgreSQL admin URL is required');const url=new URL(value);if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432')throw new Error('Explicit owned loopback PostgreSQL port other than5432 is required');
  const disk=await statfs(process.cwd(),{bigint:true});if(disk.bavail*disk.bsize<4n*1024n**3n)throw new Error('Disk admission');
  state.off=false;state.calls=[];state.gate=undefined;f=await databaseFixture();observer=new Pool({connectionString:f.pool.options.connectionString,max:1});
 });
 afterEach(async()=>{vi.restoreAllMocks();await worker?.stop();worker=undefined;await observer?.end();await f?.dispose();vi.unstubAllEnvs();});
 async function unlocked(){const result=await observer.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key]);if(result.rows[0].locked)await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);return result.rows[0].locked;}
 async function begin(records:ResolvedAsset[]=[tool('earlier-tool')]){const pin=await f.snapshot(records);return f.jobs.create(actor,randomUUID(),pin,records.map(record=>record.asset.id));}
 function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
 async function binary(){
  const archive=artifactFixture(),descriptor={...archive.descriptor,target:'darwin-arm64' as const},asset=tool('artifact-tool').asset as ToolAsset;asset.card={...asset.card,files:[],config:{}};asset.delivery.artifacts=[{url:'https://github.com/example/fixture/releases/download/v1/fixture.tar.gz',descriptor}];
  const resolved={asset,sha256:assetDigest(serializeAsset(asset)),path:'assets/artifact-tool/1.0.0/asset.json',current:true},request=vi.fn(async()=>new Response(new Uint8Array(archive.archive)));
  const store=new AssetBlobStore(f.pool,path.join(f.root,'owned-supply'),request),runtime=new RuntimeArtifacts({pool:f.pool} as unknown as DeviceStore);vi.stubEnv('RUNTIME_ARTIFACT_DIR',path.join(f.root,'owned-runtime'));
  const job=await begin([resolved]);worker=new AssetImportWorker(f.pool,f.jobs,f.sources,store,runtime);return{...archive,descriptor,store,runtime,job,request};
 }
 async function fault(kind:'acquire'|'unlock'|'rollback'){
  const connect=f.pool.connect.bind(f.pool);let pid=0,inserted=false;
  vi.spyOn(f.pool,'connect').mockImplementationOnce(async()=>{const client=await connect(),query=client.query.bind(client);pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   client.query=(async(text:string,...args:unknown[])=>{
    if(kind==='unlock'&&text.includes('pg_advisory_unlock'))throw new Error('Own unlock not acknowledged');
    if(kind==='rollback'&&text==='ROLLBACK')throw new Error('Own rollback not acknowledged');
    const result=await (query as (...args:unknown[])=>Promise<unknown>)(text,...args);
    if(kind==='acquire'&&text.includes('pg_try_advisory_lock'))throw new Error('Own acquisition ACK lost');
    if(kind==='rollback'&&text.includes('INSERT INTO ai_plugins ')&&!inserted){inserted=true;throw new Error('Own INSERT executed then ACK lost');}
    return result;
   }) as PoolClient['query'];return client;
  });return()=>pid;
 }
 it('healthy no-work session releases its advisory lock and remains reusable',async()=>{const pid=(await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;worker=f.worker();await worker.flush();expect(await unlocked()).toBe(true);expect((await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);});
 it('normal import commits one native card',async()=>{const job=await begin();worker=f.worker();await worker.flush();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');expect((await observer.query('SELECT * FROM ai_plugins')).rows).toHaveLength(1);});
 it('does not publish after flags turn off during admitted supply; explicit retry reuses verified supply',async()=>{const job=await begin(),importAsset=f.blobs.importAsset.bind(f.blobs);vi.spyOn(f.blobs,'importAsset').mockImplementationOnce(async(...args)=>{const supplied=await importAsset(...args);state.off=true;return supplied;});worker=f.worker();await worker.flush();expect((await observer.query('SELECT * FROM ai_plugins')).rows).toHaveLength(0);expect((await f.jobs.get(job.id)).state).not.toBe('SUCCEEDED');expect(state.calls[state.calls.length-1]).toEqual(['asset_sources','tool_catalog']);state.off=false;await f.jobs.retry(job.id,actor);await worker.flush();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');expect((await observer.query('SELECT * FROM ai_plugins')).rows).toHaveLength(1);});
 it('releases a server lock acquired before its response was lost',async()=>{await fault('acquire');worker=f.worker();await expect(worker.flush()).rejects.toThrow('Own acquisition ACK lost');expect(await unlocked()).toBe(true);});
 it('releases a server lock after an unconfirmed unlock',async()=>{await fault('unlock');worker=f.worker();await worker.flush();expect(await unlocked()).toBe(true);});
 it('does not return an idle-in-transaction client after lost INSERT and ROLLBACK acknowledgements; recovery commits once',async()=>{const job=await begin(),pid=await fault('rollback');worker=f.worker();await worker.flush();const backend=(await observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[pid()])).rows[0];expect(backend?.state).not.toBe('idle in transaction');expect((await observer.query('SELECT * FROM ai_plugins')).rows).toHaveLength(0);expect((await f.jobs.get(job.id)).state).not.toBe('SUCCEEDED');await worker.stop();worker=f.worker();await worker.flush();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');expect((await observer.query('SELECT * FROM ai_plugins')).rows).toHaveLength(1);expect((await observer.query('SELECT * FROM ai_plugin_versions')).rows).toHaveLength(1);expect(await f.jobs.versions(job.source.repository)).toHaveLength(1);});
 it('blocks runtime publication after verified archive inspection; explicit retry retains supply and commits once',async()=>{
  const b=await binary(),checked=b.store.checkedPath.bind(b.store),imported=vi.spyOn(b.runtime,'importArchive');vi.spyOn(b.store,'checkedPath').mockImplementationOnce(async(...args)=>{const file=await checked(...args);state.off=true;return file;});
  await worker!.flush();expect(imported).not.toHaveBeenCalled();expect((await observer.query('SELECT * FROM bridge_runtime_artifacts')).rows).toEqual([]);expect((await observer.query('SELECT * FROM ai_plugins')).rows).toEqual([]);
  expect(await readFile(await b.store.checkedPath(b.descriptor.sha256,b.archive.length))).toEqual(b.archive);state.off=false;await f.jobs.retry(b.job.id,actor);await worker!.flush();expect(imported).toHaveBeenCalledOnce();expect(b.request).toHaveBeenCalledOnce();expect((await observer.query('SELECT * FROM ai_plugin_versions')).rows).toHaveLength(1);expect((await f.jobs.get(b.job.id)).state).toBe('SUCCEEDED');
 });
 it('rechecks native publication flags after waiting for the real asset-management lock',async()=>{
  const job=await begin(),supplied=f.blobs.importAsset.bind(f.blobs),holder=await observer.connect();let locked=false;const entered=deferred();
  vi.spyOn(f.blobs,'importAsset').mockImplementationOnce(async(...args)=>{const blobs=await supplied(...args),current=await f.jobs.get(job.id);await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:plugin:'+current.items[0].native!.id]);locked=true;entered.resolve();return blobs;});
  worker=f.worker();const running=worker.flush();try{await entered.promise;let waiting=false;for(let i=0;i<100;i++){waiting=(await holder.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting")).rows[0].waiting;if(waiting)break;await new Promise(done=>setTimeout(done,10));}expect(waiting).toBe(true);state.off=true;}finally{if(locked)await holder.query('COMMIT');holder.release();await running;}
  expect((await observer.query('SELECT * FROM ai_plugins')).rows).toEqual([]);state.off=false;await f.jobs.retry(job.id,actor);await worker.flush();expect((await observer.query('SELECT * FROM ai_plugin_versions')).rows).toHaveLength(1);
 });
 it.each(['runtime','native'] as const)('does not start %s publication when stop arrives during its final feature check',async stage=>{
  const entered=deferred(),release=deferred(),gate=()=>{state.gate=async()=>{entered.resolve();await release.promise;};};let imported:ReturnType<typeof vi.spyOn>|undefined;
  if(stage==='runtime'){const b=await binary(),checked=b.store.checkedPath.bind(b.store);imported=vi.spyOn(b.runtime,'importArchive');vi.spyOn(b.store,'checkedPath').mockImplementationOnce(async(...args)=>{const file=await checked(...args);gate();return file;});}
  else{await begin();const supplied=f.blobs.importAsset.bind(f.blobs);vi.spyOn(f.blobs,'importAsset').mockImplementationOnce(async(...args)=>{const result=await supplied(...args);gate();return result;});worker=f.worker();}
  const running=worker!.flush();await entered.promise;const stopped=worker!.stop();release.resolve();await Promise.all([running,stopped]);if(imported)expect(imported).not.toHaveBeenCalled();expect((await observer.query('SELECT * FROM ai_plugins')).rows).toEqual([]);expect((await observer.query('SELECT * FROM bridge_runtime_artifacts')).rows).toEqual([]);
 });
});
