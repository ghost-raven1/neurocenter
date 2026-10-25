import {afterEach,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {databaseFixture} from './asset-import-db.fixture';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';

vi.mock('pg',()=>({Pool:vi.fn(function(){throw new Error('No PostgreSQL Pool may be constructed before fixture admission.');})}));
afterEach(()=>{expect(Pool).not.toHaveBeenCalled();vi.clearAllMocks();vi.unstubAllEnvs();});
const owned='postgresql://fixture:synthetic@127.0.0.1:59616/postgres';

describe('Native fixtures require explicit owned PostgreSQL before any Pool',()=>{
    it.each([
        undefined,'','not-a-url','http://fixture:synthetic@127.0.0.1:59616/postgres',
        'postgresql://fixture:synthetic@localhost:59616/postgres','postgresql://fixture:synthetic@example.test:59616/postgres',
        'postgresql://fixture:synthetic@127.0.0.1/postgres','postgresql://fixture:synthetic@127.0.0.1:5432/postgres',
        'postgresql://fixture:synthetic@127.0.0.1:0/postgres','postgresql://fixture:synthetic@127.0.0.1:59616/catalog',
        'postgresql://127.0.0.1:59616/postgres','postgresql://fixture@127.0.0.1:59616/postgres',
        owned+'?host=remote.invalid',owned+'?port=5432',owned+'?user=application',owned+'?password=foreign',
        owned+'?sslcert=/foreign/secret',owned+'?',owned+'#foreign',owned+'#',
        'postgresql://fixture:synthetic@127.0.0.1:59616/%70ostgres',owned+' ',
    ])('rejects unsafe or missing admission before the actual asset fixture constructs a Pool: %#',async value=>{
        vi.stubEnv('TEST_ADMIN_PG_URL',value);vi.stubEnv('CATALOG_TEST_PG_URL',undefined);
        vi.stubEnv('CATALOG_PG_URL','postgresql://application:synthetic@127.0.0.1:5432/catalog');
        vi.stubEnv('PGHOST','127.0.0.1');vi.stubEnv('PGPORT','5432');vi.stubEnv('PGUSER','application');vi.stubEnv('PGPASSWORD','synthetic');
        await expect(databaseFixture()).rejects.toThrow(/Set TEST_ADMIN_PG_URL or CATALOG_TEST_PG_URL/);
    });
    it('does not conceal an explicitly empty or invalid first setting behind a second URL',()=>{
        for(const value of ['', 'invalid'])expect(()=>callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:value,CATALOG_TEST_PG_URL:owned})).toThrow(/explicitly owned/);
    });
    it.each(['TEST_ADMIN_PG_URL','CATALOG_TEST_PG_URL'] as const)('accepts explicit caller configuration in %s without network',name=>{
        expect(callerOwnedPostgresAdmin({[name]:owned}).href).toBe(owned);
    });
    it('keeps configured credentials opaque in the admission error',()=>{
        expect(()=>callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:'postgresql://private-user:private-password@127.0.0.1:5432/postgres'})).toThrow(/^Set TEST_ADMIN/);
        try{callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:'postgresql://private-user:private-password@127.0.0.1:5432/postgres'});}catch(error){expect(String(error)).not.toMatch(/private-user|private-password/);}
    });
});
