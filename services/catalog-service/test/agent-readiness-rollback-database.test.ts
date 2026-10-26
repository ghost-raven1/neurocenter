import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {AgentTrialRepository} from '../src/agent-readiness/agent-readiness.repository';
import type {StartAgentTrial} from '../src/agent-readiness/agent-readiness.types';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {ownedAccessTestAdminUrl} from './access-write-postgres.fixture';
import {createAgentReadinessFixture,TRIAL_PROJECT} from './agent-readiness-postgres.fixture';

const connection=process.env.AGENT_TRIAL_ROLLBACK_TEST_PG_URL;
const observations:unknown[]=[],cleanup:unknown[]=[];
afterAll(async()=>{
    if(process.env.AGENT_TRIAL_ROLLBACK_EVIDENCE_FILE)await writeFile(process.env.AGENT_TRIAL_ROLLBACK_EVIDENCE_FILE,
        JSON.stringify({observations,cleanup},null,2)+'\n');
});

/** Real admission and INSERT run unchanged; faults are armed by the business INSERT, never the initial expire COMMIT. */
function faultPool(pool:Pool,boundary:'insert'|'commit'|'none',rollbackLoss:'none'|'before'|'after'='none'){
    const error=new Error('Own agent trial '+boundary+' acknowledgement lost'),rollbackError=new Error('Own trial rollback acknowledgement lost');
    const sql:string[]=[];let pid=0,lastPid=0,released:Error|boolean|undefined,fired=false,inserted=false;
    const wrapped={query:pool.query.bind(pool),connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        const currentPid=Number((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);lastPid=currentPid;
        let business=false;
        return{query:async(text:string,...args:unknown[])=>{
            sql.push(text);
            if(text==='ROLLBACK'&&business&&rollbackLoss==='before')throw rollbackError;
            const result=await (query as (...values:unknown[])=>Promise<unknown>)(text,...args);
            if(text.startsWith('INSERT INTO agent_readiness_trials(')){business=true;inserted=true;pid=currentPid;}
            if(text==='ROLLBACK'&&business&&rollbackLoss==='after')throw rollbackError;
            if(!fired&&business&&(boundary==='insert'&&text.startsWith('INSERT INTO agent_readiness_trials(')||boundary==='commit'&&text==='COMMIT')){
                fired=true;throw error;
            }
            return result;
        },release:(discard?:Error|boolean)=>{if(business)released=discard;client.release(discard);}};
    }}as unknown as Pool;
    return{pool:wrapped,error,sql,pid:()=>pid,lastPid:()=>lastPid,released:()=>released,fired:()=>fired,inserted:()=>inserted};
}

