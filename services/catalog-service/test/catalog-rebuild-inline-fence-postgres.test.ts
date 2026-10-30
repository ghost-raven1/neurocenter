import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {ServiceUnavailableException} from '@nestjs/common';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {AccessDb} from '../src/access/access-db';
import {AssetSourceSnapshots} from '../src/asset-sources/source-snapshots';
import {AssetImportRepository} from '../src/asset-sources/import-repository';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {PackageBuildService} from '../src/package-build/package-build.service';
import {fenceRebuildInlineAdmission} from '../src/package-build/catalog-rebuild-inline';
import {readBundledCatalog} from '../../shared/bundled-catalog.cjs';
import {catalogRebuildRequestKey} from '../../shared/catalog-rebuild-request.cjs';

const require=createRequire(import.meta.url),{FEATURE_FLAG_KEYS,evaluateFeatureFlags}=require('../../shared/feature-flags.cjs');
const connection=process.env.REBUILD_INLINE_FENCE_TEST_ADMIN_PG_URL,compiled=process.env.REBUILD_INLINE_FENCE_COMPILED==='1';
const types=compiled?{Service:require('../dist/asset-sources/asset-sources.service.js').AssetSourcesService,Repository:require('../dist/asset-sources/import-repository.js').AssetImportRepository,
    Build:require('../dist/package-build/package-build.service.js').PackageBuildService}:{Service:AssetSourcesService,Repository:AssetImportRepository,Build:PackageBuildService};
const actorA={email:'fence-owner-a@example.test',activeRole:'Главный админ' as const},actorB={email:'fence-owner-b@example.test',activeRole:'Главный админ' as const};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
interface Lookup {rebuildRequest(actor:typeof actorA,key:string,kind:'inline'):Promise<{id:string}>}

