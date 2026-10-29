import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {CATALOG_SCHEMA_FACTS_SQL} from '../src/database/schema-catalog';
import {MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT} from '../src/model-token-quotas/model-token-quotas.schema-contract';
import {assertModelTokenQuotasSchema} from '../src/model-token-quotas/model-token-quotas.schema-verification';
import {quotaCounters} from '../src/model-token-quotas/quota-counters';
import {quotaPairLock} from '../src/model-token-quotas/quota-database';
import {quotaTransaction} from '../src/model-token-quotas/quota-database';
import {quotaAdminUrl,quotaPostgresFixture,quotaModel,quotaUser,quotaWriter,quotaEstimate} from './model-token-quotas-postgres.fixture';
import type {UsageTerminal} from '../src/model-usage/model-usage.types';
import {ModelUsageService} from '../src/model-usage/model-usage.service';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {RemoteModelClient} from '../src/models/remote-model-client';
import type {ModelsService} from '../src/models/models.service';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {ModelTokenQuotasRepository} from '../src/model-token-quotas/model-token-quotas.repository';
import {ModelUsageRepository} from '../src/model-usage/model-usage.repository';
import {quotaFaultPool} from './model-token-quotas-transactions.fixture';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';

const terminal=(patch:Partial<UsageTerminal>={}):UsageTerminal=>({quotaTracked:true,status:'success',inputTokens:10,outputTokens:20,latencyMs:1,dispatchCount:1,dispatchedAt:new Date().toISOString(),...patch});
function usageForOwnDatabase(url:string):ModelUsageService{
    const previous=process.env.CATALOG_PG_URL;
    try{process.env.CATALOG_PG_URL=url;return new ModelUsageService({ready:async()=>undefined} as unknown as ModelsService);}
    finally{if(previous===undefined)delete process.env.CATALOG_PG_URL;else process.env.CATALOG_PG_URL=previous;}
}
async function waitOwnedLock(pool:Pool,fragment:string):Promise<void>{
    const until=Date.now()+2000;
    while(Date.now()<until){
        const row=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 LIMIT 1",['%'+fragment+'%'])).rows[0];
        if(row)return;
    }
    throw Error('The controlled own-database lock wait was not observed.');
}
describe.skipIf(!quotaAdminUrl)('Own PostgreSQL single-ledger quota invariants',()=>{
    let f:Awaited<ReturnType<typeof quotaPostgresFixture>>;
    beforeAll(async()=>{f=await quotaPostgresFixture();});afterAll(async()=>{await f?.close();});beforeEach(async()=>f.reset());
    it('atomically admits only one of two reservations for the last budget, without a second attempt table',async()=>{
        await f.policy(100);const ids=await Promise.all([f.begin(),f.begin()]);
        const result=await Promise.allSettled(ids.map(id=>f.reserve(id,60)));
        expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
        const rows=(await f.pool.query("SELECT id,quota_reserved_tokens FROM model_usage_calls WHERE quota_state='reserved'")).rows;
        expect(rows).toHaveLength(1);expect(Number(rows[0].quota_reserved_tokens)).toBe(60);
        const rejected=ids.find(id=>id!==rows[0].id)!;await expect(f.reserve(rejected,60)).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_EXCEEDED'}});
    });
    it('joins the real usage owner, physical admission and uncapped transport around one durable UUID',async()=>{
        await f.policy(10000);const usage=usageForOwnDatabase(f.databaseUrl);
        const flags=defaultFeatureFlags();flags.user_model_token_quotas=true;flags.model_rate_limits=false;
        vi.stubGlobal('fetch',vi.fn(async()=>Response.json(evaluateFeatureFlags(flags))));
        const gate=new ModelApiAdmission({acquire:vi.fn()} as never,usage);
        let dispatchedId:string|undefined;
        const provider=vi.fn(async(_url:unknown,init:RequestInit)=>{
            const rows=(await f.pool.query("SELECT id,quota_state,quota_reserved_tokens FROM model_usage_calls")).rows;
            expect(rows).toHaveLength(1);expect(rows[0].quota_state).toBe('dispatched');expect(BigInt(rows[0].quota_reserved_tokens)).toBeGreaterThan(4096n);dispatchedId=rows[0].id;
            expect(JSON.parse(String(init.body))).not.toHaveProperty('max_tokens');
            return Response.json({model:quotaModel.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'owned fixture answer'}}],usage:{prompt_tokens:10,completion_tokens:20}});
        });
        try{
            await usage.onModuleInit();
            const client=new RemoteModelClient({fetch:provider as typeof fetch,admission:gate});
            const answer=await withModelUsage({purpose:'direct',actorEmail:quotaUser},()=>usage.observe(quotaModel,'chat',signal=>client.infer(quotaModel,
                {modelId:quotaModel.id,revision:1,baseUrl:'https://never-used-provider.example.test/v1',requestDimensions:false},'chat',{messages:[{role:'user',content:'owned task'}]},signal)));
            expect(answer).toMatchObject({prompt_eval_count:10,eval_count:20});expect(provider).toHaveBeenCalledOnce();
            expect((await f.pool.query('SELECT id,status,dispatch_count,quota_state,quota_debit_tokens FROM model_usage_calls')).rows)
                .toEqual([{id:dispatchedId,status:'success',dispatch_count:1,quota_state:'settled',quota_debit_tokens:'30'}]);
            expect((await f.policies.read(quotaModel,quotaUser)).counters).toMatchObject({chargedTokens:'30',activeReservedTokens:'0',unknownHeldTokens:'0'});
        }finally{await usage.onApplicationShutdown();vi.unstubAllGlobals();}
    });
    it('keeps first accountingStartedAt across period, pin, revision and disable changes; pre-policy unknown stays unchanged',async()=>{
        const old=await f.begin();await f.pool.query("UPDATE model_usage_calls SET status='interrupted',finished_at=clock_timestamp(),lease_until=NULL,dispatch_count=1 WHERE id=$1",[old]);
        const first=await f.policy(100),changed=await f.policy(200,1,7*86400000,false);
        expect(changed.policy.accountingStartedAt).toBe(first.policy.accountingStartedAt);expect(changed.policy.periodMs).toBe(7*86400000);
        const read=await f.policies.read({...quotaModel,modelPin:'c'.repeat(64)},quotaUser);
        expect(read.policy!.accountingStartedAt).toBe(first.policy.accountingStartedAt);expect(read.counters.unknownCalls).toBe(0);
        // Own fixture only: expose the microsecond ordering hidden by pg's millisecond Date serialization.
        await f.pool.query("UPDATE model_user_token_quotas SET accounting_started_at='2030-01-01T00:00:00.123789Z'");
        await f.pool.query("UPDATE model_usage_calls SET started_at='2030-01-01T00:00:00.123456Z' WHERE id=$1",[old]);
        expect((await f.policies.read(quotaModel,quotaUser)).counters.unknownCalls).toBe(0);
        expect((await f.pool.query('SELECT quota_state,input_tokens,output_tokens FROM model_usage_calls WHERE id=$1',[old])).rows[0]).toEqual({quota_state:null,input_tokens:null,output_tokens:null});
    });
    it('settles known actual on the same UUID exactly once and frees only the unused estimate',async()=>{
        await f.policy(100);const id=await f.begin();await f.reserve(id);await f.usage.claimQuota(f.worker,id,true);
        await f.usage.finish(id,f.worker,terminal());await f.usage.finish(id,f.worker,terminal());
        const view=await f.policies.read(quotaModel,quotaUser);
        expect(view.counters).toMatchObject({chargedTokens:'30',activeReservedTokens:'0',unknownHeldTokens:'0',remainingTokens:'70'});
        expect((await f.pool.query('SELECT id,quota_state,quota_debit_tokens FROM model_usage_calls')).rows).toEqual([{id,quota_state:'settled',quota_debit_tokens:'30'}]);
    });
    it('does not use legacy terminal fallback while this pair has an unresolved reservation transaction',async()=>{
        await f.policy(100);const id=await f.begin(),admission=await f.pool.connect();
        try{
            await admission.query('BEGIN');await quotaPairLock(admission,quotaUser,quotaModel.id);
            await expect(f.usage.finish(id,f.worker,terminal({dispatchCount:0,inputTokens:null,outputTokens:null})))
                .rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_STORE_UNAVAILABLE'}});
            expect((await f.pool.query('SELECT status FROM model_usage_calls WHERE id=$1',[id])).rows[0].status).toBe('pending');
        }finally{await admission.query('ROLLBACK');admission.release();}
        await f.reserve(id);await f.usage.finish(id,f.worker,terminal({dispatchCount:0,inputTokens:null,outputTokens:null}));
        expect((await f.policies.read(quotaModel,quotaUser)).counters.activeReservedTokens).toBe('0');
    });
    it('retains the full last-call overrun and blocks the next new admission',async()=>{
        await f.policy(60);const id=await f.begin();await f.reserve(id);await f.usage.claimQuota(f.worker,id,true);
        await f.usage.finish(id,f.worker,terminal({inputTokens:40,outputTokens:40}));
        const view=await f.policies.read(quotaModel,quotaUser);expect(view.counters).toMatchObject({chargedTokens:'80',overrunTokens:'20',remainingTokens:'0'});
        await expect(f.reserve(await f.begin(),1)).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_EXCEEDED'}});
    });
    it('keeps partial/unknown usage and its hold distinct from actual zero, including after a period boundary',async()=>{
        const saved=await f.policy(100),id=await f.begin();await f.reserve(id);await f.usage.claimQuota(f.worker,id,true);
        await f.usage.finish(id,f.worker,terminal({inputTokens:30,outputTokens:null}));
        const view=await f.policies.read(quotaModel,quotaUser);expect(view.counters).toMatchObject({actualInputTokens:'30',actualOutputTokens:null,chargedTokens:'0',unknownHeldTokens:'50',unknownCalls:1,remainingTokens:'50'});
        const future=new Date(Date.now()+2*86400000).toISOString(),balance=await quotaCounters(f.pool,saved.policy,future);
        expect(balance.unknownHeldTokens).toBe('50');expect(balance.unknownCalls).toBe(1);
    });
    it('releases proven no-dispatch cancellation but retains post-dispatch cancellation and expired worker holds',async()=>{
        await f.policy(100);const before=await f.begin();await f.reserve(before);await f.usage.finish(before,f.worker,terminal({status:'cancelled',inputTokens:null,outputTokens:null,dispatchCount:0}));
        expect((await f.policies.read(quotaModel,quotaUser)).counters.remainingTokens).toBe('100');
        const after=await f.begin();await f.reserve(after);await f.usage.claimQuota(f.worker,after,true);await f.usage.finish(after,f.worker,terminal({status:'cancelled',inputTokens:null,outputTokens:null}));
        const expired=await f.begin();await f.reserve(expired,40);await f.usage.claimQuota(f.worker,expired,true);await f.pool.query("UPDATE model_usage_calls SET lease_until=clock_timestamp()-interval '1second' WHERE id=$1",[expired]);await f.usage.recover();
        expect((await f.policies.read(quotaModel,quotaUser)).counters).toMatchObject({activeReservedTokens:'0',unknownHeldTokens:'90',remainingTokens:'10'});
        await expect(f.reserve(await f.begin(),11)).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_EXCEEDED'}});
    });
    it('replays the exact writer-owned policy receipt and rejects key reuse with another body',async()=>{
        const saved=await f.policy(100),again=await f.policies.save(quotaWriter,quotaModel,quotaUser,saved.input);
        expect(again).toEqual(saved);expect(await f.policies.receipt(quotaWriter,quotaModel.id,quotaUser,saved.requestKey)).toEqual(saved);
        expect(await f.policies.accepted(quotaWriter,saved.requestKey)).toEqual(saved);expect(await f.policies.accepted('other@example.test',saved.requestKey)).toBeNull();
        await expect(f.policies.receipt(quotaWriter,'model-deleted',quotaUser,saved.requestKey)).rejects.toHaveProperty('status',404);
        await expect(f.policies.save(quotaWriter,quotaModel,quotaUser,{...saved.input,tokenLimit:101})).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT'}});
    });
    it('rechecks a tightened policy before dispatch and permits release only before provider action',async()=>{
        await f.policy(100);const id=await f.begin();await f.reserve(id,80);await f.policy(50,1);
        await expect(f.usage.claimQuota(f.worker,id,true)).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_EXCEEDED'}});
        await f.usage.releaseQuota(f.worker,id);expect((await f.policies.read(quotaModel,quotaUser)).counters).toMatchObject({remainingTokens:'50',activeReservedTokens:'0',overrunTokens:'0'});
    });
    it('accepts a late known outcome of the same interrupted worker receipt without rerunning inference',async()=>{
        await f.policy(100);const id=await f.begin();await f.reserve(id);await f.usage.claimQuota(f.worker,id,true);
        await f.pool.query("UPDATE model_usage_calls SET lease_until=clock_timestamp()-interval '1second' WHERE id=$1",[id]);await f.usage.recover();
        await f.usage.finish(id,f.worker,terminal({inputTokens:20,outputTokens:45}));
        expect((await f.policies.read(quotaModel,quotaUser)).counters).toMatchObject({chargedTokens:'65',unknownHeldTokens:'0',remainingTokens:'35'});
    });
    it.each(['read','save','reserve'] as const)('destroys a real %s transaction after lost ROLLBACK instead of committing it from the next request',async phase=>{
        await f.policy(100);const id=await f.begin();
        const fault=quotaFaultPool(f.databaseUrl,{rollbackLost:true,stage:phase!=='read',fail:sql=>phase==='read'?sql.startsWith('SELECT * FROM model_user_token_quotas')
            :phase==='save'?sql.startsWith('INSERT INTO model_user_token_quota_requests'):sql.startsWith('UPDATE model_usage_calls SET quota_state')});
        try{
            const policies=new ModelTokenQuotasRepository(fault.wrapped);
            const action=phase==='read'?policies.read(quotaModel,quotaUser):phase==='save'?policies.save(quotaWriter,quotaModel,quotaUser,
                {requestKey:randomUUID(),expectedRevision:1,enabled:true,tokenLimit:200,periodMs:86400000})
                :new ModelUsageRepository(fault.wrapped).reserveQuota(f.worker,{usageId:id,userEmail:quotaUser,model:quotaModel,estimate:{version:'server-text-v1',inputTokens:10,outputTokens:40,totalTokens:50,outputBasis:'planning-default',modelPin:quotaModel.modelPin!,requestDigest:'b'.repeat(64),supported:true}});
            await expect(action).rejects.toThrow();expect(fault.releases).toEqual([true]);
            await fault.pool.query('BEGIN');await fault.pool.query("INSERT INTO quota_tx_probe VALUES('ordinary')");await fault.pool.query('COMMIT');
            const pid=(await fault.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;expect(pid).not.toBe(fault.pids[0]);
            expect((await fault.pool.query('SELECT id FROM quota_tx_probe ORDER BY id')).rows).toEqual([{id:'ordinary'}]);
            expect((await f.policies.read(quotaModel,quotaUser)).policy!.tokenLimit).toBe(100);
            expect((await f.pool.query('SELECT quota_state FROM model_usage_calls WHERE id=$1',[id])).rows[0].quota_state).toBeNull();
            expect((await fault.pool.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off');
        }finally{await fault.close();}
    });
    it('keeps a positively rolled-back real client reusable, without staged configuration leaking',async()=>{
        await f.policy(100);const fault=quotaFaultPool(f.databaseUrl,{stage:true,fail:sql=>sql.startsWith('INSERT INTO model_user_token_quota_requests')});
        try{
            await expect(new ModelTokenQuotasRepository(fault.wrapped).save(quotaWriter,quotaModel,quotaUser,{requestKey:randomUUID(),expectedRevision:1,enabled:true,tokenLimit:200,periodMs:86400000})).rejects.toBe(fault.original);
            expect(fault.releases).toEqual([false]);expect((await fault.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(fault.pids[0]);
            expect((await fault.pool.query('SELECT id FROM quota_tx_probe')).rows).toEqual([]);expect((await f.policies.read(quotaModel,quotaUser)).policy!.tokenLimit).toBe(100);
        }finally{await fault.close();}
    });
    it('fences a real accepted BEGIN with an unknown ACK before any pooled request can commit staged work',async()=>{
        const fault=quotaFaultPool(f.databaseUrl,{beginLost:true,rollbackLost:true,stage:true}),work=vi.fn();
        try{
            await expect(quotaTransaction(fault.wrapped,work)).rejects.toBe(fault.original);expect(work).not.toHaveBeenCalled();expect(fault.releases).toEqual([true]);
            await fault.pool.query('BEGIN');await fault.pool.query('COMMIT');expect((await fault.pool.query('SELECT id FROM quota_tx_probe')).rows).toEqual([]);
        }finally{await fault.close();}
    });
    it('recovers one accepted policy receipt after a real COMMIT succeeds but its ACK and ROLLBACK are lost',async()=>{
        const fault=quotaFaultPool(f.databaseUrl,{commitLost:true,rollbackLost:true}),input={requestKey:randomUUID(),expectedRevision:0,enabled:true,tokenLimit:100,periodMs:86400000};
        try{
            await expect(new ModelTokenQuotasRepository(fault.wrapped).save(quotaWriter,quotaModel,quotaUser,input)).rejects.toBe(fault.original);expect(fault.releases).toEqual([true]);
            const saved=await f.policies.receipt(quotaWriter,quotaModel.id,quotaUser,input.requestKey);expect(saved.policy.revision).toBe(1);
            expect(await f.policies.save(quotaWriter,quotaModel,quotaUser,input)).toEqual(saved);
            expect((await f.pool.query('SELECT count(*)::int AS n FROM model_user_token_quota_requests')).rows[0].n).toBe(1);
        }finally{await fault.close();}
    });
    it('replays only a settlement journal after a real lost COMMIT ACK without a second debit or inference',async()=>{
        await f.policy(100);const id=await f.begin();await f.reserve(id);await f.usage.claimQuota(f.worker,id,true);
        const fault=quotaFaultPool(f.databaseUrl,{commitLost:true,rollbackLost:true}),value=terminal();
        try{
            await expect(new ModelUsageRepository(fault.wrapped).finish(id,f.worker,value)).rejects.toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_STORE_UNAVAILABLE'}});expect(fault.releases).toEqual([true]);
            await f.usage.finish(id,f.worker,value);expect((await f.policies.read(quotaModel,quotaUser)).counters).toMatchObject({chargedTokens:'30',activeReservedTokens:'0',unknownHeldTokens:'0'});
            expect((await f.pool.query('SELECT count(*)::int AS n FROM model_usage_calls')).rows[0].n).toBe(1);
        }finally{await fault.close();}
    });
    it('cancels a real row-locked reservation before provider action and leaves the next call healthy',async()=>{
        await f.policy(100);const usage=usageForOwnDatabase(f.databaseUrl),holder=await f.pool.connect(),cancel=new AbortController(),reason=new Error('cancelled held quota reservation');
        const flags=defaultFeatureFlags();flags.user_model_token_quotas=true;flags.model_rate_limits=false;vi.stubGlobal('fetch',vi.fn(async()=>Response.json(evaluateFeatureFlags(flags))));
        const provider=vi.fn(async()=>({prompt_eval_count:10,eval_count:20,usage_reported:true})),gate=new ModelApiAdmission({acquire:vi.fn()} as never,usage);
        try{
            await usage.onModuleInit();await usage.pool.query('SET lock_timeout=0;SET statement_timeout=0');
            await holder.query('BEGIN');await holder.query('SELECT email FROM platform_users WHERE email=$1 FOR UPDATE',[quotaUser]);
            const result=withModelUsage({purpose:'direct',actorEmail:quotaUser},()=>usage.observe(quotaModel,'chat',signal=>gate.run(quotaModel,signal,provider,()=>quotaEstimate()),cancel.signal));
            result.catch(()=>undefined);await waitOwnedLock(f.pool,'SELECT enabled FROM platform_users');const abortedAt=performance.now();cancel.abort(reason);
            await expect(result).rejects.toBe(reason);expect(performance.now()-abortedAt).toBeLessThan(1000);expect(provider).not.toHaveBeenCalled();
        }finally{await holder.query('ROLLBACK');holder.release();await usage.onApplicationShutdown();vi.unstubAllGlobals();}
        expect((await f.policies.read(quotaModel,quotaUser)).counters).toMatchObject({activeReservedTokens:'0',unknownHeldTokens:'0',remainingTokens:'100'});
        const next=await f.begin();await expect(f.reserve(next)).resolves.toBe(true);
    });
    it('bounds a real read waiting on DDL without caller signal or pool SQL deadlines',async()=>{
        await f.policy(100);const pool=new Pool({connectionString:f.databaseUrl,max:1,connectionTimeoutMillis:1000}),holder=await f.pool.connect();
        pool.on('connect',client=>client.on('error',()=>undefined));pool.on('error',()=>undefined);
        const repository=new ModelTokenQuotasRepository(pool);
        try{
            try{
                await holder.query('BEGIN');await holder.query('LOCK TABLE model_user_token_quotas IN ACCESS EXCLUSIVE MODE');
                const started=performance.now(),result=repository.read(quotaModel,quotaUser).catch(error=>error);await waitOwnedLock(f.pool,'SELECT * FROM model_user_token_quotas');
                expect(await result).toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_STORE_UNAVAILABLE'}});expect(performance.now()-started).toBeLessThan(5000);
            }finally{await holder.query('ROLLBACK');holder.release();}
            expect((await repository.read(quotaModel,quotaUser)).policy!.tokenLimit).toBe(100);
            expect((await pool.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off');
        }finally{await pool.end();}
    });
    it('captures physical schema facts and refuses to declare readiness before the exact contract is finalized',async()=>{
        const facts=(await f.pool.query<{kind:string;id:string;definition:Record<string,unknown>}>(CATALOG_SCHEMA_FACTS_SQL)).rows.filter(row=>row.id.startsWith('model_user_token_')||row.id.startsWith('model_usage_calls.quota_')
            ||row.id.startsWith('model_usage_calls.model_usage_calls_quota_')||row.id.includes('model_usage_quota_shape')||row.id.startsWith('model_usage_calls_quota_'));
        const directory=fileURLToPath(new URL('../../../.run/user-model-token-quotas-20261028/',import.meta.url));await mkdir(directory,{recursive:true});
        await writeFile(process.env.MODEL_TOKEN_QUOTA_SCHEMA_FACTS_FILE??directory+'quota-schema-facts.json',JSON.stringify(facts,null,2)+'\n',{mode:0o600});
        expect(facts.length).toBeGreaterThan(20);expect(MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT.length).toBeGreaterThan(0);await assertModelTokenQuotasSchema(f.pool);
        await quotaTransaction(f.pool,async db=>{
            await db.query('SAVEPOINT quota_schema_probe');
            await db.query('ALTER TABLE model_usage_calls DROP CONSTRAINT model_usage_calls_quota_reserved_tokens_check');
            await expect(assertModelTokenQuotasSchema(db)).rejects.toThrow('model_usage_calls_quota_reserved_tokens_check');
            await db.query('ROLLBACK TO SAVEPOINT quota_schema_probe');await assertModelTokenQuotasSchema(db);
        });
        await assertModelTokenQuotasSchema(f.pool);
    });
});
