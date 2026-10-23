import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as state from '../src/bridge/state.js';
import * as workspace from '../src/bridge/workspace.js';
import * as completions from '../src/bridge/completions.js';
import * as privateStore from '../src/features/local-configuration/private-store.js';
import {runWorker} from '../src/bridge/worker.js';
import {readRuntimeCachePolicy,runtimeCachePolicyKey,runtimeCacheReceiptKey} from '../src/features/runtime-artifacts/policy-store.js';
import {providerFixture} from './opencode-provider.fixture.js';
import {runtimeCacheJobPayload} from '../../../services/catalog-service/src/devices/runtime-cache-jobs.js';

const socket=vi.hoisted(()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}));
vi.mock('socket.io-client',()=>({io:vi.fn(()=>socket)}));
vi.mock('../src/bridge/state.js',async original=>({...await original<typeof import('../src/bridge/state.js')>(),api:vi.fn()}));

let local:Awaited<ReturnType<typeof providerFixture>>|undefined;
let worker:Promise<void>|undefined;
let signals:Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>;
afterEach(async()=>{
    try{
        await worker;
        const stop=process.listeners('SIGTERM').find(listener=>!signals?.get('SIGTERM')?.has(listener));
        if(stop){stop();await vi.waitFor(()=>expect(process.exit).toHaveBeenCalled());}
    }finally{
        for(const [signal,previous]of signals??[])for(const listener of process.listeners(signal))if(!previous.has(listener))process.off(signal,listener);
        await local?.cleanup();local=undefined;worker=undefined;
        vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
    }
});

/** Only the queue/socket ports fail; the worker, policy CAS, receipts and ACK cleanup are real. */
async function fixture(failFirstGenericSave:boolean,action:'set'|'inspect'='set'){
    signals=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
    vi.clearAllMocks();local=await providerFixture();
    const runtimeCachePolicy=action==='inspect'?{schemaVersion:1,action}:{schemaVersion:1,action,expectedRevision:0,limitBytes:3*1024**3};
    const request={deviceId:local.descriptor.deviceId,kind:'runtime-cache-policy',requestKey:randomUUID(),runtimeCachePolicy};
    const device={id:request.deviceId,email:'fixture@example.test',role:'Главный админ',report:{capabilities:['runtime-cache-policy-v1']}};
    const job={id:randomUUID(),lease:randomUUID(),kind:request.kind,payload:runtimeCacheJobPayload(device as never,request as never,'Главный админ')};
    socket.disconnect.mockReturnValue(socket);socket.connect.mockReturnValue(socket);
    vi.spyOn(process,'exit').mockImplementation((()=>undefined) as never);
    vi.spyOn(process.stderr,'write').mockReturnValue(true);
    vi.spyOn(workspace,'workspaceReport').mockResolvedValue(await workspace.workspaceReport());
    const network=vi.fn(async()=>{throw new Error('External network must not run.');});vi.stubGlobal('fetch',network);
    const writes=vi.spyOn(privateStore,'writePrivateConfiguration');
    const actualSave=completions.saveCompletion;let saveAttempts=0;
    vi.spyOn(completions,'saveCompletion').mockImplementation(async value=>{
        if(value.id===job.id&&++saveAttempts===1&&failFirstGenericSave)throw new Error('Controlled generic completion persistence failure.');
        return actualSave(value);
    });
    let claims=0,accepted=false,heartbeatFailures=0;
    const sent:completions.Completion[]=[];
    let atFailedHeartbeat:{pending:completions.Completion[];pointers:unknown}|undefined;
    vi.mocked(state.api).mockImplementation(async(route,input)=>{
        if(route==='jobs/claim'){claims++;return (claims===1?job:null) as never;}
        if(route===`jobs/${job.id}/complete`){
            const completion=structuredClone(input) as completions.Completion;sent.push(completion);
            if(accepted&&completion.state!=='succeeded')throw new Error('Terminal success cannot become a failure.');
            accepted=true;return {ok:true} as never;
        }
        if(route==='heartbeat'&&accepted&&heartbeatFailures===0){
            heartbeatFailures++;
            atFailedHeartbeat={pending:await completions.pendingCompletions(),pointers:await state.readState('runtime-cache-policy-pending')};
            throw new Error('Controlled heartbeat outage after accepted ACK.');
        }
        return {} as never;
    });
    worker=runWorker();await worker;
    return {job,writes,sent,network,read:()=>({claims,heartbeatFailures,saveAttempts,atFailedHeartbeat})};
}

describe('Policy worker never turns an acknowledged setting into a failed job',()=>{
    it('reads the original policy from the exact queue payload compiled by Catalog',async()=>{
        const f=await fixture(false,'inspect');
        expect(f.sent).toHaveLength(1);expect(f.sent[0]).toMatchObject({state:'succeeded',result:{revision:0,limitBytes:2*1024**3}});
        expect(await readRuntimeCachePolicy()).toBeUndefined();expect(f.writes.mock.calls.filter(([key])=>key===runtimeCachePolicyKey)).toHaveLength(0);
        expect(f.read().claims).toBe(2);expect(f.network).not.toHaveBeenCalled();
    });
    it.each([false,true])('heartbeat outage after ACK preserves success (generic persistence recovery: %s)',async failFirstGenericSave=>{
        const f=await fixture(failFirstGenericSave),observed=f.read();
        expect(observed.heartbeatFailures).toBe(1);
        // Prove this is the heartbeat after actual ACK cleanup, not a pre-execution failure.
        expect(observed.atFailedHeartbeat).toEqual({pending:[],pointers:[]});
        expect(f.sent).toHaveLength(1);expect(f.sent[0]).toMatchObject({id:f.job.id,lease:f.job.lease,state:'succeeded',result:{revision:1,limitBytes:3*1024**3}});
        expect(await completions.pendingCompletions()).toEqual([]);
        expect(await state.readState('runtime-cache-policy-pending')).toEqual([]);
        const policy=await readRuntimeCachePolicy();expect(policy).toMatchObject({revision:1,limitBytes:3*1024**3,lastChange:{jobId:f.job.id,lease:f.job.lease}});
        expect(await privateStore.readPrivateConfiguration(runtimeCacheReceiptKey(f.job.id))).toEqual(policy?.lastChange);
        expect(f.writes.mock.calls.filter(([key])=>key===runtimeCachePolicyKey)).toHaveLength(1);
        expect(observed.saveAttempts).toBe(failFirstGenericSave?2:1);
        expect(observed.claims).toBe(2);expect(f.network).not.toHaveBeenCalled();
    });
});
