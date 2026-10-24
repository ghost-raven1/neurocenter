import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createToolAsset,serializeAsset,toToolPublication} from '@neurocenter/asset-contract';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {TOOL_IMPORT_TIMEOUT_MS} from '../../shared/tool-import-deadline.cjs';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import {runtimeReportFixture} from './package-build-runtime.fixture';

const mocks=vi.hoisted(()=>({pool:{} as object,verify:vi.fn(),release:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>mocks.pool}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>mocks.release}));
vi.mock('../src/package-build/build-runtime',async()=>({...await vi.importActual('../src/package-build/build-runtime'),verifyBuildRuntime:mocks.verify}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const actor={email:'import-deadline@example.test',activeRole:'Главный админ'},roots:string[]=[];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const settled=<T>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
beforeEach(()=>vi.clearAllMocks());
afterEach(async()=>{vi.useRealTimers();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});

async function fixture(){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-tool-import-cancel-'));roots.push(root);
    const runtime=artifactFixture([{path:'runtime/index.mjs',content:'export default async()=>({});'}]);
    const asset=createToolAsset({id:'import-deadline-fixture',version:'v1',source:{type:'npm',name:'fixture',version:'1.0.0'},license:{spdx:'MIT'},
        publication:{kind:'plugin',name:'Import deadline fixture',description:'Controlled cancellation fixture',revision:'v1',files:[],config:{extra:{runtimeArtifacts:[runtime.descriptor]}}},artifacts:[{descriptor:runtime.descriptor}]});
    await fs.writeFile(path.join(root,runtime.descriptor.sha256+'.blob'),runtime.archive);
    const input={requestKey:randomUUID(),asset},prepared={asset,publication:toToolPublication(asset),requestKey:input.requestKey,
        sha256:createHash('sha256').update(serializeAsset(asset)).digest('hex'),blobs:[{sha256:runtime.descriptor.sha256,bytes:runtime.archive.length,filename:runtime.descriptor.sha256+'.tar.gz'}]};
    const events:string[]=[],release=vi.fn(),query=vi.fn(async(sql:string,values?:unknown[])=>{
        events.push(sql);
        if(sql.includes('EXTRACT(EPOCH'))return {rows:[{lock_ms:'0',statement_ms:'0'}]};
        if(sql.includes('INSERT INTO ai_plugins '))return {rows:[{id:values![0],name:values![1],kind:'plugin',description:values![3],version:1,tags:[],origin:'npm',revision:'v1',config:prepared.publication.config,files:[],created_at:'then',updated_at:'then'}]};
        return {rows:[]};
    });
    mocks.pool={connect:vi.fn(async()=>({query,release}))};
    const importArchive=vi.fn(async()=>runtime.descriptor),prepareLocal=vi.fn(async()=>prepared),recordLocal=vi.fn(async()=>({assetId:asset.id,sourceVersion:asset.version,sourceSha256:prepared.sha256}));
    const blobs=new AssetBlobStore({} as never,root),service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as never,{importArchive} as never,{} as never,{prepareLocal,recordLocal,blobs} as never);
    let stage='';mocks.verify.mockImplementation(async(manifest:string,identity:string)=>{stage=path.dirname(manifest);return runtimeReportFixture(manifest,identity);});
    return {service,input,prepared,events,query,release,importArchive,prepareLocal,recordLocal,blobs,stage:()=>stage};
}

describe('Synchronous import owns cancellation before its first archive and through publication',()=>{
    it('starts its single deadline before archive validation, awaits cleanup, and never continues into preparation',async()=>{
        const f=await fixture(),started=deferred(),resume=deferred();let finished=false;
        f.importArchive.mockImplementation(async()=>{started.resolve();await resume.promise;return {} as never;});
        vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
        const pending=settled(f.service.importAsset(actor,f.input)).finally(()=>{finished=true;});
        try{
            await started.promise;await vi.advanceTimersByTimeAsync(TOOL_IMPORT_TIMEOUT_MS);
            const signal=(f.importArchive.mock.calls[0] as unknown[])[2] as AbortSignal;
            expect(finished).toBe(false);
            resume.resolve();const result=await pending;
            expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({status:504,message:expect.stringContaining('Повторите тот же запрос')});
            expect(signal?.aborted).toBe(true);
            expect(f.prepareLocal).not.toHaveBeenCalled();expect(mocks.verify).not.toHaveBeenCalled();expect(f.events).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        }finally{resume.resolve();await pending;}
    });
    it('never publishes a verifier success that arrives after caller cancellation, and removes its own stage first',async()=>{
        const f=await fixture(),abort=new AbortController(),started=deferred(),resume=deferred(),reason=Error('Controlled caller disconnect');let stage='';
        mocks.verify.mockImplementation(async(manifest:string,identity:string,signal:AbortSignal)=>{
            stage=path.dirname(manifest);expect(signal).toBe((f.importArchive.mock.calls[0] as unknown[])[2]);started.resolve();await resume.promise;return runtimeReportFixture(manifest,identity);
        });
        const pending=settled(f.service.importAsset(actor,f.input,abort.signal));
        try{
            await started.promise;abort.abort(reason);resume.resolve();const result=await pending;
            expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toBe(reason);
            expect(f.events).toEqual([]);expect(f.recordLocal).not.toHaveBeenCalled();expect(mocks.release).toHaveBeenCalledOnce();
            await expect(fs.stat(stage)).rejects.toMatchObject({code:'ENOENT'});
        }finally{resume.resolve();await pending;}
    });
    it('rolls back an in-flight source receipt after cancellation instead of committing a late card',async()=>{
        const f=await fixture(),abort=new AbortController(),reason=Error('Controlled receipt cancellation');
        f.recordLocal.mockImplementation(async()=>{abort.abort(reason);return {assetId:f.input.asset.id,sourceVersion:'v1',sourceSha256:f.prepared.sha256};});
        await expect(f.service.importAsset(actor,f.input,abort.signal)).rejects.toBe(reason);
        expect(f.events.some(sql=>sql.includes('INSERT INTO ai_plugins '))).toBe(true);
        expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.events).not.toContain('COMMIT');expect(f.release).toHaveBeenCalledExactlyOnceWith();
        await expect(fs.stat(f.stage())).rejects.toMatchObject({code:'ENOENT'});
    });
    it('keeps the exact direct response and input, and installs SQL bounds before any publication lock',async()=>{
        const f=await fixture(),original=JSON.stringify(f.input),result=await f.service.importAsset(actor,f.input);
        expect(result).toMatchObject({catalogId:expect.stringContaining('ai-plug-'),name:'Import deadline fixture',version:1,assetId:f.input.asset.id,sourceVersion:'v1',sourceSha256:f.prepared.sha256,runtimeVerification:{ok:true}});
        expect(JSON.stringify(f.input)).toBe(original);expect(f.events.at(-1)).toBe('COMMIT');expect(f.events).not.toContain('ROLLBACK');
        const settings=f.events.findIndex(sql=>sql.includes('set_config'));
        expect(settings).toBeGreaterThan(f.events.indexOf('BEGIN'));expect(settings).toBeLessThan(f.events.findIndex(sql=>sql.includes('pg_advisory_xact_lock')));
        expect(f.query).toHaveBeenCalledWith(expect.stringContaining('set_config'),['5000ms','30000ms']);
        const signal=(f.importArchive.mock.calls[0] as unknown[])[2];
        expect(f.prepareLocal).toHaveBeenCalledWith(f.input.asset,expect.any(Array),f.input.requestKey,undefined,undefined,signal);
        expect(f.recordLocal).toHaveBeenCalledWith(expect.any(Object),f.prepared,expect.any(Object),actor.email,undefined,signal);
    });
});
