import {afterAll,describe,expect,it,vi} from 'vitest';
import {Client,Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {RAG_WRITE_LOCK} from '../src/rag/quota/rag-quota-schema';
import {RagDb} from '../src/rag/rag-db';
import {applyPlatformQuotaPolicy,platformQuotaPolicy,validatePlatformQuotaUpdate} from '../src/rag/quota/platform-quota';
import {PlatformQuotaController} from '../src/rag/quota/platform-quota.controller';
import type {ProjectDatabases} from '../src/rag/project-databases';

describe('Platform quota validation',()=>{
    it.each([null,[],{}, {defaultBytes:1,maximumBytes:2}, {defaultBytes:0,maximumBytes:2,expectedRevision:0},
        {defaultBytes:3,maximumBytes:2,expectedRevision:0}, {defaultBytes:1,maximumBytes:Infinity,expectedRevision:0},
        {defaultBytes:1.5,maximumBytes:2,expectedRevision:0}, {defaultBytes:1,maximumBytes:2,expectedRevision:-1},
        {defaultBytes:1,maximumBytes:2,expectedRevision:0,actor:'forged'}, {defaultBytes:'1',maximumBytes:2,expectedRevision:0}])('rejects invalid or forged settings %j',value=>{
        expect(()=>validatePlatformQuotaUpdate(value)).toThrow();
    });
    it('allows exact byte values larger than the old pilot cap',()=>{
        expect(()=>validatePlatformQuotaUpdate({defaultBytes:1024**3,maximumBytes:64*1024**3,expectedRevision:0})).not.toThrow();
    });
    it.each([null,{},[],{actor:'a'},{policy:undefined,actor:'a'},{policy:{},actor:'a'}, {policy:{defaultBytes:1,maximumBytes:2,expectedRevision:0},actor:'a',extra:true}])('PATCH cannot turn malformed data into a read %j',body=>{
        const controller=new PlatformQuotaController({platformQuota:()=>{throw new Error('must not access database');}} as unknown as ProjectDatabases);
        expect(()=>controller.save(body as never)).toThrow(/Укажите/);
    });
});

const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
describe.skipIf(!connection)('Durable platform quota in disposable PostgreSQL',()=>{
    const fixtures:Array<{admin:Client;pool:Pool;name:string;db:RagDb}>=[];
    async function fixture(){
        const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Disposable local database required');
        const admin=new Client({connectionString:url.toString()});await admin.connect();
        const name='nc_quota_policy_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}"`);url.pathname='/'+name;
        const pool=new Pool({connectionString:url.toString(),max:3}),db=new RagDb({url:url.toString(),scope:'base'});fixtures.push({admin,pool,name,db});
        await db.setup();return {pool,db,url:url.toString()};
    }
    afterAll(async()=>{for(const f of fixtures){await f.db.close();await f.pool.end();await f.admin.query(`DROP DATABASE "${f.name}"`);await f.admin.end();}},30000);
    it('seeds once, persists above 16 GiB, audits and survives another setup',async()=>{
        const f=await fixture(),before=await f.db.platformQuota();
        const saved=await f.db.platformQuota({defaultBytes:2*1024**3,maximumBytes:64*1024**3,expectedRevision:before.revision},'admin@example.test');
        expect(saved).toMatchObject({revision:before.revision+1,updatedBy:'admin@example.test',maximumBytes:64*1024**3});
        const second=new RagDb({url:f.url,scope:'base'});try{await second.setup();expect(await second.platformQuota()).toEqual(saved);}finally{await second.close();}
        expect((await f.pool.query('SELECT actor,before_policy,after_policy FROM rag_platform_quota_events')).rows).toEqual([{actor:'admin@example.test',before_policy:before,after_policy:saved}]);
    });
    it('only one competing update wins, and replay adds no audit event',async()=>{
        const f=await fixture(),before=await f.db.platformQuota();
        const results=await Promise.allSettled([2,3].map(n=>f.db.platformQuota({defaultBytes:1,maximumBytes:n,expectedRevision:before.revision},'admin@example.test')));
        expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
        const saved=await f.db.platformQuota();
        expect(await f.db.platformQuota({defaultBytes:saved.defaultBytes,maximumBytes:saved.maximumBytes,expectedRevision:before.revision},'admin@example.test')).toEqual(saved);
        expect((await f.pool.query('SELECT count(*)::int AS n FROM rag_platform_quota_events')).rows[0].n).toBe(1);
    });
    it('invalid settings or missing actor cannot mutate or produce an audit record',async()=>{
        const f=await fixture(),before=await f.db.platformQuota();
        await expect(platformQuotaPolicy(f.pool,{defaultBytes:2,maximumBytes:1,expectedRevision:before.revision},'admin')).rejects.toMatchObject({status:400});
        await expect(platformQuotaPolicy(f.pool,{defaultBytes:1,maximumBytes:2,expectedRevision:before.revision})).rejects.toMatchObject({status:400});
        expect(await f.db.platformQuota()).toEqual(before);expect((await f.pool.query('SELECT count(*)::int AS n FROM rag_platform_quota_events')).rows[0].n).toBe(0);
    });
    it('new defaults and cap leave established budgets intact, and constrain later changes',async()=>{
        const f=await fixture(),kept=await f.db.quota('existing');
        const policy={...await f.db.platformQuota(),defaultBytes:100,maximumBytes:200};await applyPlatformQuotaPolicy(f.pool,policy);
        expect(await f.db.quota('existing')).toMatchObject({limitBytes:kept.limitBytes,maximumBytes:200,revision:kept.revision});
        expect(await f.db.quota('new')).toMatchObject({limitBytes:100,maximumBytes:200});
        await expect(f.db.quota('new',{limitBytes:201,expectedRevision:0},'admin')).rejects.toMatchObject({status:400});
        expect(await f.db.quota('new',{limitBytes:200,expectedRevision:0},'admin')).toMatchObject({limitBytes:200,revision:1});
    });
    it('a delayed old platform snapshot cannot restore a larger cap or grant a new over-cap project budget',async()=>{
        const central=await fixture(),project=await fixture();
        // This is the old request paused after reading central metadata but before the project write lock.
        const delayed=await central.db.platformQuota();await applyPlatformQuotaPolicy(project.pool,delayed);
        const current=await central.db.platformQuota({defaultBytes:100,maximumBytes:200,expectedRevision:delayed.revision},'main@example.test');
        await applyPlatformQuotaPolicy(project.pool,current);expect(await project.db.quota('race-project')).toMatchObject({limitBytes:100,maximumBytes:200});
        // A newer request has already refreshed this project; then the stale request acquires its lock.
        await applyPlatformQuotaPolicy(project.pool,delayed);
        expect(await project.db.quota('race-project')).toMatchObject({limitBytes:100,maximumBytes:200});
        await expect(project.db.quota('race-project',{limitBytes:201,expectedRevision:0},'admin@example.test')).rejects.toMatchObject({status:400});
        expect(await project.db.quota('race-project')).toMatchObject({limitBytes:100,revision:0});
    });
    it('reads the central policy only after the project write lock is acquired',async()=>{
        const central=await fixture(),project=await fixture(),before=await central.db.platformQuota();
        const holder=await project.pool.connect();let reads=0,pending:Promise<void>|undefined;
        try{
            await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
            pending=applyPlatformQuotaPolicy(project.pool,async()=>{reads++;return central.db.platformQuota();});
            await vi.waitFor(async()=>{
                const waiting=(await project.pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objid=$1::oid AND NOT granted",[RAG_WRITE_LOCK])).rows[0].count;
                expect(waiting).toBe(1);
            },{timeout:3000,interval:10});
            expect(reads).toBe(0);
            await central.db.platformQuota({defaultBytes:111,maximumBytes:222,expectedRevision:before.revision},'main@example.test');
            await holder.query('COMMIT');await pending;expect(reads).toBe(1);
            expect(await project.db.quota('fresh-after-lock')).toMatchObject({limitBytes:111,maximumBytes:222});
        }finally{await holder.query('ROLLBACK');holder.release();await pending;}
    });
    it('unconfirmed policy fails before overwriting project defaults',async()=>{
        const f=await fixture(),before=(await f.pool.query('SELECT * FROM rag_storage_settings')).rows;
        await expect(applyPlatformQuotaPolicy(f.pool,{...await f.db.platformQuota(),defaultBytes:1,maximumBytes:0})).rejects.toMatchObject({status:503});
        expect((await f.pool.query('SELECT * FROM rag_storage_settings')).rows).toEqual(before);
    });
});
