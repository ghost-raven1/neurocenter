import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import type {ChildProcess} from 'node:child_process';
const mocks=vi.hoisted(()=>({stop:vi.fn()}));
vi.mock('../src/package-build/build-process',()=>({stopBuildProcess:mocks.stop}));
import {BuildCancellation,BuildCancelledError} from '../src/package-build/build-cancellation';
import {PackageBuildRepository} from '../src/package-build/package-build.repository';
import type {BuildRow} from '../src/package-build/package-build.model';

describe('Job-local cancellation observes only its own child',()=>{
    afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
    it('Stops a late child after cancellation before observe',()=>{
        const control=new BuildCancellation(async()=>({state:'RUNNING'})),child={pid:123} as ChildProcess;
        control.cancel();control.observe(child);
        expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(child);
        expect(()=>control.assertActive()).toThrow(BuildCancelledError);control.dispose();
    });
    it('Observes durable standby cancellation and releases its polling timer',async()=>{
        vi.useFakeTimers();const read=vi.fn(async()=>({state:'CANCELLING'})),child={pid:124} as ChildProcess;
        const control=new BuildCancellation(read);control.observe(child);await vi.advanceTimersByTimeAsync(500);
        expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(child);expect(control.controller.signal.reason).toBeInstanceOf(BuildCancelledError);
        control.dispose();await vi.advanceTimersByTimeAsync(5000);expect(read).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
    it('A failed state observation stops the child without manufacturing a cancellation acknowledgment',async()=>{
        vi.useFakeTimers();const control=new BuildCancellation(async()=>{throw Error('SQL unavailable');});control.observe({pid:125} as ChildProcess);
        await vi.advanceTimersByTimeAsync(500);expect(mocks.stop).toHaveBeenCalledOnce();
        expect(control.controller.signal.reason).not.toBeInstanceOf(BuildCancelledError);control.dispose();
    });
});

describe('Cancellation transaction failure preserves its primary error',()=>{
    const fixture=(borrowed=false)=>{
        const primary=Error('Authorization failed'),rollback=Error('Rollback failed');
        const row={id:randomUUID(),actor:'owner@example.test',request_key:randomUUID(),state:'RUNNING'} as BuildRow;
        const client={query:vi.fn(async(sql:string)=>{if(sql==='ROLLBACK')throw rollback;return{rows:sql.includes('FOR UPDATE')?[row]:[]};}),release:vi.fn()} as unknown as PoolClient;
        const tainted=vi.fn(),pool={connect:async()=>client} as unknown as Pool;
        return{primary,row,client,tainted,repository:new PackageBuildRepository(pool,borrowed?tainted:undefined)};
    };
    it('Discards a newly borrowed transaction client on rollback failure',async()=>{
        const f=fixture();await expect(f.repository.cancel(f.row.actor,f.row.id,async()=>{throw f.primary;})).rejects.toBe(f.primary);
        expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('Invalidates the lease owner instead of reusing an uncertain session',async()=>{
        const f=fixture(true);await expect(f.repository.beginPublication(f.row.id,f.client,async()=>{throw f.primary;})).rejects.toBe(f.primary);
        expect(f.tainted).toHaveBeenCalledExactlyOnceWith(f.client);expect(f.client.release).not.toHaveBeenCalled();
    });
});

describe('Queue admission preserves recovery intents without letting them block new work',()=>{
    const fixture=(states:string[])=>{
        const inserted:BuildRow[]=[];
        const client={query:vi.fn(async(sql:string,values:unknown[]=[])=>{
            if(sql.startsWith('SELECT count(*)')){
                const admitted=sql.match(/state IN \(([^)]+)\)/)![1].split(',').map(value=>value.trim().replaceAll("'",''));
                return{rows:[{count:states.filter(state=>admitted.includes(state)).length}]};
            }
            if(sql.startsWith('INSERT INTO tool_build_jobs')){
                const row={id:values[0],actor:values[1],request_key:values[2],config:values[4],state:'QUEUED'} as BuildRow;inserted.push(row);return{rows:[row]};
            }
            return{rows:[]};
        }),release:vi.fn()} as unknown as PoolClient;
        return{repository:new PackageBuildRepository({connect:async()=>client} as unknown as Pool),inserted,client};
    };
    it('Ten CANCELLING jobs waiting for foreign cleanup proof do not consume active queue slots',async()=>{
        const f=fixture(Array(10).fill('CANCELLING'));
        const row=await f.repository.enqueue('owner@example.test',randomUUID(),'fixture-hash',{name:'Next independent build'} as BuildRow['config']);
        expect(row.state).toBe('QUEUED');expect(f.inserted).toHaveLength(1);
        expect(f.client.query.mock.calls.some(([sql])=>String(sql).startsWith('DELETE'))).toBe(false);
    });
    it.each(['QUEUED','RUNNING'])('Ten actual %s jobs still enforce the bounded active queue',async state=>{
        const f=fixture(Array(10).fill(state));
        await expect(f.repository.enqueue('owner@example.test',randomUUID(),'fixture-hash',{name:'Over capacity'} as BuildRow['config'])).rejects.toMatchObject({status:409});
        expect(f.inserted).toHaveLength(0);
    });
});
