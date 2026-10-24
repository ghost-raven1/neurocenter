import {describe,expect,it,vi} from 'vitest';
import {withImportRegistryTransaction} from '../src/database/import-registry-transaction';

describe('Import-owned immutable cache registry uses bounded SQL waits',()=>{
    it.each(['success','abort','sql-wait','rollback-lost'] as const)('keeps transaction ownership and cleanup for %s',async outcome=>{
        const controller=new AbortController(),reason=Error('Controlled import abort'),failure=Object.assign(Error('Owned SQL lock wait'),{code:'55P03'}),events:string[]=[],release=vi.fn();
        const query=vi.fn(async(sql:string)=>{events.push(sql);if(sql.includes('EXTRACT(EPOCH'))return {rows:[{lock_ms:'0',statement_ms:'0'}]};if(sql==='ROLLBACK'&&outcome==='rollback-lost')throw Error('Rollback ACK lost');return {rows:[]};});
        const pool={connect:vi.fn(async()=>({query,release}))};
        const pending=withImportRegistryTransaction(pool as never,controller.signal,async client=>{
            await client.query('INSERT owned immutable cache');if(outcome==='abort')controller.abort(reason);if(outcome==='sql-wait'||outcome==='rollback-lost')throw failure;return 'registered';
        });
        if(outcome==='success'){await expect(pending).resolves.toBe('registered');expect(events.at(-1)).toBe('COMMIT');}
        else{await expect(pending).rejects.toBe(outcome==='abort'?reason:failure);expect(events.at(-1)).toBe('ROLLBACK');expect(events).not.toContain('COMMIT');}
        expect(events.indexOf('INSERT owned immutable cache')).toBeGreaterThan(events.findIndex(sql=>sql.includes('set_config')));
        expect(release).toHaveBeenCalledTimes(1);if(outcome==='rollback-lost')expect(release).toHaveBeenCalledWith(true);else expect(release).toHaveBeenCalledWith();
    });
    it('preserves the legacy pool path for callers without a request signal',async()=>{
        const pool={query:vi.fn(),connect:vi.fn()},work=vi.fn(async client=>{expect(client).toBe(pool);return 'legacy';});
        expect(await withImportRegistryTransaction(pool as never,undefined,work)).toBe('legacy');expect(pool.connect).not.toHaveBeenCalled();
    });
});
