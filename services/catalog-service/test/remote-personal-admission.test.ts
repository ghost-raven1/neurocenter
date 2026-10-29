import 'reflect-metadata';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {RemoteModelClient} from '../src/models/remote-model-client';
import {createModelDispatchMetrics,withModelDispatchMetrics} from '../src/model-usage/model-dispatch-metrics';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import type {IModel} from '../src/models/model.types';
const model={id:'model-personal-admission',runtime:'remote-openai',capability:'chat',model:'fixture',modelVersion:'1',modelPin:'a'.repeat(64)}as IModel;
const barrier=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};
let flags=defaultFeatureFlags();
beforeEach(()=>{flags=Object.fromEntries(Object.keys(defaultFeatureFlags()).map(key=>[key,true]))as typeof flags;vi.stubGlobal('fetch',vi.fn(async()=>Response.json(evaluateFeatureFlags(flags))));});
afterEach(()=>vi.unstubAllGlobals());
function fixture(){
    const events:string[]=[],rate=barrier(),atRate=barrier(),reserve=barrier(),atReserve=barrier();let key='latest-alice',valid=true;
    const lease={get apiKey(){return key;},assertCurrent:()=>{if(!valid)throw Error('lease expired');},release:vi.fn(async()=>{events.push('release');})};
    const acquire=vi.fn(async()=>{events.push('acquire');if(!valid)throw Error('personal key revoked');return lease;});
    const usage={reserveQuota:vi.fn(async()=>{events.push('reserve');atReserve.release();await reserve.promise;return true;}),claimQuota:vi.fn(async()=>{events.push('claim');}),releaseQuota:vi.fn(async()=>{events.push('unused-reserve-released');})};
    const gate=new ModelApiAdmission({acquire:vi.fn(async(_model,_signal,beforeAttempt)=>{atRate.release();await rate.promise;await beforeAttempt();events.push('rate-end');})}as never,usage as never);
    const provider=vi.fn(async(_url:unknown,init?:RequestInit)=>{events.push('fetch');expect((init?.headers as Record<string,string>).authorization).toBe('Bearer '+key);return Response.json({model:'fixture',choices:[{index:0,finish_reason:'stop',message:{content:'OK'}}],usage:{prompt_tokens:3,completion_tokens:2}});});
    const client=new RemoteModelClient({fetch:provider as typeof fetch,admission:gate}),metrics=createModelDispatchMetrics();metrics.usageId='00000000-0000-0000-0000-000000000001';metrics.workerId='owned-worker';
    const run=(signal?:AbortSignal)=>withModelDispatchMetrics(metrics,()=>withModelUsage({purpose:'chat',actorEmail:'alice@test',actorRole:'Разработчик',providerWire:{acquire}},()=>client.infer(model,{modelId:model.id,revision:1,baseUrl:'https://provider.test/v1',requestDimensions:false,apiKey:'OLD_SHARED'},'chat',{messages:[{role:'user',content:'hello'}]},signal)));
    return{events,rate,atRate,reserve,atReserve,usage,provider,metrics,acquire,lease,run,rotate:(value:string)=>{key=value;},revoke:()=>{valid=false;}};
}
describe('personal wire lease preserves the existing quota reservation lifecycle',()=>{
    it('holds no credential lock during rate/reserve waits, then captures the latest key before final claim and literal fetch',async()=>{
        const f=fixture(),pending=f.run();await f.atRate.promise;expect(f.acquire).not.toHaveBeenCalled();f.rate.release();await f.atReserve.promise;
        expect(f.acquire).not.toHaveBeenCalled();f.rotate('rotated-before-wire');f.reserve.release();await pending;
        expect(f.events).toEqual(['rate-end','reserve','acquire','claim','fetch','release']);expect(f.acquire).toHaveBeenCalledOnce();expect(f.usage.reserveQuota).toHaveBeenCalledOnce();expect(f.usage.claimQuota).toHaveBeenCalledOnce();expect(f.usage.releaseQuota).not.toHaveBeenCalled();expect(f.metrics.dispatchCount).toBe(1);
    });
    it('revoke while the quota reserve waits releases only the unused reserve and never enters the wire',async()=>{
        const f=fixture();f.rate.release();const pending=f.run().catch(error=>error);await f.atReserve.promise;f.revoke();f.reserve.release();
        expect((await pending).message).toContain('revoked');expect(f.provider).not.toHaveBeenCalled();expect(f.usage.claimQuota).not.toHaveBeenCalled();expect(f.usage.releaseQuota).toHaveBeenCalledOnce();expect(f.metrics.dispatchCount).toBe(0);
    });
    it('expiration during claim is checked synchronously before dispatch and releases the proven no-action claim',async()=>{
        const f=fixture();f.rate.release();f.reserve.release();f.usage.claimQuota.mockImplementation(async()=>{f.revoke();});
        await expect(f.run()).rejects.toThrow('lease expired');expect(f.provider).not.toHaveBeenCalled();expect(f.lease.release).toHaveBeenCalledOnce();expect(f.usage.releaseQuota).toHaveBeenCalledOnce();expect(f.metrics.dispatchCount).toBe(0);
    });
    it('cancellation during the final claim closes the lease and does not dispatch',async()=>{
        const f=fixture(),abort=new AbortController();f.rate.release();f.reserve.release();f.usage.claimQuota.mockImplementation(async()=>{abort.abort(Error('owned cancel'));});
        await expect(f.run(abort.signal)).rejects.toThrow('owned cancel');expect(f.provider).not.toHaveBeenCalled();expect(f.lease.release).toHaveBeenCalledOnce();expect(f.usage.releaseQuota).toHaveBeenCalledOnce();
    });
    it('a provider result and usage survive key/feature changes after the physical send without a second request',async()=>{
        const f=fixture();f.rate.release();f.reserve.release();f.provider.mockImplementation(async()=>{f.events.push('fetch');f.revoke();flags.model_hosting=false;return Response.json({model:'fixture',choices:[{index:0,finish_reason:'stop',message:{content:'received'}}],usage:{prompt_tokens:3,completion_tokens:2}});});
        const answer=await f.run();expect(answer.message).toEqual({role:'assistant',content:'received'});expect(f.provider).toHaveBeenCalledOnce();expect(f.usage.releaseQuota).not.toHaveBeenCalled();expect(f.lease.release).toHaveBeenCalledOnce();expect(f.metrics.dispatchCount).toBe(1);
    });
});
