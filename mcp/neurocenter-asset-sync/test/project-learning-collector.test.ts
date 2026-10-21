import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {writeState} from '../src/bridge/state.js';
import {createLearningCollector} from '../src/features/project-learning/collector-plugin.js';
import {enqueueLearningObservation,flushLearningObservations,learningQueueRoot,LEARNING_QUEUE_LIMIT,type LearningQueueTarget} from '../src/features/project-learning/observation-queue.js';

describe('Bounded private OpenCode observations',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>,target:LearningQueueTarget,deviceId:string;
    const observation=()=>({requestKey:randomUUID(),title:'Observed tools',summary:'Only service counters',outcome:'unknown' as const,evidence:[{kind:'observation' as const,status:'unknown' as const,summary:'{"read":1}'}]});
    const directory=()=>path.join(learningQueueRoot(),target.bindingId);
    const files=async()=> (await fs.readdir(directory()).catch(()=>[])).filter(file=>file.endsWith('.json'));
    const queued=async()=>Promise.all((await files()).map(async file=>JSON.parse(await fs.readFile(path.join(directory(),file),'utf8'))));
    const collector=()=>createLearningCollector({directory:fixture.root},{...target,directory:fixture.root,server:'http://localhost:5173',queueDirectory:learningQueueRoot()});
    const idle={event:{type:'session.idle',properties:{sessionID:'session-fixture'}}};
    beforeEach(async()=>{
        fixture=await workspaceFixture();target={projectId:'test-project',bindingId:await projectBindingId('test-project'),instanceId:await projectInstanceId('test-project')};
        deviceId=randomUUID();await writeState('credentials',{deviceId,email:'developer@example.test',token:'a'.repeat(64)});
    });
    afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();await fs.rm(fixture.temporary,{recursive:true,force:true});});
    it('collects allowlisted counts and idle metadata without inspecting arguments or output',async()=>{
        const hooks=await collector();
        await hooks['tool.execute.after']({tool:'read',sessionID:'session-fixture',args:{secret:'PRIVATE API key'}} as never);
        await hooks['tool.execute.after']({tool:'bash',sessionID:'session-fixture',args:{command:'PRIVATE command'}} as never);
        await hooks['tool.execute.after']({tool:'private-tool-name',sessionID:'session-fixture'});
        await hooks.event({...idle,event:{...idle.event,properties:{...idle.event.properties,output:'PRIVATE output',prompt:'PRIVATE prompt'}}});
        const entries=await queued();expect(entries).toHaveLength(1);
        const input=entries[0].input;expect(input.outcome).toBe('unknown');expect(input.evidence[0].status).toBe('unknown');
        const facts=JSON.parse(input.evidence[0].summary);expect(facts).toMatchObject({observerVersion:1,sessionEvent:'idle',toolObservations:{read:1,bash:1},calls:2,truncated:false});
        expect(JSON.stringify(entries)).not.toMatch(/PRIVATE|private-tool-name|session-fixture|expectedRevision/);
        await hooks.event(idle);expect(await queued()).toHaveLength(1);
    });
    it('does not record idle without activity and records a session error only as unknown metadata',async()=>{
        const hooks=await collector();await hooks.event(idle);expect(await files()).toEqual([]);
        await hooks.event({event:{type:'session.error',properties:{sessionID:'session-fixture',error:'PRIVATE raw exception'}}});
        const input=(await queued())[0].input;expect(input.outcome).toBe('unknown');expect(JSON.parse(input.evidence[0].summary)).toMatchObject({sessionEvent:'error',calls:0});expect(JSON.stringify(input)).not.toContain('PRIVATE');
    });
    it('ignores unrelated/malformed hooks and stops collection after a marker changes',async()=>{
        const hooks=await collector();await hooks['tool.execute.after']({tool:'read',sessionID:'invalid\nsecret'});
        await hooks.event({event:{type:'message.updated',properties:{sessionID:'session-fixture'}}});expect(await files()).toEqual([]);
        await hooks['tool.execute.after']({tool:'read',sessionID:'session-fixture'});await fs.rm(path.join(fixture.root,'.opencode/neurocenter.json'));await hooks.event(idle);expect(await files()).toEqual([]);
    });
    it('caps per-session counters and never buffers unbounded session/tool keys',async()=>{
        const hooks=await collector();for(let i=0;i<10001;i++)await hooks['tool.execute.after']({tool:'read',sessionID:'session-fixture'});await hooks.event(idle);
        const facts=JSON.parse((await queued())[0].input.evidence[0].summary);expect(facts.calls).toBe(10000);expect(facts.truncated).toBe(true);
    });
    it('keeps stable immutable UUID payloads across a lost ACK, then removes only the acknowledged item',async()=>{
        const input=observation();await enqueueLearningObservation(target,input);const before=await fs.readFile(path.join(directory(),input.requestKey+'.json'),'utf8');
        const fetcher=vi.fn().mockRejectedValueOnce(Error('lost ACK')).mockResolvedValueOnce(new Response(JSON.stringify({schemaVersion:1,projectId:target.projectId,requestKey:input.requestKey,revision:9,
            result:{experience:{projectId:target.projectId,origin:'device',device:{deviceId,bindingId:target.bindingId,instanceId:target.instanceId}}}}),{status:200}));vi.stubGlobal('fetch',fetcher);
        await expect(flushLearningObservations(target)).rejects.toThrow('lost ACK');expect(await fs.readFile(path.join(directory(),input.requestKey+'.json'),'utf8')).toBe(before);
        expect(await flushLearningObservations(target)).toBe(1);expect(await files()).toEqual([]);expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body);
        const body=JSON.parse(fetcher.mock.calls[0]![1].body);expect(body.input.expectedRevision).toBeUndefined();expect(body.input.requestKey).toBe(input.requestKey);
    });
    it('replays an identical enqueue and refuses a second payload with the same UUID',async()=>{
        const input=observation();await enqueueLearningObservation(target,input);await enqueueLearningObservation(target,input);expect(await files()).toHaveLength(1);
        await expect(enqueueLearningObservation(target,{...input,summary:'Changed'})).rejects.toThrow();expect((await queued())[0].input.summary).toBe(input.summary);
    });
    it('serializes concurrent publishers without dropping observations',async()=>{
        await Promise.all(Array.from({length:8},()=>enqueueLearningObservation(target,observation())));expect(await files()).toHaveLength(8);
    });
    it('bounds queue capacity and preserves all existing observations when full',async()=>{
        const input=observation();await enqueueLearningObservation(target,input);const template=(await queued())[0];
        for(let i=1;i<LEARNING_QUEUE_LIMIT.entries;i++){const id=randomUUID();await fs.writeFile(path.join(directory(),id+'.json'),JSON.stringify({...template,input:{...template.input,requestKey:id}}),{mode:0o600});}
        await expect(enqueueLearningObservation(target,observation())).rejects.toThrow('заполнена');expect(await files()).toHaveLength(LEARNING_QUEUE_LIMIT.entries);
    });
    it('rejects a symlink queue before writing outside its private directory',async()=>{
        const outside=path.join(fixture.temporary,'outside');await fs.mkdir(outside);await fs.symlink(outside,learningQueueRoot());
        await expect(enqueueLearningObservation(target,observation())).rejects.toThrow();expect(await fs.readdir(outside)).toEqual([]);
    });
    it.each(['target','receipt','identity'])('leaves an observation queued on changed %s',async kind=>{
        const input=observation();await enqueueLearningObservation(target,input);
        if(kind==='target'){const file=path.join(directory(),input.requestKey+'.json'),value=JSON.parse(await fs.readFile(file,'utf8'));value.target.instanceId=randomUUID();await fs.writeFile(file,JSON.stringify(value));}
        if(kind==='identity')await fs.rm(path.join(fixture.root,'.opencode/neurocenter.json'));
        const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({schemaVersion:1,projectId:'other-project',requestKey:input.requestKey,revision:9,result:{projectId:'other-project',origin:'device'}}),{status:200}));vi.stubGlobal('fetch',fetcher);
        await expect(flushLearningObservations(target)).rejects.toThrow();expect(await files()).toHaveLength(1);if(kind!=='receipt')expect(fetcher).not.toHaveBeenCalled();
    });
    it('does not accept a client CAS or authority flags in append-only metadata',async()=>{
        await expect(enqueueLearningObservation(target,{...observation(),expectedRevision:0})).rejects.toThrow();await expect(enqueueLearningObservation(target,{...observation(),approve:true})).rejects.toThrow();expect(await files()).toEqual([]);
    });
    it.each(['deviceId','bindingId','instanceId'])('does not remove an item after an ACK for another %s',async key=>{
        const input=observation();await enqueueLearningObservation(target,input);const device={deviceId,bindingId:target.bindingId,instanceId:target.instanceId,[key]:'wrong'};
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({schemaVersion:1,projectId:target.projectId,requestKey:input.requestKey,revision:1,result:{experience:{projectId:target.projectId,origin:'device',device}}}),{status:200})));
        await expect(flushLearningObservations(target)).rejects.toThrow();expect(await files()).toHaveLength(1);
    });
    it('does not decode corrupt UTF8 into a different reported observation',async()=>{
        const input=observation();await enqueueLearningObservation(target,input);const file=path.join(directory(),input.requestKey+'.json'),raw=await fs.readFile(file);
        raw[raw.indexOf(Buffer.from(input.title))]=0xff;await fs.writeFile(file,raw);
        const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(flushLearningObservations(target)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();expect(await files()).toHaveLength(1);
    });
});
