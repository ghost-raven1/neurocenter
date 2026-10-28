import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {modelTokenQuotaInput} from '../src/model-token-quotas/model-token-quotas.validation';
import {estimateModelTokens} from '../src/model-token-quotas/quota-estimate';
import {quotaRequestText} from '../src/model-token-quotas/model-token-quotas.model';
import {MODEL_TOKEN_QUOTA_MAX_PERIOD_MS} from '../src/model-token-quotas/model-token-quotas.types';
import type {IModel} from '../src/models/model.types';
import {quotaTransaction,MODEL_TOKEN_QUOTA_DB_DEADLINE_MS} from '../src/model-token-quotas/quota-database';

const input={requestKey:'12345678-1234-4234-8234-123456789abc',expectedRevision:0,enabled:true,tokenLimit:10000,periodMs:7*86400000};
const model={id:'model-quota',runtime:'remote-openai',capability:'chat',modelPin:'a'.repeat(64)} as IModel;

describe('Independent user token-budget input and estimate',()=>{
    it('accepts a week and the365day boundary independently from the request-rate24hour limit',()=>{
        expect(modelTokenQuotaInput(input)).toEqual(input);
        expect(modelTokenQuotaInput({...input,periodMs:MODEL_TOKEN_QUOTA_MAX_PERIOD_MS}).periodMs).toBe(365*86400000);
    });
    it.each([{periodMs:0},{periodMs:MODEL_TOKEN_QUOTA_MAX_PERIOD_MS+1},{tokenLimit:0},{tokenLimit:Number.MAX_SAFE_INTEGER+1},
        {expectedRevision:-1},{requestKey:'new-each-time'},{extra:true}])('rejects malformed budget intent %j',patch=>{
        expect(()=>modelTokenQuotaInput({...input,...patch})).toThrow();
    });
    it('uses a labelled output estimate without adding a wire cap to the chosen model',()=>{
        const body={messages:[{role:'user',content:'Проверь бюджет модели.'}],stream:false},before=structuredClone(body);
        const estimate=estimateModelTokens(model,'chat',body);
        expect(estimate).toMatchObject({supported:true,version:'server-text-v1',outputBasis:'planning-default',outputTokens:4096,modelPin:model.modelPin});
        expect(estimate.inputTokens).toBeGreaterThan(0);expect(estimate.totalTokens).toBe(estimate.inputTokens+4096);
        expect(estimate.requestDigest).toMatch(/^[a-f0-9]{64}$/);expect(body).toEqual(before);
    });
    it('records the final configured cap as an estimate basis without claiming actual usage',()=>{
        const estimate=estimateModelTokens(model,'chat',{messages:[{role:'user',content:'text'}],max_completion_tokens:80});
        expect(estimate.outputTokens).toBe(80);expect(estimate.outputBasis).toBe('configured-limit');
        expect(estimate).not.toHaveProperty('actualTokens');
    });
    it('binds the request digest to exact content and excludes unsupported channels from the declared first coverage',()=>{
        const a=estimateModelTokens(model,'chat',{messages:[{role:'user',content:'one'}]});
        const b=estimateModelTokens(model,'chat',{messages:[{role:'user',content:'two'}]});
        expect(a.totalTokens).toBe(b.totalTokens);expect(a.requestDigest).not.toBe(b.requestDigest);
        expect(estimateModelTokens({...model,runtime:'device-codex'},'chat',{}).supported).toBe(false);
    });
    it('canonical policy proof is bound to writer, target, model, revision and full immutable input',()=>{
        const text=quotaRequestText('admin@example.test','model-a','user@example.test',input);
        expect(text).toBe(JSON.stringify({writerEmail:'admin@example.test',modelId:'model-a',userEmail:'user@example.test',input}));
        for(const changed of [quotaRequestText('other@example.test','model-a','user@example.test',input),quotaRequestText('admin@example.test','model-b','user@example.test',input),
            quotaRequestText('admin@example.test','model-a','other@example.test',input),quotaRequestText('admin@example.test','model-a','user@example.test',{...input,tokenLimit:9999})])expect(changed).not.toBe(text);
    });
});