describe.skipIf(connection===undefined).sequential('Agent trial transaction ownership through real start and expire',()=>{
    let f:Awaited<ReturnType<typeof createAgentReadinessFixture>>,original:AgentTrialRepository,agentId:string;
    let input:Omit<StartAgentTrial,'requestId'>;
    beforeAll(async()=>{
        const url=ownedAccessTestAdminUrl(connection!);
        vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())),{status:200})));
        f=await createAgentReadinessFixture(url.href);await f.service.onApplicationShutdown();f.models.pool.options.max=1;
        original=f.service.repository;
        const model=await f.addModel(),agent=await f.addAgent(),overview=await f.service.overview(f.request(),TRIAL_PROJECT);
        const item=overview.items.find(value=>value.agentId===agent.id)!;agentId=agent.id;
        input={expectedRevision:item.projectRevision,expectedAgentPin:item.currentPin,modelId:model.id,
            expectedModelPin:projectEmbeddingPin(model),tool:'none'};
    },30000);
    afterEach(async()=>{
        if(!f)return;
        Object.defineProperty(f.service,'repository',{value:original});await f.service.onApplicationShutdown();
        // Own fixture cleanup also closes a leaked baseline transaction if an assertion fails before expire.
        await f.models.pool.query('ROLLBACK');await f.db.query('DELETE FROM agent_readiness_trials');f.calls.length=0;
    });
    afterAll(async()=>{
        try{
            if(f){
                await f.close();const admin=new Pool({connectionString:ownedAccessTestAdminUrl(connection!).href,max:1});
                try{
                    const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[f.database])).rows;
                    const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[f.database])).rows;
                    cleanup.push({database:f.database,dropped:databases.length===0,databasesRemaining:databases,sessionsRemaining:sessions});
                    expect(databases).toEqual([]);expect(sessions).toEqual([]);
                }finally{await admin.end();}
            }
        }finally{vi.unstubAllGlobals();}
    });
    function install(fault:ReturnType<typeof faultPool>){
        const repository=new AgentTrialRepository(fault.pool);Object.defineProperty(f.service,'repository',{value:repository});return repository;
    }
    const state=async()=> (await f.db.query('SELECT id,request_id,status,revision,request_hash FROM agent_readiness_trials ORDER BY id')).rows;
    const start=(body:StartAgentTrial)=>f.service.start(f.request(),TRIAL_PROJECT,agentId,body);

    it('expire cannot commit a queued trial after failed start and an undelivered rollback',async()=>{
        const fault=faultPool(f.models.pool,'insert','before'),repository=install(fault),body={...input,requestId:randomUUID()};
        await expect(start(body)).rejects.toBe(fault.error);expect(fault.fired()).toBe(true);expect(fault.inserted()).toBe(true);
        const beforeExpire=await state();await repository.expire();const afterExpire=await state();
        observations.push({boundary:'insert',beforeExpire,afterExpire,pid:fault.pid(),nextPid:fault.lastPid(),released:fault.released(),providerCalls:f.calls.length});
        expect(beforeExpire).toEqual([]);expect(afterExpire).toEqual([]);expect(f.calls).toHaveLength(0);
        expect(fault.lastPid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);expect(fault.sql).toContain('ROLLBACK');
    });
    it('confirmed rollback keeps the healthy backend and no trial or inference survives failed start',async()=>{
        const fault=faultPool(f.models.pool,'insert'),repository=install(fault),body={...input,requestId:randomUUID()};
        await expect(start(body)).rejects.toBe(fault.error);await repository.expire();
        expect(await state()).toEqual([]);expect(f.calls).toHaveLength(0);expect(fault.lastPid()).toBe(fault.pid());
        expect(fault.released()).not.toBe(true);expect(fault.sql).toContain('ROLLBACK');
    });
    it('a lost rollback ACK preserves the original failure and discards the uncertain backend after actual rollback',async()=>{
        const fault=faultPool(f.models.pool,'insert','after'),repository=install(fault),body={...input,requestId:randomUUID()};
        await expect(start(body)).rejects.toBe(fault.error);expect(await state()).toEqual([]);await repository.expire();
        expect(await state()).toEqual([]);expect(f.calls).toHaveLength(0);expect(fault.lastPid()).not.toBe(fault.pid());
        expect(fault.released()).toBe(true);
    });
    it('lost COMMIT ACK keeps exactly one accepted trial and exact start replay never launches inference',async()=>{
        const fault=faultPool(f.models.pool,'commit','before'),repository=install(fault),body={...input,requestId:randomUUID()};
        await expect(start(body)).rejects.toBe(fault.error);expect(fault.fired()).toBe(true);
        const committed=await state();expect(committed).toHaveLength(1);expect(committed[0]).toMatchObject({request_id:body.requestId,status:'queued',revision:0});
        await repository.expire();const replay=await start(body);
        expect(replay).toMatchObject({id:committed[0].id,requestId:body.requestId,status:'queued',revision:0});
        expect(await state()).toEqual(committed);expect(f.calls).toHaveLength(0);
        expect(fault.lastPid()).not.toBe(fault.pid());expect(fault.released()).toBe(true);
        observations.push({boundary:'commit',committed,replay:{id:replay.id,status:replay.status},pid:fault.pid(),nextPid:fault.lastPid(),released:fault.released(),providerCalls:f.calls.length});
    });
    it('normal repository insertion commits once and expire reuses the acknowledged healthy backend',async()=>{
        const fault=faultPool(f.models.pool,'none'),repository=install(fault),body={...input,requestId:randomUUID()};
        // The callback and insert are production methods; no model execution is scheduled by this repository control.
        const row=await repository.transaction(db=>repository.insert(db,{id:randomUUID(),owner:'owner@localhost',project:TRIAL_PROJECT,agent:agentId,
            hash:'a'.repeat(64),input:body,snapshot:{definition:{description:'control',prompt:'control',mode:'all',permission:{}},
                agentPin:input.expectedAgentPin,nonce:randomUUID(),toolPin:null},receipt:{agentVersion:1,agentManifest:'b'.repeat(64),agentPin:input.expectedAgentPin,
                promptSha256:'c'.repeat(64),configSha256:'d'.repeat(64),modelId:input.modelId,modelName:'Control',modelPin:input.expectedModelPin,toolMode:'none',checks:[]},lease:randomUUID()}));
        await repository.expire();expect((await state()).map(value=>({id:value.id,status:value.status}))).toEqual([{id:row.id,status:'queued'}]);
        expect(fault.lastPid()).toBe(fault.pid());expect(fault.released()).not.toBe(true);expect(fault.sql).not.toContain('ROLLBACK');expect(f.calls).toHaveLength(0);
    });
});
