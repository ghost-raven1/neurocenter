vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {databaseFixture,tool,actor as email} from './asset-import-db.fixture';
import {LocalAssetIngest} from '../src/asset-sources/local-asset-ingest';
import {runtimeReportFixture} from './package-build-runtime.fixture';

const mocks=vi.hoisted(()=>({verify:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
// Source/provenance acceptance retains the real filesystem copy/hash gate; OS startup is covered separately.
vi.mock('../src/package-build/build-runtime',async()=>({...await vi.importActual('../src/package-build/build-runtime'),verifyBuildRuntime:mocks.verify}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const actor={email,activeRole:'Главный админ'};
function fixture(db:Awaited<ReturnType<typeof databaseFixture>>){
    let allowed=true;
    mocks.verify.mockImplementation((manifest:string,identity:string)=>runtimeReportFixture(manifest,identity));
    const ingest=new LocalAssetIngest(db.pool,db.blobs),prepareLocal=vi.fn(ingest.prepare.bind(ingest)),recordLocal=vi.fn(ingest.record.bind(ingest));
    const service=new PackageBuildService({claims:async()=>({userRoles:allowed?['Главный админ']:[]})} as unknown as AccessDb,
        {} as RuntimeArtifacts,{} as CatalogService,{prepareLocal,recordLocal,blobs:db.blobs} as unknown as AssetSourcesService);
    Object.assign(service,{pool:db.pool});
    return {service,prepareLocal,recordLocal,revoke:()=>{allowed=false;}};
}
async function source(db:Awaited<ReturnType<typeof databaseFixture>>,name:string){
    const asset=tool(name).asset,bytes=Buffer.from('Canonical source archive bytes for '+name),sha256=createHash('sha256').update(bytes).digest('hex');
    asset.source={type:'archive',sha256,bytes:bytes.length};const archivePath=path.join(db.root,sha256+'.source');await fs.writeFile(archivePath,bytes);
    return {asset,bytes,sha256,file:{archivePath,sha256,bytes:bytes.length,filename:sha256+'.source'}};
}
describe('Source asset API import uses only registered immutable SHA blobs — actual PostgreSQL and filesystem',()=>{
    afterEach(()=>vi.clearAllMocks());
    it('Rejects the removed base64 field before source ingestion or native/provenance writes',async()=>{
        const db=await databaseFixture();try{
            const f=fixture(db),input=await source(db,'canonical-import-legacy-rejected');
            await expect(f.service.importAsset(actor,{requestKey:randomUUID(),asset:input.asset,sourceSnapshotBase64:input.bytes.toString('base64')})).rejects.toMatchObject({status:400});
            expect(f.prepareLocal).not.toHaveBeenCalled();expect(f.recordLocal).not.toHaveBeenCalled();
            for(const table of ['ai_plugins','ai_plugin_versions','asset_source_versions','asset_source_blobs'])expect((await db.pool.query('SELECT * FROM '+table)).rowCount).toBe(0);
        }finally{await db.dispose();}
    });
    it('Pre-ingested exact bytes publish once, retain source history, reject payload changes and honour role revocation',async()=>{
        const db=await databaseFixture();try{
            const f=fixture(db),input=await source(db,'canonical-import-registered');
            await db.blobs.ingestLocal([input.file],randomUUID());
            const imported=await f.service.importAsset(actor,{requestKey:randomUUID(),asset:input.asset});
            expect(imported).toMatchObject({assetId:input.asset.id,sourceVersion:input.asset.version,version:1});
            expect(f.prepareLocal).toHaveBeenCalledExactlyOnceWith(input.asset,[],expect.any(String));
            const repeated=await f.service.importAsset(actor,{requestKey:randomUUID(),asset:input.asset});
            const {runtimeVerification:_runtimeVerification,...published}=imported as Record<string,unknown>;expect(repeated).toMatchObject(published);
            expect(mocks.verify).toHaveBeenCalledTimes(2);
            expect((await db.pool.query('SELECT * FROM ai_plugins')).rowCount).toBe(1);expect((await db.pool.query('SELECT * FROM ai_plugin_versions')).rowCount).toBe(1);
            expect(await db.jobs.versions('local-archive')).toHaveLength(1);
            const retained=await db.blobs.open(input.sha256),chunks=[];for await(const chunk of retained.stream)chunks.push(chunk);expect(Buffer.concat(chunks)).toEqual(input.bytes);
            await expect(f.service.importAsset(actor,{requestKey:randomUUID(),asset:{...input.asset,card:{...input.asset.card,description:'Changed same immutable version'}}})).rejects.toMatchObject({status:409});
            f.revoke();await expect(f.service.importAsset(actor,{requestKey:randomUUID(),asset:input.asset})).rejects.toMatchObject({status:403});
            expect((await db.pool.query('SELECT * FROM ai_plugin_versions')).rowCount).toBe(1);expect(await db.jobs.versions('local-archive')).toHaveLength(1);
        }finally{await db.dispose();}
    });
    it('Missing or corrupted registered source bytes cannot publish a native card or source receipt',async()=>{
        const db=await databaseFixture();try{
            const f=fixture(db),input=await source(db,'canonical-import-bad-source');
            await expect(f.service.importAsset(actor,{requestKey:randomUUID(),asset:input.asset})).rejects.toMatchObject({status:409});
            await db.blobs.ingestLocal([input.file],randomUUID());
            const cached=await db.blobs.checkedPath(input.sha256,input.bytes.length);await fs.chmod(cached,0o600);await fs.writeFile(cached,Buffer.alloc(input.bytes.length,0));
            await expect(f.service.importAsset(actor,{requestKey:randomUUID(),asset:input.asset})).rejects.toMatchObject({status:409});
            expect(f.recordLocal).not.toHaveBeenCalled();expect((await db.pool.query('SELECT * FROM ai_plugins')).rowCount).toBe(0);expect(await db.jobs.versions('local-archive')).toHaveLength(0);
        }finally{await db.dispose();}
    });
});
