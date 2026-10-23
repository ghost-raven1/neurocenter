import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceCodexService} from '../src/models/device-codex.service';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import {createModelDispatchMetrics,withModelDispatchMetrics} from '../src/model-usage/model-dispatch-metrics';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {DEVICE_CODEX_PROTOCOL} from '../../shared/device-codex-inference.cjs';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import type {IModel} from '../src/models/model.types';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
beforeEach(()=>{
    const flags={...defaultFeatureFlags(),codex_connector:true,device_codex_inference:true};
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags(flags)))));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

function fixture(outcome:'success'|'queued-cancel'|'dispatched-cancel'){
    const model:IModel={id:'model-codex',name:'Codex',description:'',runtime:'device-codex',capability:'chat',model:'codex',modelVersion:'codex',manifestSha256:null,verificationSha256:'b'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:''};
    const abort=new AbortController(),metrics=createModelDispatchMetrics();metrics.progress=vi.fn(async()=>undefined);
    let jobId='',callId='',cancelled=false;const publicPayloads:unknown[]=[],privateRequests:unknown[]=[];
    const response={model:model.model,done:true,done_reason:'stop',message:{role:'assistant',content:'Saved answer'},prompt_eval_count:4,eval_count:8,usage_reported:true};
    const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
        if(sql.startsWith('INSERT INTO bridge_jobs')){jobId=String(args[0]);publicPayloads.push(JSON.parse(String(args[6])));}
        if(sql.startsWith('INSERT INTO device_model_calls')){callId=String(args[0]);privateRequests.push(JSON.parse(String(args[10])));}
        if(sql.startsWith('UPDATE device_model_calls SET cancelled_at'))cancelled=true;
        if(sql.startsWith('SELECT c.*,j.state')){
            if(outcome!=='success'&&!cancelled)abort.abort(new Error('explicit cancellation'));
            return {rows:[{id:callId,job_id:jobId,model_id:model.id,device_id:'device',owner_email:'owner@example.test',actor_role:'Главный админ',project_id:null,
                model_pin:projectEmbeddingPin(model),connection_revision:1,deadline_at:new Date(Date.now()+60000),state:cancelled?'cancelled':'running',lease:'lease',
                dispatched_at:outcome==='queued-cancel'?null:new Date(Date.now()-10),cancelled_at:cancelled?new Date():null,
                result:outcome==='success'?{protocol:DEVICE_CODEX_PROTOCOL,callId,response}:null}]};
        }
        return {rows:[],rowCount:1};
    });
    const pool={query,connect:vi.fn(async()=>({query,release:vi.fn()}))};
    const admission=new ModelApiAdmission({acquire:vi.fn(async(_model,_signal,beforeAttempt)=>beforeAttempt())} as never);
    const service=new DeviceCodexService({pool,get:vi.fn(async()=>model)} as never,{} as never,{} as never,admission);
    const connections=(service as unknown as {connections:{read:()=>Promise<unknown>;assertCurrent:()=>Promise<unknown>}}).connections;
    vi.spyOn(connections,'read').mockResolvedValue({model_id:model.id,device_id:'device',revision:1,source:{scope:'global'},options:{store:false}});
    vi.spyOn(connections,'assertCurrent').mockResolvedValue({});
    const run=()=>withModelDispatchMetrics(metrics,()=>withModelUsage({purpose:'direct',actorEmail:'owner@example.test',actorRole:'Главный админ'},
        ()=>service.infer(model,'chat',{messages:[{role:'user',content:'PRIVATE prompt'}]},abort.signal)));
    return {run,metrics,query,publicPayloads,privateRequests,response};
}

describe('Device queue records durable one-send admission separately from provider usage',()=>{
    it('queued cancellation reserves one private call but records zero provider dispatches',async()=>{
        const f=fixture('queued-cancel');await expect(f.run()).rejects.toThrow('explicit cancellation');
        expect(f.publicPayloads).toHaveLength(1);expect(f.privateRequests).toHaveLength(1);expect(f.metrics.dispatchCount).toBe(0);expect(f.metrics.dispatchedAt).toBeNull();
        expect(JSON.stringify(f.publicPayloads)).not.toContain('PRIVATE prompt');expect(JSON.stringify(f.privateRequests)).toContain('PRIVATE prompt');
    });
    it('the completed durable receipt records exactly one call and returns actual provider usage',async()=>{
        const f=fixture('success');expect(await f.run()).toEqual(f.response);
        expect(f.metrics.dispatchCount).toBe(1);expect(f.metrics.dispatchedAt).not.toBeNull();expect(f.publicPayloads).toHaveLength(1);
        expect(f.metrics.progress).toHaveBeenCalledWith(true);expect(f.metrics.progress).toHaveBeenLastCalledWith(false);
    });
    it('cancellation after send retains one dispatch without creating another job',async()=>{
        const f=fixture('dispatched-cancel');await expect(f.run()).rejects.toThrow('explicit cancellation');
        expect(f.metrics.dispatchCount).toBe(1);expect(f.publicPayloads).toHaveLength(1);expect(f.privateRequests).toHaveLength(1);
    });
});
