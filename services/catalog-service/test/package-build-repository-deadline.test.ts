import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {PackageBuildRepository} from '../src/package-build/package-build.repository';
import type {BuildRow} from '../src/package-build/package-build.model';

interface Options {lock?:string;statement?:string;failAt?:'read-policy'|'apply-policy'|'work'|'commit';rollbackFails?:boolean;borrowed?:boolean}
function fixture(options:Options={}){
    const primary=Object.assign(Error('Owned SQL boundary failed'),{code:options.failAt==='commit'?'ECONNRESET':'55P03'}),rollback=Error('ROLLBACK acknowledgment lost');
    const settings={lock:options.lock??'0',statement:options.statement??'0'},events:string[]=[],observations:Array<{sql:string;settings?:string[]}>=[];
    const row={id:randomUUID(),actor:'owner@example.test',request_key:randomUUID(),request_hash:'same-request',state:'RUNNING',execution_nonce:randomUUID(),percent:0,message:'Owned job',result:null,error:null,
        config:{kind:'mcp',name:'Owned job',description:'Owned source',tags:[],targets:['darwin-arm64'],source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default {};'}]}}} as BuildRow;
    let configured:string[]|undefined;
    const query=vi.fn(async(sql:string,values?:unknown[])=>{
        events.push(sql);
        if(sql==='BEGIN')return {rows:[]};
        if(sql.includes('EXTRACT(EPOCH')){if(options.failAt==='read-policy')throw primary;return {rows:[{lock_ms:settings.lock,statement_ms:settings.statement}]};}
        if(sql.includes('set_config')){if(options.failAt==='apply-policy')throw primary;configured=values as string[];return {rows:[]};}
        if(sql==='ROLLBACK'){if(options.rollbackFails)throw rollback;return {rows:[]};}
        if(sql==='COMMIT'){if(options.failAt==='commit')throw primary;return {rows:[]};}
        observations.push({sql,settings:configured&&[...configured]});if(options.failAt==='work')throw primary;
        if(sql.startsWith('SELECT count(*)'))return {rows:[{count:0}]};
        if(sql.includes('FOR UPDATE'))return {rows:[row]};
        if(sql.startsWith('INSERT INTO tool_build_jobs')||sql.startsWith('UPDATE tool_build_jobs'))return {rows:[row]};
        return {rows:[]};
    });
    const release=vi.fn(),tainted=vi.fn(),client={query,release} as unknown as PoolClient,connect=vi.fn(async()=>client);
    return {primary,row,query,events,observations,release,tainted,client,connect,repository:new PackageBuildRepository({connect} as unknown as Pool,options.borrowed?tainted:undefined)};
}
type Fixture=ReturnType<typeof fixture>;
const authorize=async()=>undefined;
const paths:Array<[string,(f:Fixture)=>Promise<unknown>]>= [
    ['enqueue',f=>f.repository.enqueue(f.row.actor,f.row.request_key,f.row.request_hash,f.row.config)],
    ['takeQueued',f=>f.repository.takeQueued(f.client)],
    ['progress',f=>f.repository.progress(f.row.id,'FAILED',0,'Source retained',undefined,'SQL wait ended')],
    ['cancelRequest',f=>f.repository.cancelRequest(f.row.actor,f.row.request_key,authorize)],
    ['cancel',f=>f.repository.cancel(f.row.actor,f.row.id,authorize)],
    ['beginPublication',f=>f.repository.beginPublication(f.row.id,f.client,authorize)],
    ['completeCancellation',f=>f.repository.completeCancellation(f.row.id)],
    ['markExecutionStarted',f=>f.repository.markExecutionStarted(f.row.id,f.row.execution_nonce!,f.client)],
    ['cancellationCleanupFailed',f=>f.repository.cancellationCleanupFailed(f.row.id)],
    ['cancellationAwaitingOwner',f=>f.repository.cancellationAwaitingOwner(f.row.id)],
    ['failInterrupted',f=>f.repository.failInterrupted(f.client)],
];

describe('Every repository-owned build transaction bounds its SQL before business work',()=>{
    it.each(paths)('%s applies caps after BEGIN before its first owned lock or write',async(_name,run)=>{
        const f=fixture();await run(f);
        expect(f.observations.length).toBeGreaterThan(0);
        expect(f.observations.every(item=>JSON.stringify(item.settings)===JSON.stringify(['5000ms','30000ms']))).toBe(true);
        const configured=f.events.findIndex(sql=>sql.includes('set_config'));
        expect(configured).toBeGreaterThan(f.events.indexOf('BEGIN'));expect(configured).toBeLessThan(f.events.indexOf(f.observations[0].sql));expect(f.events.at(-1)).toBe('COMMIT');
    });
    it.each([['100','0','100ms','30000ms'],['0','200','5000ms','200ms'],['100','200','100ms','200ms']])('Preserves inherited lock=%s and statement=%s independently',async(lock,statement,expectedLock,expectedStatement)=>{
        const f=fixture({lock,statement});await f.repository.failInterrupted();
        expect(f.observations[0].settings).toEqual([expectedLock,expectedStatement]);expect(f.release).toHaveBeenCalledExactlyOnceWith();
    });
    it.each(['read-policy','apply-policy'] as const)('A %s failure rolls back before work and retains the primary error',async failAt=>{
        const f=fixture({failAt});await expect(f.repository.failInterrupted()).rejects.toBe(f.primary);
        expect(f.observations).toEqual([]);expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.events).not.toContain('COMMIT');expect(f.release).toHaveBeenCalledExactlyOnceWith();
    });
    it.each([false,true])('A SQL timeout with rollback failure discards an uncertain borrowed=%s session',async borrowed=>{
        const f=fixture({failAt:'work',rollbackFails:true,borrowed});
        await expect(f.repository.enqueue(f.row.actor,f.row.request_key,f.row.request_hash,f.row.config,borrowed?f.client:undefined)).rejects.toBe(f.primary);
        expect(f.events).not.toContain('COMMIT');
        if(borrowed){expect(f.tainted).toHaveBeenCalledExactlyOnceWith(f.client);expect(f.release).not.toHaveBeenCalled();}
        else expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('Confirmed rollback retains a borrowed lease and the exact source for a caller-controlled replay',async()=>{
        const f=fixture({failAt:'work',borrowed:true}),source=structuredClone(f.row.config);
        await expect(f.repository.enqueue(f.row.actor,f.row.request_key,f.row.request_hash,f.row.config,f.client)).rejects.toBe(f.primary);
        expect(f.row.config).toEqual(source);expect(f.tainted).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();expect(f.events.at(-1)).toBe('ROLLBACK');
    });
    it('An unknown COMMIT acknowledgment is not retried or replaced by policy handling',async()=>{
        const f=fixture({failAt:'commit'});
        await expect(f.repository.enqueue(f.row.actor,f.row.request_key,f.row.request_hash,f.row.config)).rejects.toBe(f.primary);
        expect(f.events.filter(sql=>sql==='BEGIN')).toHaveLength(1);expect(f.events.filter(sql=>sql==='COMMIT')).toHaveLength(1);
        expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO tool_build_jobs'))).toHaveLength(1);expect(f.release).toHaveBeenCalledExactlyOnceWith();
    });
});
