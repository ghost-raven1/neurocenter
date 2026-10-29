import 'reflect-metadata';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {MODULE_METADATA} from '@nestjs/common/constants';
import {CatalogModule} from '../src/catalog/catalog.module';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {ensureCatalogSchema,checkCatalogSchema} from '../src/database/catalog-schema';
import {assertCurrentCatalogSchema} from '../src/database/current-schema-verification';
import {CATALOG_SCHEMA_FACTS_SQL} from '../src/database/schema-catalog';
import {ModelTokenQuotasController} from '../src/model-token-quotas/model-token-quotas.controller';
import {ModelTokenQuotasService} from '../src/model-token-quotas/model-token-quotas.service';
import {MODEL_TOKEN_QUOTAS_SCHEMA_ASSERT_SQL} from '../src/model-token-quotas/model-token-quotas.schema-verification';
import {MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT} from '../src/model-token-quotas/model-token-quotas.schema-contract';
import {quotaTransaction} from '../src/model-token-quotas/quota-database';
import {ModelUsageService} from '../src/model-usage/model-usage.service';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {currentModelUsage,withModelUsage} from '../src/model-usage/model-usage.context';
import {ModelInferenceController} from '../src/models/inference.controller';
import {quotaHttpAdminUrl,quotaHttpFixture,quotaHttpInput,quotaHttpMain,quotaHttpOther,quotaHttpUser,quotaHttpModelId,
    quotaHttpPath,quotaHttpRemovedModel,quotaHttpRemovedUser,quotaHttpUnsupported,type QuotaHttpFixture} from './model-token-quotas-http.fixture';

