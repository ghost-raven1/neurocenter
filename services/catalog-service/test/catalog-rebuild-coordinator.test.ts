import {afterEach,describe,expect,it,vi} from 'vitest';
import {ConflictException,ForbiddenException,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CatalogRebuildCoordinator,type CatalogRebuildDependencies,type RebuildPlan} from '../src/package-build/catalog-rebuild-coordinator';
import {readCatalogRebuildState} from '../src/package-build/catalog-rebuild-state';
import {makeCatalogRebuildRequest,catalogRebuildRequestKey,parseCatalogRebuildRequest} from '../../shared/catalog-rebuild-request.cjs';

const folders:string[]=[],coordinators:CatalogRebuildCoordinator[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const coordinator of coordinators.splice(0))await coordinator.stop();for(const folder of folders.splice(0))await fs.rm(folder,{recursive:true,force:true});});
async function fixture(){
    const folder=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc rebuild contract ')));folders.push(folder);const file=path.join(folder,'current.json'),revision='a'.repeat(64);
    let request=makeCatalogRebuildRequest(revision),plans:RebuildPlan[]=[{id:'plugin-opencode-rag-plugin',kind:'plugin',name:'OpenCodeRAG',description:'2.12.2',revision,delivery:'prepared',imported:{id:'existing-rag',version:2}}];
    await fs.writeFile(file,JSON.stringify(request),{mode:0o600});
    const jobs=new Map<string,{id:string;state:string}>(),creates:string[]=[];let lookupFailure:Error|undefined,lostAck=false,main=true;
    const dependencies:CatalogRebuildDependencies={file,actor:()=>({email:'admin@fixture.test',activeRole:'Главный админ'}),authorize:async()=>{if(!main)throw new ForbiddenException();},
        bundle:async()=>({revision,commit:'sha256:'+'b'.repeat(64),inlineIds:[]}),plans:async()=>plans,refresh:vi.fn(async()=>undefined),
        target:vi.fn(async()=>({name:'OpenCodeRAG',publication:{catalogId:'existing-rag',expectedVersion:2,expectedSourceHash:'c'.repeat(64)}})),
        build:{request:vi.fn(async(_actor,key)=>{if(lookupFailure)throw lookupFailure;const job=jobs.get(key);if(!job)throw new NotFoundException();return job;}),
            create:vi.fn(async(_actor,input)=>{const key=(input as {requestKey:string}).requestKey;creates.push(key);const row={id:'build-'+creates.length,state:'QUEUED'};jobs.set(key,row);if(lostAck){lostAck=false;throw Error('ACK lost after admission');}return row;})},
        inline:{request:vi.fn(async()=>{throw new NotFoundException();}),create:vi.fn(async()=>({id:'inline-job',state:'SUCCEEDED'}))}};
    const coordinator=()=>{const value=new CatalogRebuildCoordinator(dependencies);coordinators.push(value);return value;};
    return {file,revision,dependencies,jobs,creates,coordinator,request:()=>request,plans:(next:RebuildPlan[])=>{plans=next;},plan:()=>plans[0],
        loseAck:()=>{lostAck=true;},lookup:(error:Error|undefined)=>{lookupFailure=error;},main:(value:boolean)=>{main=value;},
        replace:async(override?:Partial<typeof request>)=>{request=override?{...request,...override}:makeCatalogRebuildRequest(revision);await fs.writeFile(file,JSON.stringify(request));return request;}};
}

