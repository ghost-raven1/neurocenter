import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {BuildRow} from '../src/package-build/package-build.model';
import {captureDevTrace,deferred} from './dev-trace.fixture';

const mocks=vi.hoisted(()=>({pool:{query:vi.fn(),end:vi.fn()},build:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>mocks.pool}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../src/package-build/build-process',async()=>({...await vi.importActual('../src/package-build/build-process'),runPackageBuilder:mocks.build}));
import {PackageBuildService} from '../src/package-build/package-build.service';
import {BuildProcessUnreapedError} from '../src/package-build/build-process';

const roots:string[]=[];
beforeEach(()=>{vi.clearAllMocks();mocks.pool.query.mockResolvedValue({rows:[]});});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});

async function fixture(){
    const capture=captureDevTrace(),root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-dev-trace-'));roots.push(root);
    const actor={email:'private-actor@example.test',activeRole:'Главный админ'};
    const input={requestKey:randomUUID(),kind:'plugin',name:'Private source name',description:'private-description',targets:['darwin-arm64'],
        source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default()=>"private-source";'}]}};
    const row={id:randomUUID(),request_key:input.requestKey,execution_nonce:randomUUID(),actor:actor.email,state:'QUEUED',percent:0,config:{}} as BuildRow;
    const repository={existing:vi.fn(),enqueue:vi.fn(async(_actor:string,_key:string,_hash:string,config:BuildRow['config'])=>{row.config=config;return row;}),
        get:vi.fn(async()=>row),evidence:vi.fn(async()=>({})),progress:vi.fn(async(_id:string,state:BuildRow['state'])=>{row.state=state;return row;}),
        cancel:vi.fn(async()=>{row.state='CANCELLING';return row;}),completeCancellation:vi.fn(async()=>{row.state='CANCELLED';return true;}),
        cancellationAwaitingOwner:vi.fn(),cancellationCleanupFailed:vi.fn()};
    const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as never,{} as never,{} as never,{} as never);
    Object.assign(service,{lease:{},repository,stagingRoot:async()=>root,startWorker:vi.fn()});
    const run=()=>(service as unknown as{execute:(row:BuildRow,root:string)=>Promise<void>}).execute(row,root);
    return {capture,root,actor,input,row,repository,service,run};
}

