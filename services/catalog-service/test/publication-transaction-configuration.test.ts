import {describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {PluginRepository} from '../src/publication/plugin-repository';
import {publicationHash,validatePublication} from '../src/publication/publication-validation';

const input={name:'Configured publication',kind:'mcp' as const,description:'Owned transaction boundary',config:{transport:'remote' as const,url:'https://example.test/mcp'},publicationKey:'11111111-1111-4111-8111-111111111111'};
const row={id:'ai-plug-22222222-2222-4222-8222-222222222222',name:input.name,kind:input.kind,description:input.description,version:1,compatibility:null,tags:[],origin:'upload',revision:null,config:input.config,files:[],created_at:'old',updated_at:'old',publication_hash:publicationHash(validatePublication(input))};
function fixture(failure?:Error,rollbackFails=false){
    const events:string[]=[],release=vi.fn(),discard=vi.fn();
    const query=vi.fn(async(sql:string)=>{
        events.push(sql);
        if(sql==='ROLLBACK'&&rollbackFails)throw Error('Unconfirmed rollback');
        return {rows:sql.startsWith('SELECT id,kind FROM ai_plugins')||sql.startsWith('SELECT * FROM ai_plugins WHERE publication_key')?[row]:[]};
    });
    const client={query,release} as unknown as PoolClient,pool={connect:vi.fn(async()=>client)} as unknown as Pool;
    const configure=vi.fn(async()=>{events.push('configure owned SQL');if(failure)throw failure;});
    return {events,query,client,pool,release,discard,configure,repository:new PluginRepository(pool,discard,configure)};
}

describe('Only the configured publication owner may change transaction settings',()=>{
    it('Configures after its own BEGIN and before the first resource or graph lock',async()=>{
        const f=fixture();await f.repository.create(input,'main@example.test');
        expect(f.configure).toHaveBeenCalledExactlyOnceWith(f.client);
        expect(f.events.indexOf('configure owned SQL')).toBeGreaterThan(f.events.indexOf('BEGIN'));
        expect(f.events.indexOf('configure owned SQL')).toBeLessThan(f.events.findIndex(sql=>sql.includes('pg_advisory_xact_lock')));
    });
    it('An ordinary metadata repository does not configure SQL settings',async()=>{
        const f=fixture();await new PluginRepository(f.pool).create(input,'main@example.test');
        expect(f.configure).not.toHaveBeenCalled();expect(f.events).not.toContain('configure owned SQL');
    });
    it('An existing outer transaction keeps its settings and ownership',async()=>{
        const f=fixture();await f.repository.create(input,'main@example.test',undefined,f.client,true);
        expect(f.configure).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();expect(f.discard).not.toHaveBeenCalled();
        expect(f.events.some(sql=>['BEGIN','COMMIT','ROLLBACK'].includes(sql))).toBe(false);
    });
    it('A configuration failure rolls back without acquiring locks and preserves the primary error',async()=>{
        const primary=Error('Owned settings query failed'),f=fixture(primary);
        await expect(f.repository.create(input,'main@example.test')).rejects.toBe(primary);
        expect(f.events).toEqual(['BEGIN','configure owned SQL','ROLLBACK']);expect(f.release).toHaveBeenCalledExactlyOnceWith();
    });
    it('Unconfirmed rollback invalidates a borrowed lease without replacing the configuration error',async()=>{
        const primary=Error('Owned settings ACK lost'),f=fixture(primary,true);
        await expect(f.repository.create(input,'main@example.test',undefined,f.client)).rejects.toBe(primary);
        expect(f.discard).toHaveBeenCalledExactlyOnceWith(f.client);expect(f.release).not.toHaveBeenCalled();expect(f.events).not.toContain('COMMIT');
    });
});
