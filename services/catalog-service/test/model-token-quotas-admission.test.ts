import 'reflect-metadata';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {createModelDispatchMetrics,withModelDispatchMetrics,type ModelDispatchMetrics} from '../src/model-usage/model-dispatch-metrics';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import {RemoteModelClient} from '../src/models/remote-model-client';
import type {ModelTokenQuotaEstimate} from '../src/model-token-quotas/model-token-quotas.types';
import {estimateModelTokens} from '../src/model-token-quotas/quota-estimate';
import type {IModel} from '../src/models/model.types';

const model={id:'model-quota',runtime:'remote-openai',capability:'chat',model:'quota/model',modelVersion:'1',modelPin:'a'.repeat(64)} as IModel;
let flags=defaultFeatureFlags();
beforeEach(()=>{flags=Object.fromEntries(Object.keys(defaultFeatureFlags()).map(key=>[key,true])) as typeof flags;flags.model_rate_limits=false;
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json(evaluateFeatureFlags(flags))));});
afterEach(()=>vi.unstubAllGlobals());
function fixture(){
    const usage={reserveQuota:vi.fn(async(_model:IModel,_estimate:ModelTokenQuotaEstimate,_metrics:ModelDispatchMetrics|undefined,_signal?:AbortSignal)=>true),claimQuota:vi.fn(async(_metrics:ModelDispatchMetrics|undefined,_enforce:boolean,_signal?:AbortSignal)=>undefined),releaseQuota:vi.fn(async(_metrics:ModelDispatchMetrics|undefined)=>undefined)};
    const gate=new ModelApiAdmission({acquire:vi.fn()} as never,usage as never),metrics=createModelDispatchMetrics();
    metrics.usageId='12345678-1234-4234-8234-123456789abc';metrics.workerId='worker-one';
    const run=<T>(action:()=>Promise<T>,extra={})=>withModelDispatchMetrics(metrics,()=>withModelUsage({purpose:'direct',actorEmail:'user@example.test',...extra},()=>gate.run(model,undefined,action,()=>estimateModelTokens(model,'chat',{messages:[{role:'user',content:'task'}]}))));
    return {usage,gate,metrics,run};
}
describe('One usage reservation at the physical server send boundary',()=>{
    it('waits for the atomic reserve before action and never reserves again from repeated authority callbacks',async()=>{
        const f=fixture(),provider=vi.fn(async()=> 'answer'),beforeDispatch=vi.fn(async()=>undefined);
        let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
        f.usage.reserveQuota.mockImplementation(async()=>{entered();await held;return true;});
        const result=f.run(provider,{beforeDispatch});await started;expect(provider).not.toHaveBeenCalled();release();
        await expect(result).resolves.toBe('answer');expect(f.usage.reserveQuota).toHaveBeenCalledOnce();expect(f.usage.claimQuota).toHaveBeenCalledOnce();
        expect(beforeDispatch).toHaveBeenCalledTimes(2);expect(provider).toHaveBeenCalledOnce();expect(f.metrics.dispatchCount).toBe(1);
    });
    it('keeps an unknown reserve COMMIT from dispatching or inventing a new usage identity',async()=>{
        const f=fixture(),provider=vi.fn();f.usage.reserveQuota.mockRejectedValue(new Error('COMMIT ACK unknown'));
        await expect(f.run(provider)).rejects.toThrow('COMMIT ACK unknown');expect(provider).not.toHaveBeenCalled();
        expect(f.metrics.dispatchCount).toBe(0);expect(f.usage.reserveQuota.mock.calls[0][2]).toBe(f.metrics);expect(f.usage.claimQuota).not.toHaveBeenCalled();
    });
    it('fences revoked authority after SQL and releases only the proven no-action reservation',async()=>{
        const f=fixture(),provider=vi.fn();let current=true;
        f.usage.claimQuota.mockImplementation(async()=>{current=false;});
        await expect(f.run(provider,{beforeInference:async()=>{if(!current)throw new Error('revoked');}})).rejects.toThrow('revoked');
        expect(provider).not.toHaveBeenCalled();expect(f.usage.releaseQuota).toHaveBeenCalledOnce();expect(f.metrics.dispatchCount).toBe(0);
    });
    it('OFF permits existing server calls without a new quota lookup',async()=>{
        const f=fixture(),provider=vi.fn(async()=> 'answer');flags.user_model_token_quotas=false;
        await expect(f.run(provider)).resolves.toBe('answer');expect(f.usage.reserveQuota).not.toHaveBeenCalled();expect(provider).toHaveBeenCalledOnce();
    });
    it('does not recheck quota or authority after the provider has accepted work',async()=>{
        const f=fixture(),provider=vi.fn(async()=>{flags.user_model_token_quotas=false;return 'paid answer';});
        await expect(f.run(provider)).resolves.toBe('paid answer');expect(f.usage.reserveQuota).toHaveBeenCalledOnce();expect(f.usage.releaseQuota).not.toHaveBeenCalled();
    });
    it('an uncapped real remote transport supplies its estimate and sends exactly once without a new wire limit',async()=>{
        const f=fixture(),provider=vi.fn(async(_url:unknown,init:RequestInit)=>{
            expect(f.usage.claimQuota).toHaveBeenCalledOnce();const body=JSON.parse(String(init.body));
            expect(body).not.toHaveProperty('max_tokens');expect(body).not.toHaveProperty('max_completion_tokens');
            return Response.json({model:model.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'answer'}}],usage:{prompt_tokens:10,completion_tokens:20}});
        });
        const client=new RemoteModelClient({fetch:provider as typeof fetch,admission:f.gate});
        const result=await withModelDispatchMetrics(f.metrics,()=>withModelUsage({purpose:'direct',actorEmail:'user@example.test'},()=>client.infer(model,{modelId:model.id,revision:1,baseUrl:'https://provider.example.test/v1',requestDimensions:false},'chat',{messages:[{role:'user',content:'task'}]})));
        expect(result).toMatchObject({prompt_eval_count:10,eval_count:20});expect(provider).toHaveBeenCalledOnce();
        expect(f.usage.reserveQuota.mock.calls[0][1]).toMatchObject({outputTokens:4096,outputBasis:'planning-default'});
    });
    it.each([{apiKey:'invalid local key',baseUrl:'https://provider.example.test/v1'},{apiKey:'valid-key',baseUrl:'not-a-url'}])('rejects pure invalid connection settings before any reserve or fetch %j',async connection=>{
        const f=fixture(),provider=vi.fn(),client=new RemoteModelClient({fetch:provider as typeof fetch,admission:f.gate});
        await expect(withModelDispatchMetrics(f.metrics,()=>withModelUsage({purpose:'direct',actorEmail:'user@example.test'},()=>client.infer(model,
            {modelId:model.id,revision:1,requestDimensions:false,...connection},'chat',{messages:[{role:'user',content:'task'}]})))).rejects.toThrow();
        expect(f.usage.reserveQuota).not.toHaveBeenCalled();expect(f.usage.claimQuota).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();expect(f.metrics.dispatchCount).toBe(0);
    });
});
