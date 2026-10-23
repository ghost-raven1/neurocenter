import {describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
const mocks=vi.hoisted(()=>({query:vi.fn(),reserve:vi.fn(async()=>vi.fn())}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query:mocks.query})}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:mocks.reserve}));
import {PackageBuildService} from '../src/package-build/package-build.service';

describe('Existing names are rejected before expensive new-build staging',()=>{
    it('A create intent gives an actionable conflict without spawning or enqueuing a builder',async()=>{
        mocks.query.mockResolvedValue({rows:[{id:'ai-plug-existing'}]});
        const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as unknown as AccessDb,{} as never,{} as never,{} as never);
        const enqueue=vi.fn(async()=>({id:'created',request_key:'11111111-1111-4111-8111-111111111111',config:{name:'Existing'},state:'QUEUED'})),stage=vi.fn(async()=>'/unused');
        Object.assign(service,{lease:{},repository:{existing:vi.fn(async()=>undefined),enqueue},stagingRoot:stage,startWorker:vi.fn()});
        await expect(service.create({email:'main@example.test',activeRole:'Главный админ'},{requestKey:'11111111-1111-4111-8111-111111111111',kind:'mcp',name:'Existing',description:'New source',source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default {}'}]}})).rejects.toThrow('Новая версия');
        expect(stage).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();expect(mocks.reserve).not.toHaveBeenCalled();
    });
    it('An already accepted UUID replays before duplicate-name checks and never starts another build',async()=>{
        mocks.query.mockClear();const accepted={id:'accepted',request_key:'11111111-1111-4111-8111-111111111111',config:{name:'Existing'},state:'SUCCEEDED'};
        const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as unknown as AccessDb,{} as never,{} as never,{} as never),enqueue=vi.fn();
        Object.assign(service,{repository:{existing:vi.fn(async()=>accepted),enqueue,evidence:vi.fn(async()=>({runtimeVerification:null,runtimeVerificationAttempt:null,agentSteps:[]}))}});
        expect(await service.create({email:'main@example.test',activeRole:'Главный админ'},{requestKey:accepted.request_key,kind:'mcp',name:'Existing',description:'New source',source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default {}'}]}})).toMatchObject({id:accepted.id,state:'SUCCEEDED'});
        expect(mocks.query).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
    });
});
