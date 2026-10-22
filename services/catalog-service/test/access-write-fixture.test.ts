import {describe,expect,it} from 'vitest';
import {ownedAccessTestAdminUrl} from './access-write-postgres.fixture';

describe('Explicit administrative-write test admission',()=>{
    it.each(['postgres','postgresql'])('accepts an explicitly owned alternate port using %s',scheme=>{
        expect(ownedAccessTestAdminUrl(scheme+'://qa:qa@127.0.0.1:59234/postgres').port).toBe('59234');
    });
    it.each(['','not a URL','http://127.0.0.1:59234/postgres','postgres://127.0.0.1/postgres','postgres://127.0.0.1:5432/postgres',
        'postgres://localhost:59234/postgres','postgres://example.test:59234/postgres','postgres://127.0.0.1:59234/catalog',
        'postgres://127.0.0.1:59234/postgres?application_name=foreign','postgres://127.0.0.1:59234/postgres#foreign'])('rejects an unsafe explicit fixture address %#',value=>{
        expect(()=>ownedAccessTestAdminUrl(value)).toThrow(/explicitly owned/);
    });
});
