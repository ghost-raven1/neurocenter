import {describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {PluginRepository} from '../src/publication/plugin-repository';
import {publicationHash,validatePublication} from '../src/publication/publication-validation';

const input={name:'Lock fixture',kind:'mcp' as const,description:'Controlled publication replay',config:{transport:'remote' as const,url:'https://example.test/mcp'},publicationKey:'11111111-1111-4111-8111-111111111111'};
const row={id:'ai-plug-22222222-2222-4222-8222-222222222222',name:input.name,kind:input.kind,description:input.description,version:1,compatibility:null,tags:[],origin:'upload',revision:null,config:input.config,files:[],created_at:'old',updated_at:'old',publication_hash:publicationHash(validatePublication(input))};
function fixture(race=false,rollbackFails=false){
    let discovery=0;const release=vi.fn(),effects=vi.fn(async(client:PoolClient)=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:mcp:'+row.id]);});
    const query=vi.fn(async(sql:string,_params?:unknown[])=>{
        if(sql==='ROLLBACK'&&rollbackFails)throw Error('Rollback not dispatched');
        if(sql.startsWith('SELECT id,kind FROM ai_plugins WHERE publication_key'))return {rows:race&&discovery++===0?[]:[row]};
        if(sql.startsWith('SELECT * FROM ai_plugins WHERE publication_key'))return {rows:[row]};
        return {rows:[]};
    });
    const client={query,release} as unknown as PoolClient,pool={connect:vi.fn(async()=>client)} as unknown as Pool;
    return {repository:new PluginRepository(pool),client,query,release,effects};
}
describe('Create replay shares the update/import asset before graph lock order',()=>{
    it('A known replay acquires its native asset before the dependency graph, including afterCreate effects',async()=>{
        const f=fixture();await f.repository.create(input,'main@example.test',f.effects);
        const locks=f.query.mock.calls.filter(call=>call[0].includes('pg_advisory_xact_lock')).map(call=>call[1]?.[0]);
        expect(locks.indexOf('asset-management:mcp:'+row.id)).toBeLessThan(locks.indexOf('publication:dependency-graph'));
    });
    it('A concurrent first create changes the lock target; only a confirmed rollback permits one retry before effects',async()=>{
        const f=fixture(true);await f.repository.create(input,'main@example.test',f.effects);
        expect(f.query.mock.calls.filter(call=>call[0]==='ROLLBACK')).toHaveLength(1);expect(f.query.mock.calls.filter(call=>call[0]==='COMMIT')).toHaveLength(1);expect(f.effects).toHaveBeenCalledOnce();
    });
    it('An unknown rollback never retries the newly discovered target or calls publication effects',async()=>{
        const f=fixture(true,true);await expect(f.repository.create(input,'main@example.test',f.effects)).rejects.toMatchObject({status:409});
        expect(f.effects).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledExactlyOnceWith(true);expect(f.query.mock.calls.filter(call=>call[0].startsWith('SELECT * FROM ai_plugins WHERE publication_key'))).toHaveLength(1);
    });
    it('An outer transaction keeps ownership and refuses a different planned native identity without another asset wait',async()=>{
        const f=fixture();await expect(f.repository.create(input,'main@example.test',f.effects,f.client,true,'ai-plug-33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({status:409});
        expect(f.effects).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();expect(f.query.mock.calls.some(call=>['BEGIN','COMMIT','ROLLBACK'].includes(call[0]))).toBe(false);
        expect(f.query.mock.calls.some(call=>call[1]?.[0]==='publication:dependency-graph')).toBe(false);
    });
});
