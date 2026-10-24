import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {createToolAsset,toToolPublication} from '@neurocenter/asset-contract';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import type {CapacityRequest} from '../../shared/capacity.cjs';
import type {BuildRow} from '../src/package-build/package-build.model';
import {runtimeReportFixture} from './package-build-runtime.fixture';

const handoffMocks=vi.hoisted(()=>({build:vi.fn(),verify:vi.fn(),reserve:vi.fn(),publish:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../../shared/capacity.cjs',async()=>({...await vi.importActual('../../shared/capacity.cjs'),reserveCapacity:handoffMocks.reserve}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../src/package-build/build-process',async()=>({...await vi.importActual('../src/package-build/build-process'),runPackageBuilder:handoffMocks.build}));
vi.mock('../src/package-build/build-runtime',async()=>({...await vi.importActual('../src/package-build/build-runtime'),verifyBuildRuntime:handoffMocks.verify}));
vi.mock('../src/package-build/publish-built-tool',()=>({publishBuiltTool:handoffMocks.publish}));
import {PackageBuildService} from '../src/package-build/package-build.service';
import {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import {LocalAssetIngest} from '../src/asset-sources/local-asset-ingest';
import {BuildProcessUnreapedError,stagingLimit} from '../src/package-build/build-process';
import {BuildCancelledError} from '../src/package-build/build-cancellation';

export {handoffMocks};
const {createCapacityGuard,resources}=createRequire(import.meta.url)('../../shared/capacity.cjs');
export const GiB=1024**3;
export const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const roots:string[]=[];
export async function disposeHandoffFixtures(){for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();}

/** Real guard, SHA/archive importer and blob copies; only statfs values and external producer/SQL ports are controlled. */
export async function handoffFixture({reaped=true,required=false,remaining=4.9*GiB}:{reaped?:boolean;required?:boolean;remaining?:number}={}){
    vi.clearAllMocks();
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-capacity-')));roots.push(root);
    const stageRoot=path.join(root,'staging'),storeRoot=path.join(root,'archives');await fs.mkdir(stageRoot);await fs.mkdir(storeRoot);
    vi.stubEnv('RUNTIME_ARTIFACT_DIR',storeRoot);vi.stubEnv('TOOL_BUILD_SCRIPT',path.join(root,'build.mjs'));
    // The producer manifest port supplies trusted inventory; candidate byte identity remains the real production check.
    await fs.writeFile(path.join(root,'manifest.mjs'),"import fs from 'node:fs/promises';export async function readyManifest(file){return [JSON.parse(await fs.readFile(file,'utf8'))];}\n");
    let freeBytes=Math.floor(5.4*GiB),epoch=1000;
    const guard=createCapacityGuard({required:()=>required,now:()=>epoch,
        snapshot:()=>({schemaVersion:1,observedAt:epoch,resources:Object.fromEntries(resources.map((resource:string)=>[resource,{available:true,totalBytes:20*GiB,freeBytes,filesystem:'17'}]))}),
        statfs:async()=>({bavail:BigInt(freeBytes),bsize:1n}),stat:async()=>({dev:17})});
    let afterReserve:((request:CapacityRequest)=>Promise<void>)|undefined;
    const reservations:Array<{request:CapacityRequest;release:ReturnType<typeof vi.fn>}> = [];
    handoffMocks.reserve.mockImplementation(async(request:CapacityRequest)=>{
        const release=vi.fn(await guard(request));reservations.push({request,release});await afterReserve?.(request);return release;
    });
    const archive=artifactFixture([{path:'index.mjs',content:'export default async()=>({event:async()=>{}});'}]);
    const asset=createToolAsset({id:'capacity-handoff-fixture',version:'fixture-v1',source:{type:'npm',name:'capacity-handoff-fixture',version:'1.0.0'},license:{spdx:'NOASSERTION'},
        publication:{name:'Capacity handoff',kind:'plugin',description:'Owned fixture',origin:'fixture',revision:'fixture-v1',files:[],config:{extra:{runtimeArtifacts:[archive.descriptor]}}},artifacts:[{descriptor:archive.descriptor}]});
    const publication=toToolPublication(asset),row={id:randomUUID(),request_key:randomUUID(),execution_nonce:randomUUID(),state:'RUNNING',actor:'packager@example.test',
        config:{kind:'plugin',name:publication.name,description:'Fixture',tags:[],targets:['darwin-arm64'],source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default async()=>({});'}]}}} as BuildRow;
    const registered=new Map<string,unknown>();
    const query=vi.fn(async(sql:string,values:unknown[])=>{
        if(sql.startsWith('INSERT INTO bridge_runtime_artifacts')){registered.set(String(values[0]),{compressed_bytes:values[1],unpacked_bytes:values[2],files_count:values[3]});return{rows:[]};}
        if(sql.startsWith('SELECT compressed_bytes'))return{rows:[registered.get(String(values[0]))]};
        if(sql.startsWith('INSERT INTO asset_source_blobs')){registered.set('blob:'+values[0],{bytes:values[1]});return{rows:[]};}
        if(sql.startsWith('SELECT bytes FROM asset_source_blobs'))return{rows:[registered.get('blob:'+values[0])]};
        throw Error('Unexpected controlled database operation');
    });
    const pool={query} as never,artifacts=new RuntimeArtifacts({pool} as never),blobs=new AssetBlobStore(pool,path.join(root,'blobs'));
    const originalImport=artifacts.importArchive.bind(artifacts);
    const ingest=new LocalAssetIngest(pool,blobs),importArchive=vi.spyOn(artifacts,'importArchive'),prepareLocal=vi.fn(ingest.prepare.bind(ingest));
    const progress=vi.fn(async(_id:string,state:string)=>{if(state==='FAILED')row.state='FAILED';});
    const repository={get:async()=>row,progress,recordRuntime:vi.fn(),markExecutionStarted:vi.fn(),nextAttempt:vi.fn(async()=>randomUUID()),beginPublication:vi.fn(async()=>{if(row.state==='CANCELLING')throw new BuildCancelledError();}),
        completeCancellation:vi.fn(async()=>{row.state='CANCELLED';}),cancellationAwaitingOwner:vi.fn(),cancellationCleanupFailed:vi.fn()};
    const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as never,artifacts,{} as never,{prepareLocal} as never);
    Object.assign(service,{lease:{},repository,withLease:async(_lease:unknown,work:()=>Promise<unknown>)=>work()});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({})));
    handoffMocks.publish.mockImplementation(async()=>{row.state='SUCCEEDED';});
    handoffMocks.build.mockImplementation(async(_config:unknown,stage:string,observe:(child:unknown)=>void,_progress:unknown,_signal:AbortSignal,execution:{markStarted:()=>Promise<void>;reaped:()=>void})=>{
        await execution.markStarted();observe({});
        await fs.writeFile(path.join(stage,'runtime.tar.gz'),archive.archive);
        const manifest=path.join(stage,'asset.json');await fs.writeFile(manifest,JSON.stringify({asset,publication,artifacts:[{archivePath:path.join(stage,'runtime.tar.gz'),descriptor:archive.descriptor}]}));
        freeBytes=Math.floor(remaining);if(reaped)execution.reaped();observe(undefined);return manifest;
    });
    handoffMocks.verify.mockImplementation((manifest:string,identity:string)=>runtimeReportFixture(manifest,identity));
    const failure=()=>progress.mock.calls.find(([,state])=>state==='FAILED');
    const outer=()=>reservations.find(item=>item.request.bytes===stagingLimit&&item.request.path===stageRoot)!;
    const run=()=>(service as unknown as{execute:(row:BuildRow,root:string)=>Promise<void>}).execute(row,stageRoot);
    return{row,root,stageRoot,storeRoot,asset,archive,service,repository,importArchive,prepareLocal,blobs,reservations,outer,run,guard,failure,originalImport,onReserve:(callback:(request:CapacityRequest)=>Promise<void>)=>{afterReserve=callback;},
        cancel:()=>{row.state='CANCELLING';(service as unknown as{activeBuild:{cancellation:{cancel:()=>void}}}).activeBuild.cancellation.cancel();},
        async freshSample(){epoch+=1000;return guard({resource:'runtime-artifacts',bytes:1,path:stageRoot});},
        async nextBuildSample(){freeBytes=Math.floor(5.4*GiB);epoch+=1000;return guard({resource:'runtime-artifacts',bytes:stagingLimit,path:stageRoot});},
        async noLeak(){freeBytes=Math.floor(5.4*GiB);epoch+=1000;const release=await guard({resource:'runtime-artifacts',bytes:stagingLimit,path:stageRoot});release();},
        unreaped:()=>new BuildProcessUnreapedError()};
}
