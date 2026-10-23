import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {completeDeviceJob} from '../src/devices/device-completion';
import {buildPackage} from '../src/catalog/bundle-package';
import {installCompletion,ragDevice,ragInstallJob,ragInstallSet,ragPackage} from './rag-install-inspection.fixture';

describe('RAG installation completion schedules a read-only bounded continuation',()=>{
    afterEach(()=>vi.unstubAllGlobals());
    function fixture(kind:'mcp'|'plugin'|'set'|'other'='mcp'){
        const device=ragDevice(),set=kind==='set'?ragInstallSet():undefined;
        const pkg=kind==='other'?buildPackage({id:'ordinary',kind:'plugin',name:'Ordinary',version:1},[{path:'ordinary.mjs',content:'export default()=>({})'}],new Date(0).toISOString()):ragPackage(kind==='plugin'?'plugin':'mcp');
        const job=ragInstallJob(device,set,set?undefined:pkg),query=vi.fn(async(sql:string,values?:unknown[])=>{
            if(sql.startsWith('SELECT * FROM bridge_jobs'))return {rows:[job]};
            if(sql.includes('FROM bridge_devices'))return {rows:[device]};
            if(sql.includes('INSERT INTO bridge_jobs'))return {rows:[{id:values?.[0]}],rowCount:1};
            return {rows:[],rowCount:1};
        });
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
        const release=vi.fn(),connect=vi.fn(async()=>({query,release})),pool={connect} as unknown as Pool;
        return{device,job,query,pool,connect,release};
    }
    it.each(['mcp','plugin','set'] as const)('accepted %s completion enqueues exactly one inspection in the same transaction',async kind=>{
        const f=fixture(kind);await completeDeviceJob(f.pool,f.device.id,f.job.id,installCompletion(f.job));
        const inserts=f.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO bridge_jobs'));
        expect(inserts).toHaveLength(1);expect(JSON.stringify(inserts[0])).toContain('inspect-installation');
        expect(JSON.stringify(inserts[0])).not.toContain('connect-rag-model');expect(JSON.stringify(inserts[0])).not.toContain('sync-rag');
        expect(f.connect).toHaveBeenCalledOnce();expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    });
    it('an unrelated package does not gain an automatic inspection',async()=>{
        const f=fixture('other');await completeDeviceJob(f.pool,f.device.id,f.job.id,installCompletion(f.job));
        expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO bridge_jobs'))).toBe(false);
    });
    it('failed install and repeated accepted ACK do not schedule a continuation',async()=>{
        const f=fixture();await completeDeviceJob(f.pool,f.device.id,f.job.id,installCompletion(f.job,true));
        expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO bridge_jobs'))).toBe(false);
        f.query.mockClear();const input=installCompletion(f.job);f.job.state='succeeded';(f.job as unknown as {result:unknown}).result=input.result;
        expect(await completeDeviceJob(f.pool,f.device.id,f.job.id,input)).toEqual({ok:true,repeated:true});
        expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO bridge_jobs'))).toBe(false);
    });
    it('failure to persist the inspection rolls back the completion',async()=>{
        const f=fixture(),original=f.query.getMockImplementation()!;
        f.query.mockImplementation(async(sql,values)=>{if(sql.includes('INSERT INTO bridge_jobs'))throw new Error('owned child write failure');return original(sql,values);});
        await expect(completeDeviceJob(f.pool,f.device.id,f.job.id,installCompletion(f.job))).rejects.toThrow('owned child write failure');
        expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();
    });
});
