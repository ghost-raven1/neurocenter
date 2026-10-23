import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {BuildRow} from '../src/package-build/package-build.model';
const mocks=vi.hoisted(()=>({features:vi.fn(),notify:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:mocks.features}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:mocks.notify}));
import {PackageBuildService} from '../src/package-build/package-build.service';
const actor={email:'cancel@example.test',activeRole:'Главный админ'};
const row=(state='QUEUED')=>({id:randomUUID(),actor:actor.email,request_key:randomUUID(),state,percent:0,config:{name:'Cancel fixture'}} as BuildRow);

describe('Durable packaging cancellation admission',()=>{
    let service:PackageBuildService,claims:ReturnType<typeof vi.fn>,repository:{cancel:ReturnType<typeof vi.fn>;cancelRequest:ReturnType<typeof vi.fn>;evidence:ReturnType<typeof vi.fn>};
    beforeEach(()=>{
        vi.clearAllMocks();claims=vi.fn(async()=>({userRoles:['Главный админ']}));
        service=new PackageBuildService({claims} as never,{} as never,{} as never,{} as never);
        repository={cancel:vi.fn(),cancelRequest:vi.fn(),evidence:vi.fn(async()=>({runtimeVerification:null,runtimeVerificationAttempt:null,agentSteps:[]}))};Object.assign(service,{repository});
        mocks.features.mockRejectedValue(new Error('Creation is OFF'));
    });
    it('Cancels a queued owned build while creation is OFF and without a local worker lease',async()=>{
        const cancelled=row('CANCELLED');repository.cancel.mockImplementation(async(_actor,_id,authorize)=>{await authorize();return cancelled;});
        const result=await (service as any).cancel(actor,cancelled.id);
        expect(result).toMatchObject({id:cancelled.id,state:'CANCELLED',requestKey:cancelled.request_key});
        expect(repository.cancel).toHaveBeenCalledWith(actor.email,cancelled.id,expect.any(Function));
        expect(claims).toHaveBeenCalledTimes(3);expect(mocks.features).not.toHaveBeenCalled();
    });
    it('Acknowledges a durable actor/request tombstone when a POST acknowledgment is unknown',async()=>{
        const key=randomUUID();repository.cancelRequest.mockImplementation(async(_actor,_key,authorize)=>{await authorize();return undefined;});
        expect(await (service as any).cancelRequest(actor,key)).toEqual({requestKey:key,state:'CANCELLED',build:null});
        expect(repository.cancelRequest).toHaveBeenCalledWith(actor.email,key,expect.any(Function));
        expect(mocks.features).not.toHaveBeenCalled();
    });
    it('Role revocation while waiting for the cancellation row lock prevents cancellation',async()=>{
        const queued=row();repository.cancel.mockImplementation(async(_actor,_id,authorize)=>{claims.mockResolvedValue({userRoles:[]});await authorize();return queued;});
        await expect((service as any).cancel(actor,queued.id)).rejects.toMatchObject({status:403});
    });
    it('Reports a publication that already crossed the fence instead of a false cancellation',async()=>{
        const publishing={...row('RUNNING'),publication_started_at:'2026-10-23T00:00:00.000Z'};repository.cancelRequest.mockResolvedValue(publishing);
        expect(await (service as any).cancelRequest(actor,publishing.request_key)).toMatchObject({state:'RUNNING',build:{id:publishing.id,publicationStartedAt:publishing.publication_started_at}});
    });
    it('Rejects malformed IDs before creating a tombstone',async()=>{
        await expect((service as any).cancelRequest(actor,'--invalid')).rejects.toMatchObject({status:400});
        expect(repository.cancelRequest).not.toHaveBeenCalled();
    });
});