describe('Local rebuild admission and durable queue handoff',()=>{
    it('exposes a newly created request before the first queue receipt so readers keep polling',async()=>{
        const f=await fixture(),state=await readCatalogRebuildState(f.file);
        expect(state).toMatchObject({requestId:f.request().requestId,state:'preparing',items:[]});expect(f.creates).toHaveLength(0);
    });
    it('shows a new request awaiting checks instead of an earlier request successful status',async()=>{
        const f=await fixture();f.plans([{...f.plan(),catalogReady:true}]);await f.coordinator().tick();expect((await readCatalogRebuildState(f.file))?.state).toBe('ready');
        const next=await f.replace(),state=await readCatalogRebuildState(f.file);
        expect(state).toMatchObject({requestId:next.requestId,state:'preparing',items:[]});expect(f.creates).toHaveLength(0);
    });
    it('recovers a lost accepted create ACK and a new coordinator without creating another build',async()=>{
        const f=await fixture();f.loseAck();const first=f.coordinator();await first.tick();expect(f.creates).toHaveLength(1);expect((await readCatalogRebuildState(f.file))?.state).toBe('attention');
        await first.tick();await f.coordinator().tick();expect(f.creates).toHaveLength(1);
        expect(f.creates[0]).toBe(catalogRebuildRequestKey(f.request().requestId,'plugin-opencode-rag-plugin'));
        expect((await readCatalogRebuildState(f.file))?.items[0]).toMatchObject({state:'pending',operationId:'build-1',catalogId:'existing-rag'});
    });
    it.each([new ForbiddenException(),new ServiceUnavailableException()])('does not turn an unknown or denied receipt into a fresh POST: %s',async error=>{
        const f=await fixture();f.lookup(error);const coordinator=f.coordinator();await coordinator.tick();expect(f.creates).toEqual([]);
        f.lookup(undefined);await coordinator.tick();expect(f.creates).toHaveLength(1);
    });
    it('keeps accepted history readable with new-create flags disabled',async()=>{
        const f=await fixture(),key=catalogRebuildRequestKey(f.request().requestId,f.plan().id);f.jobs.set(key,{id:'accepted-before-off',state:'QUEUED'});
        f.dependencies.build.create=vi.fn(async()=>{throw new ForbiddenException();});await f.coordinator().tick();
        expect(f.dependencies.build.create).not.toHaveBeenCalled();expect((await readCatalogRebuildState(f.file))?.items[0].operationId).toBe('accepted-before-off');
    });
    it('fails closed for revoked ownership and a stale source revision',async()=>{
        const f=await fixture();f.main(false);const coordinator=f.coordinator();await coordinator.tick();expect(f.creates).toHaveLength(0);
        f.main(true);f.dependencies.bundle=async()=>({revision:'d'.repeat(64),commit:'sha256:'+'b'.repeat(64),inlineIds:[]});await coordinator.tick();expect(f.creates).toHaveLength(0);
        expect((await readCatalogRebuildState(f.file))?.state).toBe('attention');
    });
    it('preserves a manually changed managed head without accepting a build',async()=>{
        const f=await fixture();f.dependencies.target=vi.fn(async()=>{throw new ConflictException('Manual head');});await f.coordinator().tick();
        expect(f.creates).toHaveLength(0);expect((await readCatalogRebuildState(f.file))?.items[0].state).toBe('attention');
    });
    it.each(['request','revision','time'])('rechecks the selected rebuild %s after an asynchronous publication target read',async change=>{
        const f=await fixture();let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
        const target=f.dependencies.target;f.dependencies.target=async plan=>{entered();await held;return target(plan);};const active=f.coordinator().tick();await started;
        await f.replace(change==='revision'?{sourceRevision:'e'.repeat(64)}:change==='time'?{requestedAt:new Date(Date.parse(f.request().requestedAt)+1).toISOString()}:undefined);release();await active;
        expect(f.creates).toHaveLength(0);expect(await readCatalogRebuildState(f.file)).toMatchObject({requestId:f.request().requestId,state:'preparing',items:[]});
    });
    it('skips ready cards and model weights, and leaves archive-only tools explicitly deferred',async()=>{
        const f=await fixture(),plan=f.plan();f.plans([{...plan,catalogReady:true},{...plan,id:'model-weight',kind:'model',delivery:'model-archive'},
            {...plan,id:'plugin-needs-archive',delivery:'archive-required'}]);await f.coordinator().tick();
        expect(f.creates).toHaveLength(0);expect(f.dependencies.build.request).not.toHaveBeenCalled();const state=await readCatalogRebuildState(f.file);
        expect(state?.state).toBe('attention');expect(state?.items.map(row=>row.state)).toEqual(['ready','archive-required']);
    });
    it('imports inline IDs in admitted-size batches using stable keys and the exact current metadata commit',async()=>{
        const f=await fixture(),ids=Array.from({length:51},(_,i)=>'skill-'+i);f.plans([]);f.dependencies.bundle=async()=>({revision:f.revision,commit:'sha256:'+'b'.repeat(64),inlineIds:ids});
        await f.coordinator().tick();expect(f.dependencies.inline.create).toHaveBeenCalledTimes(2);
        expect(vi.mocked(f.dependencies.inline.create).mock.calls.map(call=>call[1].ids.length)).toEqual([50,1]);
        expect(vi.mocked(f.dependencies.inline.create).mock.calls[0][1]).toMatchObject({commit:'sha256:'+'b'.repeat(64),requestKey:catalogRebuildRequestKey(f.request().requestId,'inline:0')});
        expect(f.dependencies.build.create).not.toHaveBeenCalled();
    });
    it('does not repeat a failed accepted build until the operator makes a new explicit rebuild',async()=>{
        const f=await fixture(),coordinator=f.coordinator(),key=catalogRebuildRequestKey(f.request().requestId,f.plan().id);f.jobs.set(key,{id:'failed-original',state:'FAILED'});
        await coordinator.tick();await coordinator.tick();expect(f.creates).toHaveLength(0);await f.replace();await coordinator.tick();expect(f.creates).toHaveLength(1);
    });
    it('requires the current catalog publication after a historical successful job',async()=>{
        const f=await fixture(),coordinator=f.coordinator(),key=catalogRebuildRequestKey(f.request().requestId,f.plan().id);f.jobs.set(key,{id:'finished',state:'SUCCEEDED'});
        await coordinator.tick();expect((await readCatalogRebuildState(f.file))?.items[0].state).toBe('pending');
        f.plans([{...f.plan(),catalogReady:true}]);await coordinator.tick();expect((await readCatalogRebuildState(f.file))?.state).toBe('ready');expect(f.creates).toHaveLength(0);
    });
    it('recovers a failed final status publication on the next tick without creating another job',async()=>{
        const f=await fixture();f.plans([{...f.plan(),catalogReady:true}]);
        const rename=vi.spyOn(fs,'rename').mockRejectedValueOnce(Object.assign(new Error('Controlled status I/O failure'),{code:'EIO'}));
        const coordinator=f.coordinator();await coordinator.tick();expect(await readCatalogRebuildState(f.file)).toMatchObject({state:'preparing',items:[]});
        await coordinator.tick();expect((await readCatalogRebuildState(f.file))?.state).toBe('ready');expect(f.creates).toHaveLength(0);expect(rename).toHaveBeenCalledTimes(2);
    });
    it('rejects principal, command and filesystem injection in operator metadata',()=>{
        const request=makeCatalogRebuildRequest('a'.repeat(64));for(const property of ['actor','command','path'])expect(()=>parseCatalogRebuildRequest({...request,[property]:'untrusted'})).toThrow();
    });
    it('keeps corrupted status metadata visible as attention without claiming a package is ready',async()=>{
        const f=await fixture();await fs.writeFile(f.file+'.status.json',JSON.stringify({...f.request(),updatedAt:new Date().toISOString(),state:'ready',items:[null]}));
        expect(await readCatalogRebuildState(f.file)).toMatchObject({state:'attention',items:[]});expect(f.creates).toHaveLength(0);
    });
});