describe('Production ToolBuild methods preserve the request, build and operation chain',()=>{
    it('links accepted work and its explicit cancellation to the same operation',async()=>{
        const f=await fixture(),dispatched=deferred();
        await f.service.create(f.actor,f.input);f.row.state='RUNNING';
        mocks.build.mockImplementation(async(_config:unknown,_stage:string,_child:unknown,_progress:unknown,signal:AbortSignal)=>{
            dispatched.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
        });
        const pending=f.run();await dispatched.promise;await f.service.cancel(f.actor,f.row.id);await pending;
        expect(f.row.state).toBe('CANCELLED');
        const records=f.capture.records();expect(records.map(row=>row.event)).toEqual(['requested','accepted','started','cancel-requested','cancelled']);
        expect(records[0]).not.toHaveProperty('buildId');expect(records[0]).not.toHaveProperty('operationId');
        for(const record of records.slice(1))expect(record).toMatchObject({requestKey:f.input.requestKey,buildId:f.row.id,operationId:'tool-build-'+f.row.id,launchId:f.capture.launchId});
        expect(JSON.stringify(records)).not.toMatch(/private-|source|description|actor/);
    });
    it('keeps an idempotent replay on the previously accepted build',async()=>{
        const f=await fixture();await f.service.create(f.actor,f.input);f.repository.existing.mockResolvedValue(f.row);
        const replay=await f.service.create(f.actor,f.input);
        expect(replay.id).toBe(f.row.id);expect(f.repository.enqueue).toHaveBeenCalledOnce();
        expect(f.capture.records().map(row=>row.event)).toEqual(['requested','accepted','requested','replayed']);
        expect(f.capture.records().at(-1)).toMatchObject({requestKey:f.input.requestKey,buildId:f.row.id,operationId:'tool-build-'+f.row.id});
    });
    it('an unreaped cancellation remains partial while the durable job awaits its owner',async()=>{
        const f=await fixture(),dispatched=deferred();await f.service.create(f.actor,f.input);f.row.state='RUNNING';
        mocks.build.mockImplementation(async(_config:unknown,_stage:string,_child:unknown,_progress:unknown,signal:AbortSignal)=>{
            dispatched.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new BuildProcessUnreapedError()),{once:true}));
        });
        const pending=f.run();await dispatched.promise;await f.service.cancel(f.actor,f.row.id);await pending;
        expect(f.row.state).toBe('CANCELLING');expect(f.repository.cancellationAwaitingOwner).toHaveBeenCalledOnce();
        expect(f.repository.completeCancellation).not.toHaveBeenCalled();
        expect(f.capture.records().map(row=>row.event)).toEqual(['requested','accepted','started','cancel-requested']);
    });
    it.each(['stage','forget'] as const)('a %s cleanup failure cannot publish terminal cancellation',async boundary=>{
        const f=await fixture(),dispatched=deferred(),remove=fs.rm,primary=Error('private-cleanup-failure');
        await f.service.create(f.actor,f.input);f.row.state='RUNNING';
        vi.spyOn(fs,'rm').mockImplementation(async(file,options)=>{
            if(file===(boundary==='stage'?path.join(f.root,f.row.id):path.join(f.root,'.cleanup-acks',f.row.id+'.'+f.row.execution_nonce+'.json')))throw primary;
            return remove(file,options);
        });
        mocks.build.mockImplementation(async(_config:unknown,_stage:string,_child:unknown,_progress:unknown,signal:AbortSignal)=>{
            dispatched.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
        });
        const pending=f.run();await dispatched.promise;await f.service.cancel(f.actor,f.row.id);await expect(pending).rejects.toBe(primary);
        expect(f.row.state).toBe(boundary==='stage'?'CANCELLING':'CANCELLED');expect(f.repository.cancellationCleanupFailed).toHaveBeenCalledOnce();
        expect(f.capture.records().map(row=>row.event)).toEqual(['requested','accepted','started','cancel-requested']);
    });
    it('a no-op cancellation transition cannot publish terminal cancellation after cleanup',async()=>{
        const f=await fixture(),dispatched=deferred();await f.service.create(f.actor,f.input);f.row.state='RUNNING';
        f.repository.completeCancellation.mockImplementationOnce(async()=>false);
        mocks.build.mockImplementation(async(_config:unknown,_stage:string,_child:unknown,_progress:unknown,signal:AbortSignal)=>{
            dispatched.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
        });
        const pending=f.run();await dispatched.promise;await f.service.cancel(f.actor,f.row.id);await pending;
        expect(f.row.state).toBe('CANCELLING');expect(f.repository.completeCancellation).toHaveBeenCalledOnce();
        expect(f.capture.records().map(row=>row.event)).toEqual(['requested','accepted','started','cancel-requested']);
    });
    it('a failed trace sink cannot fail admission or expose a worker error',async()=>{
        const f=await fixture();f.capture.write.mockImplementation(()=>{throw Error('private-log-failure');});
        await expect(f.service.create(f.actor,f.input)).resolves.toMatchObject({id:f.row.id});
        f.row.state='RUNNING';mocks.build.mockRejectedValue(Error('private-builder-error'));
        await expect(f.run()).resolves.toBeUndefined();expect(f.row.state).toBe('FAILED');
    });
    it('a committed FAILED response publishes the matching terminal event',async()=>{
        const f=await fixture();await f.service.create(f.actor,f.input);f.row.state='RUNNING';mocks.build.mockRejectedValue(Error('private-builder-error'));
        await f.run();expect(f.row.state).toBe('FAILED');
        expect(f.capture.records().map(row=>row.event)).toEqual(['requested','accepted','started','failed']);
    });
    it.each(['throw','other-terminal','no-return'] as const)('an unacknowledged FAILED transition stays partial: %s',async outcome=>{
        const f=await fixture(),primary=Error('private-SQL-failure');await f.service.create(f.actor,f.input);f.row.state='RUNNING';
        f.repository.progress.mockImplementation(async(_id,state)=>{
            if(state==='FAILED'){
                if(outcome==='throw')throw primary;
                if(outcome==='no-return')return undefined as never;
                f.row.state='SUCCEEDED';return {...f.row};
            }
            f.row.state=state;return f.row;
        });
        mocks.build.mockRejectedValue(Error('private-builder-error'));
        if(outcome==='throw')await expect(f.run()).rejects.toBe(primary);else await f.run();
        expect(f.capture.records().map(row=>row.event)).toEqual(['requested','accepted','started']);
    });
    it.each(['SUCCEEDED','FAILED'] as const)('cleanup failure after durable %s keeps the trace partial',async state=>{
        const f=await fixture(),primary=Error('private-cleanup-failure'),remove=fs.rm;await f.service.create(f.actor,f.input);f.row.state='RUNNING';
        if(state==='SUCCEEDED'){
            f.row.config.kind='skill';Object.assign(f.service,{executeSkill:async()=>{f.row.state='SUCCEEDED';}});
        }else mocks.build.mockRejectedValue(Error('private-builder-error'));
        vi.spyOn(fs,'rm').mockImplementation(async(file,options)=>{if(file===path.join(f.root,f.row.id))throw primary;return remove(file,options);});
        await expect(f.run()).rejects.toBe(primary);expect(f.row.state).toBe(state);
        expect(f.capture.records().map(row=>row.event)).toEqual(['requested','accepted','started']);
    });
});
