import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {migrateCatalog} from '../src/database/migrations';
import {assertProjectRagAuthorizationSchema} from '../src/models/project-rag-authorization.schema-verification';
import {RAG_LEGACY_WRITE_POLICY,RAG_WRITE_POLICY,RAG_WRITE_AUTHORIZATION_REQUIRED} from '../../shared/rag-write-authorization.cjs';
import {RAG_WRITE_LOCK} from '../../rag-sync-service/src/rag/quota/rag-quota-schema';
import {connection,ragAuthorizationFixture} from './project-rag-authorization.fixture';
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));

describe.skipIf(!connection).sequential('RAG intent author admission across real PostgreSQL and loopback HTTP',()=>{
    let f:Awaited<ReturnType<typeof ragAuthorizationFixture>>;
    beforeAll(async()=>{f=await ragAuthorizationFixture();},30000);
    afterEach(()=>{if(f)Object.assign(f.state,{off:false,dropBeforeWrite:false,loseWriteAck:false,loseGrantAck:false,oldGrant:false});});
    afterAll(async()=>f?.close());

    it('upgrades29→30 without inventing legacy authors or changing old migration receipts',async()=>{
        const history=(await f.pool.query('SELECT version,name,checksum,applied_at FROM catalog_schema_migrations WHERE version<=29 ORDER BY version')).rows;
        expect(history).toEqual(f.oldHistory);
        expect(await f.legacyPending.intent()).toMatchObject({author_email:null,author_role:null,write_policy:RAG_LEGACY_WRITE_POLICY});
        const before=(await f.pool.query('SELECT * FROM project_rag_sync_intents ORDER BY id')).rows;
        await migrateCatalog(f.pool,CATALOG_MIGRATIONS);await assertProjectRagAuthorizationSchema(f.pool);
        expect((await f.pool.query('SELECT * FROM project_rag_sync_intents ORDER BY id')).rows).toEqual(before);
    });
    it('pins the authenticated author and policy in the durable intent before a lost first-delivery ACK',async()=>{
        const row=await f.seed({intent:false});f.state.dropBeforeWrite=true;
        await expect(f.coordinator.sync(row.request,row.body)).rejects.toMatchObject({status:503});
        expect(await row.intent()).toMatchObject({author_email:row.email,author_role:row.role,write_policy:RAG_WRITE_POLICY,state:'uncertain',payload_hash:row.input.payloadHash});
    });
    it('SQL refuses unpinned or unsupported authors rather than silently promoting legacy intents',async()=>{
        const row=await f.seed();
        await expect(f.pool.query("UPDATE project_rag_sync_intents SET author_email=NULL WHERE id=$1",[row.id])).rejects.toMatchObject({code:'23514'});
        await expect(f.pool.query("UPDATE project_rag_sync_intents SET author_role='Наблюдатель' WHERE id=$1",[row.id])).rejects.toMatchObject({code:'23514'});
        await expect(f.pool.query("UPDATE project_rag_sync_intents SET author_email=upper(author_email) WHERE id=$1",[row.id])).rejects.toMatchObject({code:'23514'});
        expect(await row.intent()).toMatchObject({author_email:row.email,author_role:row.role,write_policy:RAG_WRITE_POLICY});
    });
    it('readiness rejects a missing author/policy CHECK and recovers after the fixture rollback',async()=>{
        const client=await f.pool.connect();
        try{
            await client.query('BEGIN');await client.query('ALTER TABLE project_rag_sync_intents DROP CONSTRAINT project_rag_sync_intents_author_policy_check');
            await expect(assertProjectRagAuthorizationSchema(client)).rejects.toThrow('project_rag_sync_intents_author_policy_check');
        }finally{await client.query('ROLLBACK');client.release();}
        await expect(assertProjectRagAuthorizationSchema(f.pool)).resolves.toBeUndefined();
    });
    it('revocation before first delivery refuses every index mutation and preserves the original barrier',async()=>{
        const row=await f.seed();await row.revoke();
        let status:unknown;try{await f.coordinator.finish(await row.intent());}catch(error){status=(error as {getStatus:()=>number}).getStatus();}
        const actual=await row.observed();
        expect.soft(status).toBe(403);expect.soft(actual.chunks).toEqual([]);expect.soft(actual.revision).toBe(0);
        expect.soft(actual.intent).toMatchObject({state:'uncertain',payload_hash:row.input.payloadHash});
        await expect(f.coordinator.requireIdle(f.pool,row.project)).rejects.toMatchObject({status:409});
        await row.restore();expect(await f.coordinator.finish(await row.intent())).toMatchObject({upserted:1,dataRevision:1});
        expect((await row.observed()).chunks).toHaveLength(1);
    });
    it('revocation after COMMIT and lost HTTP ACK still recovers the exact receipt while rag_sync is OFF',async()=>{
        const row=await f.seed();f.state.loseWriteAck=true;
        await expect(f.coordinator.finish(await row.intent())).rejects.toMatchObject({status:503});
        const before=await row.observed();expect(before).toMatchObject({intent:{state:'uncertain'},revision:0,receipts:[{state:'succeeded'}]});
        await row.revoke();f.state.off=true;
        const reply=await f.coordinator.finish(await row.intent());expect(reply).toMatchObject({upserted:1,dataRevision:1});
        expect(await f.coordinator.finish(await row.intent())).toEqual(reply);
        const after=await row.observed();expect(after).toMatchObject({intent:{state:'succeeded'},revision:1});
        expect(after.chunks).toEqual(before.chunks);expect(after.receipts).toEqual(before.receipts);
    });
    it('unchanged permission and duplicate delivery commit one index write and one Catalog revision',async()=>{
        const row=await f.seed(),intent=await row.intent();
        const replies=await Promise.all([f.coordinator.finish(intent),f.coordinator.finish(intent)]);expect(replies[0]).toEqual(replies[1]);
        const before=await row.observed();expect(before).toMatchObject({intent:{state:'succeeded'},revision:1,chunks:[{content:'owned original bytes'}],receipts:[{state:'succeeded'}]});
        expect(await f.coordinator.finish(await row.intent())).toEqual(replies[0]);
        expect(await row.observed()).toEqual(before);
    });
    it.each(['receipt','global'])('fresh authorization follows an actual %s lock wait, rather than using a grant obtained before revocation',async lock=>{
        const row=await f.seed(),holder=await f.ragObserver.connect();let running:Promise<unknown>|undefined;
        await f.ragObserver.query("INSERT INTO rag_write_receipts(id,project_key,generation_id,payload_hash,state) VALUES($1,$2,$3,$4,'running')",[row.id,row.project,row.input.context.generation,row.input.payloadHash]);
        try{
            await holder.query('BEGIN');
            if(lock==='receipt')await holder.query('SELECT * FROM rag_write_receipts WHERE id=$1 FOR UPDATE',[row.id]);
            else await holder.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
            running=f.coordinator.finish(await row.intent());void running.catch(()=>undefined);
            const query=lock==='receipt'?'%SELECT * FROM rag_write_receipts WHERE id=$1 FOR UPDATE%':'%SELECT pg_advisory_xact_lock($1)%';
            await vi.waitFor(async()=>expect((await f.ragObserver.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",[query])).rows.length).toBeGreaterThan(0),{timeout:3000});
            await row.revoke();await holder.query('COMMIT');
            await expect(running).rejects.toMatchObject({status:403});
            expect(await row.observed()).toMatchObject({intent:{state:'uncertain'},revision:0,chunks:[],receipts:[{state:'running'}]});
        }finally{await holder.query('ROLLBACK');holder.release();await running?.catch(()=>undefined);}
    });
    it('legacy without a receipt cannot first-write; a legacy committed receipt remains recoverable',async()=>{
        await expect(f.coordinator.finish(await f.legacyPending.intent())).rejects.toMatchObject({status:403});
        expect(await f.legacyPending.observed()).toMatchObject({intent:{state:'uncertain',author_email:null,author_role:null,write_policy:RAG_LEGACY_WRITE_POLICY},revision:0,chunks:[]});
        const before=await f.legacyCommitted.observed();f.state.off=true;
        expect(await f.coordinator.finish(await f.legacyCommitted.intent())).toMatchObject({upserted:1,dataRevision:1});
        const after=await f.legacyCommitted.observed();expect(after.chunks).toEqual(before.chunks);expect(after.receipts).toEqual(before.receipts);
    });
    it('a lost grant ACK does not become reusable admission on a later attempt after revoke',async()=>{
        const row=await f.seed();f.state.loseGrantAck=true;
        await expect(f.coordinator.finish(await row.intent())).rejects.toMatchObject({status:503});
        expect(await row.observed()).toMatchObject({intent:{state:'uncertain'},revision:0,chunks:[],receipts:[{state:'running'}]});
        await row.revoke();await expect(f.coordinator.finish(await row.intent())).rejects.toMatchObject({status:403});
        expect((await row.observed()).chunks).toEqual([]);
    });
    it('mixed old/new authorization protocols fail closed before a first index write',async()=>{
        const row=await f.seed();f.state.oldGrant=true;
        await expect(f.coordinator.finish(await row.intent())).rejects.toMatchObject({status:503});
        expect(await row.observed()).toMatchObject({intent:{state:'uncertain'},revision:0,chunks:[],receipts:[]});
        f.state.oldGrant=false;
        const response=await fetch(f.base+'/internal/project-rag/write-authorize',{method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':'owned-rag-token'},body:JSON.stringify({id:row.id,payloadHash:row.input.payloadHash,context:row.input.context})});
        expect(response.status).toBe(400);await response.body?.cancel();
    });
    it('refuses changed identity/context when reading the exact committed receipt',async()=>{
        const row=await f.seed();await f.coordinator.finish(await row.intent());
        await expect(f.coordinator.authorizeWrite({id:row.id,payloadHash:'f'.repeat(64),context:row.input.context,phase:'receipt'})).rejects.toMatchObject({status:409});
        await row.revoke();await expect(f.coordinator.authorizeWrite({id:row.id,payloadHash:row.input.payloadHash,context:row.input.context,phase:'write'})).rejects.toMatchObject({status:403,response:{code:RAG_WRITE_AUTHORIZATION_REQUIRED}});
    });
    it('permanently denied old intents retain their barriers without starving a newer committed receipt',async()=>{
        const denied=[];
        for(let i=0;i<10;i++){const row=await f.seed();await row.revoke();denied.push(row);}
        const row=await f.seed();f.state.loseWriteAck=true;
        await expect(f.coordinator.finish(await row.intent())).rejects.toMatchObject({status:503});
        await f.pool.query("UPDATE project_rag_sync_intents SET created_at=now()-interval '2 hours',updated_at=now()-interval '2 hours' WHERE id=ANY($1::uuid[])",[denied.map(value=>value.id)]);
        const recover=(f.coordinator as unknown as {recover:()=>Promise<void>}).recover.bind(f.coordinator);
        await recover();expect((await row.intent()).state).toBe('uncertain');
        await recover();expect(await row.observed()).toMatchObject({intent:{state:'succeeded'},revision:1,receipts:[{state:'succeeded'}]});
        for(const old of denied){expect((await old.intent()).state).toBe('uncertain');await expect(f.coordinator.requireIdle(f.pool,old.project)).rejects.toMatchObject({status:409});}
    },15000);
});
