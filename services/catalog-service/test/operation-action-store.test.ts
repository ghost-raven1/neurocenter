import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {OperationActionStore} from '../src/operations/operation-action-store';
import {createPool} from '../src/database/pool';

vi.mock('../src/database/pool',()=>({createPool:vi.fn()}));
afterEach(()=>vi.unstubAllEnvs());

describe('Explicit owner of operation session locks and receipts',()=>{
    const lease={query:vi.fn(),release:vi.fn()},connect=vi.fn(async()=>lease),end=vi.fn(async()=>{});
    beforeEach(()=>{vi.clearAllMocks();vi.mocked(createPool).mockReturnValue({connect,end} as never);});
    it('uses an independent pool on the selected database, bounds it to five and closes its own resource',async()=>{
        const selected={connectionString:'postgresql://fixture@localhost:15432/nc_operation_owned',max:20,connectionTimeoutMillis:500};
        const store=new OperationActionStore(selected);
        expect(createPool).toHaveBeenCalledWith({...selected,max:5},'operation-actions');expect(await store.connect()).toBe(lease);
        await store.onApplicationShutdown();expect(end).toHaveBeenCalledOnce();expect(lease.release).not.toHaveBeenCalled();
    });
    it('missing explicit database never falls back to inherited live configuration',()=>{
        vi.stubEnv('CATALOG_PG_URL','postgresql://fixture@localhost:5432/catalog');
        expect(()=>new OperationActionStore({})).toThrow('explicitly selected database');expect(createPool).not.toHaveBeenCalled();
    });
});
