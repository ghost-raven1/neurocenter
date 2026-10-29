import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import type {ToolAsset} from '@neurocenter/asset-contract';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {AssetSourceSnapshots} from '../src/asset-sources/source-snapshots';
import {AssetSourceClient} from '../src/asset-sources/source-client';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import {AssetImportRepository} from '../src/asset-sources/import-repository';
import {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import {AccessDb} from '../src/access/access-db';
import {PackageBuildService} from '../src/package-build/package-build.service';
import {PackageBuildRepository} from '../src/package-build/package-build.repository';
import {publicationTargetPreview} from '../src/package-build/publication-target';
import {readBundledCatalog} from '../../shared/bundled-catalog.cjs';
const require=createRequire(import.meta.url),connection=process.env.BUNDLED_CATALOG_TEST_ADMIN_PG_URL;
const {FEATURE_FLAG_KEYS,evaluateFeatureFlags}=require('../../shared/feature-flags.cjs');
describe.skipIf(!connection).sequential('Owned bundled catalog PostgreSQL and verified native import',()=>{
    let admin:Pool,pool:Pool,database:string,root:string,source:AssetSourcesService,artifacts:RuntimeArtifacts,access:AccessDb;
    let networkCalls=0,sourceEnabled=true;const actor={email:'bundled-owner@example.test',activeRole:'Главный админ'};
    const receipt={database:'',dropped:false,sessionsRemaining:-1,networkCalls:0,checks:[] as string[]};
    beforeAll(async()=>{
        const url=callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:connection}),name='nc_bundled_'+randomUUID().replaceAll('-','');database=name;receipt.database=name;
        admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:4});
        root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc bundled publication ')));
        vi.stubEnv('RUNTIME_ARTIFACT_DIR',root);vi.stubEnv('FEATURE_FLAGS_SERVICE_URL','https://flags.bundled.invalid');vi.stubEnv('API_GATEWAY_URL','https://gateway.bundled.invalid');vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',randomUUID());
        vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
            if(String(input)==='https://flags.bundled.invalid/internal/feature-flags/evaluated')return Response.json(evaluateFeatureFlags(Object.fromEntries(FEATURE_FLAG_KEYS.map((key:string)=>[key,key!=='asset_sources'||sourceEnabled]))));
            if(String(input)==='https://gateway.bundled.invalid/internal/events')return Response.json({ok:true});
            networkCalls++;throw Error('Unexpected external request in owned bundle fixture');
        }));
        await ensureCatalogSchema(pool);await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true)',[actor.email]);
        access=Object.assign(Object.create(AccessDb.prototype),{pool}) as AccessDb;artifacts=new RuntimeArtifacts({pool} as never);
        source=Object.assign(Object.create(AssetSourcesService.prototype),{pool,sources:new AssetSourceSnapshots(pool,async()=>(await readBundledCatalog()).pin),jobs:new AssetImportRepository(pool),blobs:new AssetBlobStore(pool),runtime:artifacts,access}) as AssetSourcesService;
    },30_000);
    afterAll(async()=>{
        try{
            await pool?.end();
            if(admin&&database){receipt.sessionsRemaining=Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].count);await admin.query('DROP DATABASE '+database);receipt.dropped=true;}
        }finally{await admin?.end();if(root)await fs.rm(root,{recursive:true,force:true});receipt.networkCalls=networkCalls;if(process.env.BUNDLED_CATALOG_RECEIPT_FILE)await fs.writeFile(process.env.BUNDLED_CATALOG_RECEIPT_FILE,JSON.stringify(receipt,null,2)+'\n');vi.unstubAllEnvs();vi.unstubAllGlobals();}
    });
    it('Refresh publishes only inline metadata; current recipes stay preparation-required and previous Git metadata remains immutable',async()=>{
        const bundle=await readBundledCatalog(),legacy=bundle.historicalPins[0];
        const legacyReader=new AssetSourceClient(legacy,async()=>{throw Error('Unexpected legacy network');}),legacyIndex=await legacyReader.index();
        await source.sources.acceptArchive(legacy,legacyIndex,await Promise.all(legacyIndex.assets.map(entry=>legacyReader.descriptor(entry))), 'a'.repeat(64),async()=>{});
        const before=(await pool.query('SELECT pin,index,assets FROM asset_source_snapshots WHERE commit=$1',[legacy.commit])).rows;
        const refreshed=await source.sources.refresh(),view=await source.view();
        expect(refreshed.pin.schemaVersion).toBe(2);expect(view.source).toMatchObject({mode:'bundled',verified:true});expect(view.assets).toHaveLength(21);
        expect(view.sourcePlans).toHaveLength(13);expect(view.sourcePlans.every(plan=>!plan.catalogReady)).toBe(true);
        expect((await pool.query('SELECT pin,index,assets FROM asset_source_snapshots WHERE commit=$1',[legacy.commit])).rows).toEqual(before);
        expect(networkCalls).toBe(0);receipt.checks.push('actual SQL metadata publication preserves old snapshot and defers native recipes');
    });
    it.skipIf(!process.env.BUNDLED_CATALOG_NATIVE_ASSET)('Actual prepared Fetch archive passes native import, source receipt and catalog publication while recipe readiness remains unclaimed',async()=>{
        const filename=process.env.BUNDLED_CATALOG_NATIVE_ASSET!,directory=path.dirname(filename),asset=JSON.parse(await fs.readFile(filename,'utf8')) as ToolAsset;
        for(const {descriptor}of asset.delivery.artifacts)await fs.copyFile(path.join(directory,'artifacts',descriptor.sha256+'.tar.gz'),path.join(root,descriptor.sha256+'.tar.gz'));
        if(asset.source.type==='archive'){
            const bytes=await fs.readFile(path.join(directory,'source',asset.source.sha256+'.source'));
            const filename=path.join(root,'retained-source.json');await fs.writeFile(filename,bytes);
            await source.blobs.ingestLocal([{archivePath:filename,sha256:asset.source.sha256,bytes:asset.source.bytes,filename:asset.source.sha256+'.json'}],randomUUID());
        }
        const service=Object.assign(Object.create(PackageBuildService.prototype),{pool,access,artifacts,sources:source}) as PackageBuildService;
        const result=await service.importAsset(actor,{requestKey:randomUUID(),asset}) as {id:string};
        const cards=(await pool.query('SELECT id,name,version FROM ai_plugins')).rows,owners=(await pool.query('SELECT repository,external_id,source_commit,active FROM asset_source_receipts')).rows;
        expect(cards).toHaveLength(1);expect(owners).toMatchObject([{repository:'local-archive',external_id:'mcp-fetch-mcp',source_commit:null,active:true}]);
        expect(result).toBeTruthy();const view=await source.view(),plan=view.sourcePlans.find(row=>row.id==='mcp-fetch-mcp')!;
        expect(plan.imported?.id).toBe(cards[0].id);expect(plan.catalogReady).toBe(false);expect(networkCalls).toBe(0);
        receipt.checks.push('verified actual Fetch native import→catalog and immutable local source receipt; no false bundled-current readiness');
    },90_000);
    it.skipIf(!process.env.BUNDLED_CATALOG_NATIVE_ASSET)('Actual bundled update admission preserves exact intent through replay, OFF and revoked access while an explicitly held queue leaves the native head unchanged',async()=>{
        const bundle=await readBundledCatalog(),native=(await pool.query('SELECT id,name,version FROM ai_plugins')).rows[0];
        const target=await publicationTargetPreview(pool,'mcp',native.id),repository=new PackageBuildRepository(pool),lease=await pool.connect();
        const startWorker=vi.fn();
        const service=Object.assign(Object.create(PackageBuildService.prototype),{pool,access,artifacts,sources:source,repository,lease,leaseUse:Promise.resolve(),stopping:false,startWorker}) as PackageBuildService;
        const input={requestKey:randomUUID(),kind:'mcp',name:native.name,description:'Текущий Fetch',targets:['darwin-arm64'],source:{type:'bundled',id:'mcp-fetch-mcp',revision:bundle.revision},
            publication:{catalogId:target.catalogId,expectedVersion:target.expectedVersion,expectedSourceHash:target.expectedSourceHash}};
        try{
            const created=await service.create(actor,input),replay=await service.create(actor,input);
            expect(created.state).toBe('QUEUED');expect(replay.id).toBe(created.id);
            const stored=await repository.get(created.id);expect(stored.config.source).toEqual(input.source);expect(stored.config.publication?.catalogId).toBe(native.id);
            expect((await pool.query('SELECT version FROM ai_plugins WHERE id=$1',[native.id])).rows[0].version).toBe(native.version);
            sourceEnabled=false;expect((await service.create(actor,input)).id).toBe(created.id);
            await expect(service.create(actor,{...input,requestKey:randomUUID()})).rejects.toMatchObject({status:403});
            const cancelled=await service.cancel(actor,created.id);expect(['CANCELLED','CANCELLING']).toContain(cancelled.state);
            await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[actor.email]);
            await expect(service.get(actor,created.id)).rejects.toMatchObject({status:403});
            await pool.query('UPDATE platform_users SET enabled=true WHERE email=$1',[actor.email]);
            expect((await repository.get(created.id)).config.source).toEqual(input.source);
            expect((await pool.query('SELECT version FROM ai_plugins WHERE id=$1',[native.id])).rows[0].version).toBe(native.version);
            expect(startWorker).toHaveBeenCalled();expect(networkCalls).toBe(0);
            receipt.checks.push('actual bundled queue admission exact source/CAS, UUID replay, OFF cancellation and fresh revoked rights; held queue no native mutation');
        }finally{sourceEnabled=true;lease.release();}
    });
});