/** Only this owned DB and two real Main accounts participate; the import worker never executes. */
describe.skipIf(!connection).sequential('Rebuild inline admission fences the current leader and one canonical request owner',()=>{
    let admin:Pool,pool:Pool,source:AssetSourcesService,lookup:Lookup,database:string,commit:string,assetId:string,created=false;
    const kick=vi.fn(),receipt={compiled,database:'',systemIdentifier:'',sessionsBeforeDrop:-1,dropped:false,externalCalls:0,observed:[] as unknown[]};
    beforeAll(async()=>{
        const url=callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:connection}),expected=process.env.REBUILD_INLINE_FENCE_TEST_SYSTEM_IDENTIFIER;
        if(!expected||!/^\d+$/.test(expected))throw Error('Explicit owned PostgreSQL system identity required.');
        admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
        receipt.systemIdentifier=(await admin.query<{id:string}>('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
        expect(receipt.systemIdentifier).toBe(expected);database='nc_rebuild_fence_'+randomUUID().replaceAll('-','');receipt.database=database;
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});await ensureCatalogSchema(pool);
        await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true),($2,true,true)',[actorA.email,actorB.email]);
        vi.stubEnv('FEATURE_FLAGS_SERVICE_URL','http://rebuild-inline-fence.invalid');
        vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
            const target=typeof input==='string'?input:input instanceof URL?input.href:input.url;
            if(target!=='http://rebuild-inline-fence.invalid/internal/feature-flags/evaluated'){receipt.externalCalls++;throw Error('External request forbidden in inline fence fixture.');}
            return Response.json(evaluateFeatureFlags(Object.fromEntries(FEATURE_FLAG_KEYS.map((key:string)=>[key,true]))));
        }));
        const bundle=await readBundledCatalog(),sources=new AssetSourceSnapshots(pool,async()=>bundle.pin),snapshot=await sources.refresh();commit=snapshot.pin.commit;
        const selected=snapshot.assets.find(row=>row.current&&['agent','skill'].includes(row.asset.kind));if(!selected)throw Error('Current inline source metadata required.');assetId=selected.asset.id;
        const access=Object.assign(Object.create(AccessDb.prototype),{pool}) as AccessDb;
        source=Object.assign(Object.create(types.Service.prototype),{pool,access,sources,jobs:new types.Repository(pool),worker:{kick}}) as AssetSourcesService;
        lookup=Object.assign(Object.create(types.Build.prototype),{pool,access,sources:source}) as Lookup;
    },30000);
    afterAll(async()=>{
        try{await pool?.end();if(admin&&created){receipt.sessionsBeforeDrop=Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].count);
            await admin.query('DROP DATABASE '+database);receipt.dropped=!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount;}}
        finally{await admin?.end();if(process.env.REBUILD_INLINE_FENCE_TEST_RECEIPT_FILE)await writeFile(process.env.REBUILD_INLINE_FENCE_TEST_RECEIPT_FILE,JSON.stringify(receipt,null,2)+'\n');vi.unstubAllGlobals();vi.unstubAllEnvs();}
    },15000);
    const body=(key:string)=>({requestKey:key,commit,ids:[assetId]});
    const freshKey=()=>catalogRebuildRequestKey(randomUUID(),'inline:0');
    const admit=(actor:typeof actorA,key:string,assertCurrent=()=>{})=>source.start(actor.email,body(key),client=>fenceRebuildInlineAdmission(client,actor.email,key,assertCurrent));
    const outcome=<T>(pending:Promise<T>)=>pending.then(value=>({accepted:true,status:201,value}),error=>({accepted:false,status:typeof error.getStatus==='function'?error.getStatus():0,value:undefined}));
    async function durable(key:string){return {jobs:(await pool.query('SELECT id,actor,request_key,state FROM asset_source_jobs WHERE request_key=$1 ORDER BY actor',[key])).rows,
        audits:(await pool.query("SELECT * FROM security_events WHERE action='asset.import.request' AND resource_id IN (SELECT id::text FROM asset_source_jobs WHERE request_key=$1)",[key])).rows};}

    it('serializes two real Main admissions after both original global owner lookups returned404',async()=>{
        const key=freshKey();await expect(lookup.rebuildRequest(actorA,key,'inline')).rejects.toMatchObject({status:404});await expect(lookup.rebuildRequest(actorB,key,'inline')).rejects.toMatchObject({status:404});kick.mockClear();
        const outcomes=await Promise.all([outcome(admit(actorA,key)),outcome(admit(actorB,key))]),after=await durable(key);
        receipt.observed.push({case:'concurrent-actor-race',bothOriginalLookups404:true,outcomes:outcomes.map(row=>({accepted:row.accepted,status:row.status})),jobs:after.jobs,audits:after.audits.length,kicks:kick.mock.calls.length});
        expect.soft(outcomes.filter(row=>row.accepted)).toHaveLength(1);expect.soft(outcomes.filter(row=>row.status===409)).toHaveLength(1);
        expect.soft(after.jobs).toHaveLength(1);expect.soft(after.audits).toHaveLength(1);expect(kick).toHaveBeenCalledOnce();
    },30000);

    it('a lost ACK replay keeps the accepted original owner and job without duplicating the import',async()=>{
        const key=freshKey(),first=await admit(actorA,key),recovered=await lookup.rebuildRequest(actorA,key,'inline'),again=await admit(actorA,key);
        const after=await durable(key);expect(recovered.id).toBe(first.id);expect(again.id).toBe(first.id);expect(after.jobs).toHaveLength(1);expect(after.audits).toHaveLength(1);
        await expect(lookup.rebuildRequest(actorB,key,'inline')).rejects.toMatchObject({status:409});
        receipt.observed.push({case:'same-owner-replay',id:first.id,jobs:after.jobs.length,audits:after.audits.length,foreignLookupStatus:409});
    },30000);

    it('lease loss while the real global admission lock is held writes no queue, audit or wake',async()=>{
        const key=freshKey(),holder=await pool.connect(),entered=deferred();let live=true,clientPid:number|undefined;
        await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['catalog-rebuild-import:'+key]);kick.mockClear();
        const pending=outcome(source.start(actorA.email,body(key),async(client:PoolClient)=>{
            clientPid=(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;entered.resolve();
            await fenceRebuildInlineAdmission(client,actorA.email,key,()=>{if(!live)throw new ServiceUnavailableException('Owned fixture lease ended.');});
        }));
        let result:Awaited<typeof pending>|undefined,waitObserved=false;
        try{
            const reached=await Promise.race([entered.promise.then(()=>true),pending.then(value=>{result=value;return false;})]);
            if(reached){const deadline=Date.now()+5000;
                while(Date.now()<deadline){const row=(await holder.query<{waiting:boolean}>("SELECT wait_event_type='Lock' AND wait_event='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1",[clientPid])).rows[0];if(row?.waiting){waitObserved=true;break;}}
                expect(waitObserved).toBe(true);
            }
            live=false;await holder.query('COMMIT');result=await pending;
        }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();}
        const after=await durable(key);receipt.observed.push({case:'lease-lost-at-admission',waitObserved,outcome:{accepted:result.accepted,status:result.status},jobs:after.jobs.length,audits:after.audits.length,kicks:kick.mock.calls.length});
        expect.soft(result).toMatchObject({accepted:false,status:503});expect.soft(after.jobs).toEqual([]);expect.soft(after.audits).toEqual([]);expect(kick).not.toHaveBeenCalled();
        expect((await pool.query('SELECT count(*)::int AS n FROM ai_plugins')).rows[0].n).toBe(0);expect(receipt.externalCalls).toBe(0);
    },30000);
});
