import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {writeState} from '../src/bridge/state.js';
import {projectLearningContext,projectLearningRecord,projectLearningPropose,REPORTED_LEARNING_NOTE} from '../src/features/project-learning/tools.js';
const {createLearningContext}=createRequire(import.meta.url)('../../../services/shared/project-learning.cjs') as typeof import('../../../services/shared/project-learning.cjs');

describe('Project learning MCP boundaries',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>,bindingId:string,instanceId:string;
    const requestKey=randomUUID(),experienceId=randomUUID();
    const record=()=>({requestKey,expectedRevision:4,title:'Reported result',summary:'A developer reports a failed check.',outcome:'failed' as const,
        evidence:[{kind:'test' as const,status:'failed' as const,summary:'Failure reported by the caller.'}],context:{agentId:'agent-review',agentVersion:2}});
    const hypothesis=()=>({requestKey,expectedRevision:4,subject:'agent' as const,title:'Check ordering',statement:'Earlier checks may reduce rework.',rationale:'Reported failure',verificationPlan:'Compare independent results',experienceIds:[experienceId]});
    const success=(result:unknown)=>new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
    beforeEach(async()=>{
        fixture=await workspaceFixture();bindingId=await projectBindingId('test-project');instanceId=await projectInstanceId('test-project');
        await writeState('credentials',{deviceId:randomUUID(),email:'developer@example.test',token:'c'.repeat(64)});
    });
    afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();await fs.rm(fixture.temporary,{recursive:true,force:true});});
    it('reads the exact approved bundle through Gateway without disclosing device credentials',async()=>{
        const context=createLearningContext({projectId:'test-project',revision:4,entries:[]}),fetcher=vi.fn().mockResolvedValue(success(context));vi.stubGlobal('fetch',fetcher);
        expect(await projectLearningContext({},fixture.root)).toEqual(context);
        expect(fetcher).toHaveBeenCalledOnce();const [url,request]=fetcher.mock.calls[0]!;
        expect(url).toBe('http://localhost:5173/api/device-channel/learning/context');
        expect(JSON.parse(request.body)).toEqual({projectId:'test-project',bindingId,instanceId});
        expect(request.headers.authorization).toBe('Bearer '+'c'.repeat(64));expect(JSON.stringify(context)).not.toContain('c'.repeat(64));
    });
    it.each(['missing','legacy','copied','server'])('rejects %s project identity before network access',async kind=>{
        const file=path.join(fixture.root,'.opencode/neurocenter.json'),marker=JSON.parse(await fs.readFile(file,'utf8'));
        if(kind==='missing')await fs.rm(file);
        if(kind==='legacy')await fs.writeFile(file,JSON.stringify({version:1,server:marker.server,projectId:marker.projectId}));
        if(kind==='copied')await fs.writeFile(file,JSON.stringify({...marker,instanceId:randomUUID()}));
        if(kind==='server')await fs.writeFile(file,JSON.stringify({...marker,server:'https://other.invalid'}));
        const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
        await expect(projectLearningContext({},fixture.root)).rejects.toThrow('подтверждённой');expect(fetcher).not.toHaveBeenCalled();
    });
    it('reports experience with a stable idempotency key and no self-approval channel',async()=>{
        const result={schemaVersion:1,projectId:'test-project',revision:5,requestKey,result:{experience:{id:experienceId,projectId:'test-project',origin:'device'}}};
        const fetcher=vi.fn().mockImplementation(async()=>success(result));vi.stubGlobal('fetch',fetcher);
        expect(await projectLearningRecord(record(),fixture.root)).toEqual({...result,note:REPORTED_LEARNING_NOTE});
        const sent=JSON.parse(fetcher.mock.calls[0]![1].body);expect(sent).toEqual({projectId:'test-project',bindingId,instanceId,input:record()});
        await projectLearningRecord(record(),fixture.root);expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body);
        await expect(projectLearningRecord({...record(),approve:true} as never,fixture.root)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('creates an unapproved hypothesis proposal through its narrow route',async()=>{
        const item={id:randomUUID(),projectId:'test-project',status:'open',origin:'device'};
        const fetcher=vi.fn().mockResolvedValue(success({schemaVersion:1,projectId:'test-project',revision:5,requestKey,result:{hypotheses:[item],hypothesis:item}}));vi.stubGlobal('fetch',fetcher);
        const result=await projectLearningPropose(hypothesis(),fixture.root);expect(result.note).toBe(REPORTED_LEARNING_NOTE);
        expect(fetcher.mock.calls[0]![0]).toMatch(/\/learning\/propose$/);expect(JSON.parse(fetcher.mock.calls[0]![1].body).input).toEqual(hypothesis());
    });
    it.each(['project','digest'])('refuses a context with changed %s',async kind=>{
        const context=createLearningContext({projectId:kind==='project'?'another-project':'test-project',revision:4,entries:[]});
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(success(kind==='digest'?{...context,digest:'0'.repeat(64)}:context)));
        await expect(projectLearningContext({},fixture.root)).rejects.toThrow();
    });
    it('does not return a result after a binding changes while the request is in flight',async()=>{
        vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>{
            await fs.rm(path.join(fixture.root,'.opencode/neurocenter.json'));
            return success(createLearningContext({projectId:'test-project',revision:4,entries:[]}));
        }));
        await expect(projectLearningContext({},fixture.root)).rejects.toThrow('подтверждённой');
    });
    it.each([{...record(),expectedRevision:-1},{...record(),evidence:[]},{...record(),title:'x'.repeat(257)},
        {...record(),context:{agentId:'agent',permission:{bash:'allow'}}},{...record(),deviceId:'injected'},
        {...record(),evidence:[{kind:'test',status:'passed',summary:'x',verified:true}]}])('rejects malformed or authority-bearing input',async input=>{
        const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(projectLearningRecord(input as never,fixture.root)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
    });
    it('preserves the request key on a failed response and never silently retries a mutation',async()=>{
        const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'Revision changed'}),{status:409}));vi.stubGlobal('fetch',fetcher);
        await expect(projectLearningRecord(record(),fixture.root)).rejects.toMatchObject({status:409});expect(fetcher).toHaveBeenCalledOnce();
        expect(JSON.parse(fetcher.mock.calls[0]![1].body).input.requestKey).toBe(requestKey);
    });
});
