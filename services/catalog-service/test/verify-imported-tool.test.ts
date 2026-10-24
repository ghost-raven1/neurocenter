import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createToolAsset,serializeAsset,toToolPublication} from '@neurocenter/asset-contract';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {toolRuntimePath,toolSourcePath} from '../../shared/tool-supply-paths.cjs';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import type {IPreparedLocalAsset} from '../src/asset-sources/local-asset-ingest';
import {runtimeReportFixture} from './package-build-runtime.fixture';

const mocks=vi.hoisted(()=>({verify:vi.fn(),reserve:vi.fn(),release:vi.fn()}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:mocks.reserve}));
vi.mock('../src/package-build/build-runtime',async()=>({...await vi.importActual('../src/package-build/build-runtime'),verifyBuildRuntime:mocks.verify}));
import {ToolImportCleanupPendingError,withVerifiedToolImport} from '../src/package-build/verify-imported-tool';

const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex'),roots:string[]=[];
beforeEach(()=>{vi.clearAllMocks();mocks.reserve.mockResolvedValue(mocks.release);});
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-import-gate-fixture-'));roots.push(root);
    const runtime=artifactFixture([{path:'runtime/index.mjs',content:"export default async()=>({'chat.message':async()=>{}});"}]);
    const source=Buffer.from('Original opaque source snapshot'),recipe=Buffer.from('Original pinned recipe');
    const asset=createToolAsset({id:'import-gate-fixture',version:'v1',source:{type:'archive',sha256:hash(source),bytes:source.length},license:{spdx:'MIT'},
        publication:{kind:'plugin',name:'Imported gate fixture',description:'Fixture',origin:'upload',revision:'v1',files:[],config:{extra:{runtimeArtifacts:[runtime.descriptor]}}},
        artifacts:[{descriptor:runtime.descriptor}],recipe:{path:'recipes/build.md',sha256:hash(recipe)}});
    const files=[{sha256:runtime.descriptor.sha256,bytes:runtime.archive,path:toolRuntimePath(runtime.descriptor.sha256),filename:runtime.descriptor.sha256+'.tar.gz'},
        {sha256:hash(source),bytes:source,path:toolSourcePath(hash(source)),filename:hash(source)+'.source'},
        {sha256:hash(recipe),bytes:recipe,path:'recipes/build.md',filename:'recipes/build.md'}];
    for(const file of files)await fs.writeFile(path.join(root,file.sha256+'.blob'),file.bytes);
    const prepared:IPreparedLocalAsset={asset,sha256:hash(serializeAsset(asset)),requestKey:randomUUID(),publication:toToolPublication(asset),
        blobs:files.map(file=>({sha256:file.sha256,bytes:file.bytes.length,filename:file.filename}))};
    return {root,prepared,files,blobs:new AssetBlobStore({} as never,root)};
}

describe('Imported tool uses the same byte-pinned runtime gate before publication',()=>{
    it.each(['pass','failed-report','verifier-error','wrong-identity','changed-manifest'] as const)('copies its complete original supply and always removes its private stage: %s',async outcome=>{
        const f=await fixture(),publish=vi.fn(async()=>({catalogId:'fixture-card'}));let stage='';
        mocks.verify.mockImplementation(async(manifest:string,identity:string)=>{
            stage=path.dirname(manifest);expect(stage).not.toBe(f.root);
            expect(await fs.readFile(manifest,'utf8')).toBe(serializeAsset(f.prepared.asset));
            expect(identity).toBe('import:'+f.prepared.requestKey);expect(publish).not.toHaveBeenCalled();
            for(const file of f.files)expect(await fs.readFile(path.join(stage,file.path))).toEqual(file.bytes);
            if(outcome==='verifier-error')throw new Error('Runtime runner unavailable');
            const report=await runtimeReportFixture(manifest,outcome==='wrong-identity'?'different-import':identity,outcome!=='failed-report');
            if(outcome==='changed-manifest')await fs.appendFile(manifest,'changed after verification');
            return report;
        });
        const result=withVerifiedToolImport(f.prepared,f.blobs,publish);
        if(outcome==='pass'){
            await expect(result).resolves.toEqual({catalogId:'fixture-card'});expect(publish).toHaveBeenCalledOnce();
            expect(publish).toHaveBeenCalledWith(expect.objectContaining({ok:true,candidate:expect.objectContaining({identity:'import:'+f.prepared.requestKey,
                manifestSha256:hash(serializeAsset(f.prepared.asset))})}));
        }else{await expect(result).rejects.toThrow();expect(publish).not.toHaveBeenCalled();}
        expect(mocks.verify).toHaveBeenCalledOnce();expect(stage).not.toBe('');
        await expect(fs.stat(stage)).rejects.toMatchObject({code:'ENOENT'});expect(mocks.release).toHaveBeenCalledOnce();
        for(const file of f.files)expect(await fs.readFile(path.join(f.root,file.sha256+'.blob'))).toEqual(file.bytes);
    });
    it('does not run code or publish when an original retained blob no longer matches its SHA',async()=>{
        const f=await fixture(),publish=vi.fn();await fs.appendFile(path.join(f.root,f.files[0].sha256+'.blob'),'modified');
        await expect(withVerifiedToolImport(f.prepared,f.blobs,publish)).rejects.toThrow();
        expect(mocks.verify).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();expect(mocks.release).toHaveBeenCalledOnce();
    });
    it('retains its stage and capacity when verifier process cleanup could not be confirmed',async()=>{
        const f=await fixture(),publish=vi.fn();let stage='';
        mocks.verify.mockImplementation(async(manifest:string,identity:string)=>{
            stage=path.dirname(manifest);roots.push(stage);
            return {...await runtimeReportFixture(manifest,identity,false),diagnostics:[{code:'cleanup-failed',message:'Owned verifier reap was not confirmed'}]};
        });
        await expect(withVerifiedToolImport(f.prepared,f.blobs,publish)).rejects.toBeInstanceOf(ToolImportCleanupPendingError);
        expect(publish).not.toHaveBeenCalled();expect(mocks.release).not.toHaveBeenCalled();
        expect((await fs.stat(stage)).isDirectory()).toBe(true);expect(await fs.readFile(path.join(stage,'asset.json'),'utf8')).toBe(serializeAsset(f.prepared.asset));
    });
});
