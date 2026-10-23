import type {Pool} from 'pg';
import {describe,expect,it,vi} from 'vitest';
import {checkFeatureFlagsMigrations,migrateFeatureFlags} from '../src/database/migrations';

const lock="SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:catalog:migrations',0))";
const modes=['normal','not-dispatched','ack-lost'] as const;
const cases=[
    {name:'migrate',begin:'BEGIN',run:migrateFeatureFlags},
    {name:'check',begin:'BEGIN READ ONLY',run:checkFeatureFlagsMigrations},
].flatMap(boundary=>modes.map(rollback=>({...boundary,rollback})));

/** Only the SQL-client cleanup contract is mocked; native fixtures prove persisted effects separately. */
describe('Migration-owned transaction cleanup',()=>{
    it.each(cases)('$name preserves primary error without retry; ROLLBACK=$rollback',async({begin,run,rollback})=>{
        const primary=Object.assign(new Error('Lock acknowledgment lost'),{code:'ECONNRESET'}),rollbackError=new Error('ROLLBACK acknowledgment lost');
        const executed:string[]=[],release=vi.fn();
        const query=vi.fn(async(sql:string)=>{
            if(sql==='ROLLBACK'&&rollback==='not-dispatched')throw rollbackError;
            executed.push(sql);
            if(sql==='ROLLBACK'&&rollback==='ack-lost')throw rollbackError;
            if(sql===lock)throw primary;
            return {rows:[]};
        });
        const connect=vi.fn(async()=>({query,release})),pool={connect} as unknown as Pool;
        await expect(run(pool)).rejects.toBe(primary);
        expect(connect).toHaveBeenCalledOnce();
        expect(query.mock.calls).toEqual([[begin],[lock],['ROLLBACK']]);
        expect(executed).toEqual(rollback==='not-dispatched'?[begin,lock]:[begin,lock,'ROLLBACK']);
        if(rollback==='normal')expect(release).toHaveBeenCalledExactlyOnceWith();
        else expect(release).toHaveBeenCalledExactlyOnceWith(true);
    });
});