describe('Only a confirmed clean quota transaction client may return to the pool',()=>{
    function client(query:(sql:string)=>Promise<unknown>){
        const release=vi.fn(),db={query:vi.fn(query),release};
        return {db,release,pool:{connect:vi.fn(async()=>db)} as unknown as Pool};
    }
    it('destroys its own client after a lost rollback and preserves the original work failure',async()=>{
        const original=new Error('original work failed'),f=client(async sql=>{if(sql==='ROLLBACK')throw Error('rollback ACK lost');return{rows:[]};});
        await expect(quotaTransaction(f.pool,async()=>{throw original;})).rejects.toBe(original);
        expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('marks BEGIN attempted before awaiting its acknowledgement and destroys that uncertain client',async()=>{
        const original=new Error('BEGIN ACK lost'),f=client(async sql=>{if(sql==='BEGIN')throw original;return{rows:[]};}),work=vi.fn();
        await expect(quotaTransaction(f.pool,work)).rejects.toBe(original);expect(work).not.toHaveBeenCalled();
        expect(f.db.query).toHaveBeenCalledWith('ROLLBACK');expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('reuses a client only after a positively acknowledged rollback',async()=>{
        const original=new Error('work failed'),f=client(async()=>({rows:[]}));
        await expect(quotaTransaction(f.pool,async()=>{throw original;})).rejects.toBe(original);
        expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    });
    it('does not replay work after an unknown COMMIT and failed cleanup',async()=>{
        const original=new Error('COMMIT ACK lost'),f=client(async sql=>{if(sql==='COMMIT')throw original;if(sql==='ROLLBACK')throw Error('cleanup unknown');return{rows:[]};}),work=vi.fn(async()=> 'accepted');
        await expect(quotaTransaction(f.pool,work)).rejects.toBe(original);
        expect(work).toHaveBeenCalledOnce();expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('interrupts a held BEGIN immediately on caller abort and releases only that client once',async()=>{
        let entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve),never=new Promise<never>(()=>undefined);
        const f=client(async sql=>{if(sql==='BEGIN'){entered();return never;}return{rows:[]};}),work=vi.fn(),cancel=new AbortController(),reason=new Error('caller cancelled SQL wait');
        const result=quotaTransaction(f.pool,work,{signal:cancel.signal});await began;cancel.abort(reason);
        await expect(result).rejects.toBe(reason);expect(work).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
        expect(f.db.query).toHaveBeenCalledTimes(1);
    });
    it('bounds a read transaction without any caller signal or pool query timeout',async()=>{
        vi.useFakeTimers();
        try{
            let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),f=client(async()=>({rows:[]}));
            const outcome=quotaTransaction(f.pool,async()=>{entered();return new Promise<never>(()=>undefined);},{readOnly:true}).catch(error=>error);
            await started;await vi.advanceTimersByTimeAsync(MODEL_TOKEN_QUOTA_DB_DEADLINE_MS);
            expect(await outcome).toMatchObject({response:{code:'MODEL_TOKEN_QUOTA_STORE_UNAVAILABLE'}});
            expect(f.release).toHaveBeenCalledExactlyOnceWith(true);expect(vi.getTimerCount()).toBe(0);
        }finally{vi.useRealTimers();}
    });
    it('returns a client delivered after cancelled checkout unused, without entering a transaction',async()=>{
        let deliver!:(db:unknown)=>void;const checkout=new Promise<unknown>(resolve=>deliver=resolve),release=vi.fn(),query=vi.fn(),cancel=new AbortController(),reason=new Error('checkout cancelled');
        const pool={connect:()=>checkout} as unknown as Pool,result=quotaTransaction(pool,vi.fn(),{signal:cancel.signal});cancel.abort(reason);
        await expect(result).rejects.toBe(reason);deliver({release,query});await checkout;await Promise.resolve();
        expect(release).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledWith();expect(query).not.toHaveBeenCalled();
    });
});