/** Real Catalog HTTP/SQL boundaries; this does not start Gateway/SSO or the entire CatalogModule/workers. */
describe.skipIf(!quotaHttpAdminUrl)('Quota HTTP integration with full current migrations and own provider',()=>{
    let f:QuotaHttpFixture;
    beforeAll(async()=>{f=await quotaHttpFixture();});beforeEach(async()=>f.reset());
    afterEach(()=>vi.restoreAllMocks());afterAll(async()=>f?.close());
    it('is mounted in the actual CatalogModule and upgrades0..45 history through46/DO/current readiness without rewriting it',async()=>{
        const controllers=Reflect.getMetadata(MODULE_METADATA.CONTROLLERS,CatalogModule) as unknown[],providers=Reflect.getMetadata(MODULE_METADATA.PROVIDERS,CatalogModule) as unknown[];
        expect(controllers).toEqual(expect.arrayContaining([ModelTokenQuotasController,ModelInferenceController]));
        expect(providers).toEqual(expect.arrayContaining([ModelTokenQuotasService,ModelUsageService,ModelApiAdmission]));
        expect(CATALOG_MIGRATIONS.at(-1)).toMatchObject({version:46,name:'per-user-model-token-quotas'});
        const history=await f.history();expect(history.filter(row=>row.version<=45)).toEqual(f.prefixHistory);expect(history.at(-1).version).toBe(46);
        expect(await f.legacyAfter()).toEqual(f.legacyBefore);
        expect((await f.pool.query('SELECT quota_state,quota_reserved_tokens,quota_debit_tokens FROM model_usage_calls WHERE id=$1',[f.legacyId])).rows[0])
            .toEqual({quota_state:null,quota_reserved_tokens:null,quota_debit_tokens:null});
        await ensureCatalogSchema(f.pool);expect(await f.history()).toEqual(history);expect((await checkCatalogSchema(f.pool,true)).ready).toBe(true);
        await f.pool.query(MODEL_TOKEN_QUOTAS_SCHEMA_ASSERT_SQL);
        await quotaTransaction(f.pool,async db=>{
            await db.query('SAVEPOINT quota_http_schema');await db.query('ALTER TABLE model_usage_calls DROP CONSTRAINT model_usage_calls_quota_reserved_tokens_check');
            await expect(assertCurrentCatalogSchema(db)).rejects.toThrow('model_usage_calls_quota_reserved_tokens_check');
            await db.query('ROLLBACK TO SAVEPOINT quota_http_schema');await assertCurrentCatalogSchema(db);
        });
        expect((await checkCatalogSchema(f.pool,true)).ready).toBe(true);
        const expected=new Set(MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT.map(row=>row.kind+':'+row.id));
        const actual=(await f.pool.query<{kind:string;id:string;definition:Record<string,unknown>}>(CATALOG_SCHEMA_FACTS_SQL)).rows.filter(row=>expected.has(row.kind+':'+row.id));
        expect(actual).toHaveLength(40);expect([...actual].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id)))
            .toEqual([...MODEL_TOKEN_QUOTAS_SCHEMA_CONTRACT].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id)));
        if(process.env.MODEL_TOKEN_QUOTA_SCHEMA_FACTS_FILE)await writeFile(process.env.MODEL_TOKEN_QUOTA_SCHEMA_FACTS_FILE,JSON.stringify(actual,null,2)+'\n',{mode:0o600});
        expect(f.service.repository.pool===f.usage.pool).toBe(true);
    });
    it('keeps real OFF configuration and exact replay, global writer-key/path conflict and CAS distinct at HTTP',async()=>{
        f.setEnforcement(false);f.setCatalog(false);const path=quotaHttpPath(),input=quotaHttpInput();
        expect(await f.request(quotaHttpMain,path)).toMatchObject({status:200,value:{policy:null,featureEnabled:false,userEmail:quotaHttpUser.email}});
        const saved=await f.request(quotaHttpMain,path,'PUT',input);expect(saved).toMatchObject({status:200,value:{input,policy:{revision:1,enabled:true}}});
        expect(await f.request(quotaHttpMain,path,'PUT',input)).toEqual(saved);
        expect(await f.request(quotaHttpMain,path+'/requests/'+input.requestKey)).toEqual(saved);
        expect((await f.request(quotaHttpOther,path+'/requests/'+input.requestKey)).status).toBe(404);
        for(const requested of [quotaHttpPath('model-nonexistent-http'),quotaHttpPath(quotaHttpModelId,'missing-http@example.test')]){
            expect(await f.request(quotaHttpMain,requested,'PUT',input)).toMatchObject({status:409,value:{code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT'}});
            expect((await f.request(quotaHttpMain,requested+'/requests/'+input.requestKey)).status).toBe(404);
        }
        expect(await f.request(quotaHttpMain,path,'PUT',quotaHttpInput(12000))).toMatchObject({status:409,value:{code:'MODEL_TOKEN_QUOTA_REVISION_CONFLICT'}});
        expect((await f.request(quotaHttpMain,path)).value.policy).toEqual(saved.value.policy);expect(f.providerCalls).toHaveLength(0);
        expect((await f.pool.query('SELECT count(*)::int AS n FROM model_user_token_quota_requests')).rows[0].n).toBe(1);
        const slashEmail='first/last@example.test',slashPath=quotaHttpPath(quotaHttpModelId,slashEmail),slashInput=quotaHttpInput();
        await f.pool.query('INSERT INTO platform_users(email) VALUES($1) ON CONFLICT DO NOTHING',[slashEmail]);
        const slashSaved=await f.request(quotaHttpMain,slashPath,'PUT',slashInput);
        expect(slashSaved).toMatchObject({status:200,value:{userEmail:slashEmail,input:slashInput,policy:{revision:1}}});
        expect(await f.request(quotaHttpMain,slashPath+'/requests/'+slashInput.requestKey)).toEqual(slashSaved);
        expect(await f.request(quotaHttpMain,slashPath,'PUT',slashInput)).toEqual(slashSaved);
        expect((await f.request(quotaHttpMain,slashPath)).value).toMatchObject({userEmail:slashEmail,featureEnabled:false});
        expect((await f.pool.query('SELECT count(*)::int AS n FROM model_user_token_quota_requests')).rows[0].n).toBe(2);expect(f.providerCalls).toHaveLength(0);
    });
    it('rechecks real current MainAdmin after an in-flight read and refuses forged or revoked HTTP identities',async()=>{
        const path=quotaHttpPath(),input=quotaHttpInput();expect((await f.request(quotaHttpMain,path,'PUT',input)).status).toBe(200);
        expect((await f.request(quotaHttpMain,path,'GET',undefined,false)).status).toBe(403);
        expect((await f.request(quotaHttpUser,path)).status).toBe(403);
        const read=f.service.repository.read.bind(f.service.repository);let entered!:()=>void,release!:()=>void;
        const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
        vi.spyOn(f.service.repository,'read').mockImplementationOnce(async(...args)=>{const result=await read(...args);entered();await held;return result;});
        const pending=f.request(quotaHttpMain,path);
        try{
            await started;await f.pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[quotaHttpMain.email]);release();
            const rejected=await pending;expect(rejected.status).toBe(403);expect(JSON.stringify(rejected.value)).not.toMatch(/tokenLimit|userEmail|accountingStartedAt/);
            expect((await f.request(quotaHttpMain,path,'PUT',input)).status).toBe(403);expect((await f.request(quotaHttpMain,path+'/requests/'+input.requestKey)).status).toBe(403);
            expect((await f.pool.query('SELECT revision FROM model_user_token_quotas')).rows).toEqual([{revision:'1'}]);
        }finally{release();await pending.catch(()=>undefined);}
    });
    it('recovers immutable accepted outcomes after both requested model and target account were deleted',async()=>{
        const path=quotaHttpPath(quotaHttpRemovedModel,quotaHttpRemovedUser),input=quotaHttpInput(),saved=await f.request(quotaHttpMain,path,'PUT',input);
        expect(saved.status).toBe(200);await f.pool.query('DELETE FROM model_catalog WHERE id=$1',[quotaHttpRemovedModel]);await f.pool.query('DELETE FROM platform_users WHERE email=$1',[quotaHttpRemovedUser]);
        expect((await f.request(quotaHttpMain,path)).status).toBe(404);
        expect(await f.request(quotaHttpMain,path+'/requests/'+input.requestKey)).toEqual(saved);expect(await f.request(quotaHttpMain,path,'PUT',input)).toEqual(saved);
        expect(await f.request(quotaHttpMain,path,'PUT',{...input,tokenLimit:input.tokenLimit+1})).toMatchObject({status:409,value:{code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT'}});
        expect(f.providerCalls).toHaveLength(0);
    });
    it('reserves before one real loopback provider request, records full last-call overrun and blocks the next physical send',async()=>{
        const path=quotaHttpPath(),input=quotaHttpInput(5000);expect((await f.request(quotaHttpMain,path,'PUT',input)).status).toBe(200);
        const inference='/api/models/'+quotaHttpModelId+'/ollama/api/chat',body={messages:[{role:'user',content:'owned HTTP task'}],stream:false};
        const answer=await f.request(quotaHttpUser,inference,'POST',body);expect(answer).toMatchObject({status:201,value:{done:true,prompt_eval_count:1000,eval_count:6000}});
        expect(f.providerCalls).toHaveLength(1);const sent=f.providerCalls[0];expect(sent.authorizationPresent).toBe(false);
        expect(sent.body).not.toHaveProperty('max_tokens');expect(sent.body).not.toHaveProperty('max_completion_tokens');
        expect(sent.receipts).toHaveLength(1);expect(sent.receipts[0]).toMatchObject({actor_email:quotaHttpUser.email,model_id:quotaHttpModelId,quota_state:'dispatched'});
        expect(BigInt(String(sent.receipts[0].quota_reserved_tokens))).toBeGreaterThan(4096n);expect(BigInt(String(sent.receipts[0].quota_reserved_tokens))).toBeLessThanOrEqual(5000n);
        expect((await f.request(quotaHttpMain,path)).value.counters).toMatchObject({chargedTokens:'7000',overrunTokens:'2000',activeReservedTokens:'0',unknownHeldTokens:'0',remainingTokens:'0'});
        expect(await f.request(quotaHttpUser,inference,'POST',body)).toMatchObject({status:429,value:{code:'MODEL_TOKEN_QUOTA_EXCEEDED'}});expect(f.providerCalls).toHaveLength(1);
        const rows=(await f.pool.query('SELECT id,status,dispatch_count,quota_state,quota_debit_tokens FROM model_usage_calls WHERE actor_email=$1 ORDER BY started_at',[quotaHttpUser.email])).rows;
        expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({id:sent.receipts[0].id,status:'success',dispatch_count:1,quota_state:'settled',quota_debit_tokens:'7000'});
        expect(rows[1]).toMatchObject({dispatch_count:0});
        expect(JSON.stringify((await f.pool.query('SELECT to_jsonb(receipt) AS row FROM model_usage_calls receipt WHERE actor_email=$1',[quotaHttpUser.email])).rows)).not.toMatch(/owned HTTP task|owned HTTP answer/);
    });
    it('rejects finite policy for an explicitly unsupported runtime without a configuration receipt or provider request',async()=>{
        const result=await f.request(quotaHttpMain,quotaHttpPath(quotaHttpUnsupported),'PUT',quotaHttpInput());
        expect(result).toMatchObject({status:409,value:{code:'MODEL_TOKEN_QUOTA_UNSUPPORTED_SURFACE'}});
        expect((await f.pool.query('SELECT count(*)::int AS n FROM model_user_token_quotas')).rows[0].n).toBe(0);
        expect((await f.pool.query('SELECT count(*)::int AS n FROM model_user_token_quota_requests')).rows[0].n).toBe(0);expect(f.providerCalls).toHaveLength(0);
    });
    it('blocks a new ON admission behind a durably dispatched OFF call until its actual usage settles',async()=>{
        const path=quotaHttpPath();expect((await f.request(quotaHttpMain,path,'PUT',quotaHttpInput(5000))).status).toBe(200);
        const inference='/api/models/'+quotaHttpModelId+'/ollama/api/chat',body={messages:[{role:'user',content:'owned OFF to ON task'}],stream:false},held=f.holdNextProvider();
        let durable!:()=>void,failed!:(error:unknown)=>void;const recorded=new Promise<void>((resolve,reject)=>{durable=resolve;failed=reject;});recorded.catch(()=>undefined);
        const write=f.usage.repository.dispatchProgress.bind(f.usage.repository);
        vi.spyOn(f.usage.repository,'dispatchProgress').mockImplementation(async(...args)=>{
            try{await write(...args);if(args[2]>0&&args[4]===null)durable();}catch(error){failed(error);throw error;}
        });
        f.setEnforcement(false);const first=f.request(quotaHttpUser,inference,'POST',body);first.catch(()=>undefined);
        let second:ReturnType<typeof f.request>|undefined,firstResult:Awaited<ReturnType<typeof f.request>>|undefined,firstFailure:unknown;
        try{
            await Promise.all([held.entered,recorded]);
            expect((await f.pool.query('SELECT status,dispatch_count,quota_state FROM model_usage_calls WHERE actor_email=$1',[quotaHttpUser.email])).rows)
                .toEqual([{status:'pending',dispatch_count:1,quota_state:null}]);
            f.setEnforcement(true);second=f.request(quotaHttpUser,inference,'POST',body);
            expect(await second).toMatchObject({status:409,value:{code:'MODEL_TOKEN_QUOTA_UNCERTAIN'}});expect(f.providerCalls).toHaveLength(1);
        }finally{
            held.release();const settled=await Promise.allSettled(second?[first,second]:[first]);
            if(settled[0].status==='fulfilled')firstResult=settled[0].value;else firstFailure=settled[0].reason;
        }
        if(firstFailure)throw firstFailure;
        expect(firstResult).toMatchObject({status:201,value:{prompt_eval_count:1000,eval_count:6000}});
        expect((await f.request(quotaHttpMain,path)).value.counters).toMatchObject({chargedTokens:'7000',unknownCalls:0,remainingTokens:'0',overrunTokens:'2000'});
        expect(await f.request(quotaHttpUser,inference,'POST',body)).toMatchObject({status:429,value:{code:'MODEL_TOKEN_QUOTA_EXCEEDED'}});expect(f.providerCalls).toHaveLength(1);
    });
    it('rechecks a policy enabled after the second dispatch callback before any physical provider send',async()=>{
        const path=quotaHttpPath(),disabled={...quotaHttpInput(10000),enabled:false};
        expect((await f.request(quotaHttpMain,path,'PUT',disabled)).status).toBe(200);
        let entered!:()=>void,release!:()=>void,checks=0;const atSecond=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
        const original=f.admission.run.bind(f.admission);
        vi.spyOn(f.admission,'run').mockImplementation((...args)=>{
            const context=currentModelUsage();
            return withModelUsage({...context,beforeDispatch:async()=>{await context.beforeDispatch?.();if(++checks===2){entered();await held;}}},()=>original(...args));
        });
        const pending=f.request(quotaHttpUser,'/api/models/'+quotaHttpModelId+'/ollama/api/chat','POST',{messages:[{role:'user',content:'held policy enable task'}],stream:false});pending.catch(()=>undefined);
        let result:Awaited<ReturnType<typeof f.request>>|undefined;
        try{
            await atSecond;expect(f.providerCalls).toHaveLength(0);
            expect((await f.request(quotaHttpMain,path,'PUT',quotaHttpInput(1,1))).status).toBe(200);
        }finally{release();result=await pending;}
        expect(checks).toBe(2);expect(result).toMatchObject({status:503,value:{code:'MODEL_TOKEN_QUOTA_STORE_UNAVAILABLE'}});
        expect(f.providerCalls).toHaveLength(0);
        expect((await f.pool.query('SELECT status,dispatch_count,quota_state FROM model_usage_calls WHERE actor_email=$1',[quotaHttpUser.email])).rows)
            .toEqual([{status:'error',dispatch_count:0,quota_state:null}]);
    });
    it('blocks ON admission behind an in-flight OFF call even when optional dispatch progress never persists',async()=>{
        const path=quotaHttpPath();expect((await f.request(quotaHttpMain,path,'PUT',quotaHttpInput(5000))).status).toBe(200);
        const inference='/api/models/'+quotaHttpModelId+'/ollama/api/chat',body={messages:[{role:'user',content:'lost optional dispatch metadata'}],stream:false};
        const provider=f.holdNextProvider();let entered!:()=>void,release!:()=>void,heldOnce=false;
        const atProgress=new Promise<void>(resolve=>entered=resolve),heldProgress=new Promise<void>(resolve=>release=resolve);
        const progress=vi.spyOn(f.usage.repository,'dispatchProgress').mockImplementation(async(...args)=>{if(args[2]>0&&args[4]===null&&!heldOnce){heldOnce=true;entered();await heldProgress;}});
        f.setEnforcement(false);const first=f.request(quotaHttpUser,inference,'POST',body);first.catch(()=>undefined);
        let second:ReturnType<typeof f.request>|undefined,firstResult:Awaited<ReturnType<typeof f.request>>|undefined;
        try{
            await Promise.all([provider.entered,atProgress]);expect(progress).toHaveBeenCalledOnce();
            const row=(await f.pool.query('SELECT status,dispatch_count,quota_state FROM model_usage_calls WHERE actor_email=$1',[quotaHttpUser.email])).rows[0];
            expect(row.status).toBe('pending');expect(row.quota_state).toBeNull();expect(row.dispatch_count).not.toBe(0);
            expect((await f.request(quotaHttpMain,path,'PUT',{...quotaHttpInput(5000,1),periodMs:1})).status).toBe(200);
            expect((await f.pool.query("SELECT clock_timestamp()>started_at+interval '1 millisecond' AS expired FROM model_usage_calls WHERE actor_email=$1 AND status='pending'",[quotaHttpUser.email])).rows[0].expired).toBe(true);
            f.setEnforcement(true);second=f.request(quotaHttpUser,inference,'POST',body);
            expect(await second).toMatchObject({status:409,value:{code:'MODEL_TOKEN_QUOTA_UNCERTAIN'}});expect(f.providerCalls).toHaveLength(1);
        }finally{
            release();provider.release();const outcomes=await Promise.allSettled(second?[first,second]:[first]);
            if(outcomes[0].status==='fulfilled')firstResult=outcomes[0].value;else throw outcomes[0].reason;
        }
        expect(firstResult).toMatchObject({status:201,value:{prompt_eval_count:1000,eval_count:6000}});
        expect((await f.request(quotaHttpMain,path,'PUT',quotaHttpInput(5000,2))).status).toBe(200);
        expect((await f.request(quotaHttpMain,path)).value.counters).toMatchObject({chargedTokens:'7000',unknownCalls:0,remainingTokens:'0',overrunTokens:'2000'});
    });
    it('does not read quota policy for an OFF send while its policy table is exclusively held',async()=>{
        f.setEnforcement(false);const lock=await f.pool.connect();
        try{
            await lock.query('BEGIN');await lock.query('LOCK TABLE model_user_token_quotas IN ACCESS EXCLUSIVE MODE');
            expect(await f.request(quotaHttpUser,'/api/models/'+quotaHttpModelId+'/ollama/api/chat','POST',{messages:[{role:'user',content:'OFF without policy lookup'}],stream:false}))
                .toMatchObject({status:201,value:{done:true}});expect(f.providerCalls).toHaveLength(1);
        }finally{await lock.query('ROLLBACK');lock.release();}
    });

});
