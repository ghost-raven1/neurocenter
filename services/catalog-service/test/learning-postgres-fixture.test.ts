import {afterEach,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {ownedLearningTestAdminUrl} from './learning-postgres.fixture';

vi.mock('pg',()=>({Pool:vi.fn(()=>{throw Error('Validator must not construct a pool.');})}));
vi.mock('../src/database/catalog-schema',()=>({ensureCatalogSchema:vi.fn()}));
afterEach(()=>{expect(Pool).not.toHaveBeenCalled();vi.clearAllMocks();});

describe('Learning fixture owned PostgreSQL URL admission before network',()=>{
    it.each([
        undefined,'','not-a-url','http://127.0.0.1:59616/postgres',
        'postgresql://qa:fixture@localhost:59616/postgres','postgresql://qa:fixture@example.test:59616/postgres',
        'postgresql://qa:fixture@127.0.0.1/postgres','postgresql://qa:fixture@127.0.0.1:5432/postgres',
        'postgresql://qa:fixture@127.0.0.1:59616/production','postgresql://qa:fixture@127.0.0.1:59616/',
        'postgresql://qa:fixture@127.0.0.1:59616/postgres?host=example.test',
        'postgresql://qa:fixture@127.0.0.1:59616/postgres?port=5432',
        'postgresql://qa:fixture@127.0.0.1:59616/postgres#override',
        'postgresql://qa:fixture@127.0.0.1:59616/%70ostgres',
    ])('rejects a missing, ambiguous or redirectable administrative URL: %s',value=>{
        expect(()=>ownedLearningTestAdminUrl(value)).toThrow();
    });
    it.each(['postgresql://qa:fixture@127.0.0.1:59616/postgres','postgres://qa:fixture@127.0.0.1:59617/postgres'])('accepts an explicit owned non-default loopback URL without network: %s',value=>{
        expect(ownedLearningTestAdminUrl(value).href).toBe(value);
    });
});
