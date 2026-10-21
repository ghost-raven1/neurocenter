vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import type {BuildRow} from '../src/package-build/package-build.model';
import {databaseFixture,tool} from './asset-import-db.fixture';
import {LocalAssetIngest} from '../src/asset-sources/local-asset-ingest';

const mocks=vi.hoisted(()=>({run:vi.fn(),release:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>mocks.release}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../src/package-build/build-process',async()=>{
    const original=await vi.importActual<typeof import('../src/package-build/build-process')>('../src/package-build/build-process');
    return {...original,runPackageBuilder:mocks.run};
});
import {PackageBuildService} from '../src/package-build/package-build.service';

describe('Canonical builder source path — actual readyManifest, PostgreSQL and filesystem',()=>{
    afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
    it('Retains exact17MiB source/<sha>.source returned by the CLI without the removed JSON filename',async()=>{
        const db=await databaseFixture();try{
            const root=await fs.realpath(db.root),asset=tool('canonical-builder-source').asset;
            const chunk=Buffer.alloc(256*1024,0x6e),hash=createHash('sha256');
            for(let index=0;index<68;index++)hash.update(chunk);
            const sha256=hash.digest('hex'),bytes=17*1024*1024;
            asset.source={type:'archive',sha256,bytes};
            let expectedPath='';
            mocks.run.mockImplementation(async(_config:unknown,stage:string)=>{
                const output=path.join(stage,'output');await fs.mkdir(path.join(output,'source'),{recursive:true});
                expectedPath=path.join(output,'source',sha256+'.source');
                const file=await fs.open(expectedPath,'wx');
                try{for(let index=0;index<68;index++)await file.writeFile(chunk);}finally{await file.close();}
                const manifest=path.join(output,'asset.json');await fs.writeFile(manifest,JSON.stringify(asset));return manifest;
            });
            const ingest=new LocalAssetIngest(db.pool,db.blobs),prepareLocal=vi.fn(ingest.prepare.bind(ingest));
            const progress=vi.fn(),withLease=vi.fn(async()=>undefined);
            const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as unknown as AccessDb,
                {} as RuntimeArtifacts,{} as CatalogService,{prepareLocal} as unknown as AssetSourcesService);
            Object.assign(service,{lease:{},repository:{progress},withLease});
            vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({})));
            const row={id:randomUUID(),request_key:randomUUID(),actor:'builder@example.test',config:{name:asset.card.name,kind:'plugin',source:{type:'files'}}} as BuildRow;
            await (service as unknown as {execute:(row:BuildRow,root:string)=>Promise<void>}).execute(row,root);
            const failed=progress.mock.calls.find(([,state])=>state==='FAILED');
            expect(failed,JSON.stringify({executeFailure:failed,progress:progress.mock.calls})).toBeUndefined();
            expect(prepareLocal).toHaveBeenCalledOnce();
            expect(prepareLocal.mock.calls[0][4]).toEqual({archivePath:expectedPath,stagingRoot:path.dirname(expectedPath)});
            expect(withLease).toHaveBeenCalledOnce();
            expect(progress.mock.calls.some(([,state])=>state==='FAILED')).toBe(false);
            const retained=await db.blobs.open(sha256),actual=createHash('sha256');let observed=0;
            for await(const part of retained.stream){observed+=part.length;actual.update(part);}
            expect(observed).toBe(bytes);expect(actual.digest('hex')).toBe(sha256);
            await expect(fs.stat(path.join(root,row.id))).rejects.toMatchObject({code:'ENOENT'});
            expect(mocks.release).toHaveBeenCalledTimes(2);
        }finally{await db.dispose();}
    });
});
