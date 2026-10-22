import {describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {lockBuildPublication,pinBuildPublication,publicationTargetPreview} from '../src/package-build/publication-target';

const card={id:'ai-plug-11111111-1111-4111-8111-111111111111',name:'Existing tool',kind:'mcp',description:'Existing source',version:2,compatibility:null,tags:[],origin:'upload',revision:'source-old',config:null,files:[],dependencies:[],created_at:'old',updated_at:'old'};
const owner={repository:'local-archive',external_id:'tool-old',revision:3,asset_version:'build-old',descriptor_sha256:'a'.repeat(64),native_version:2,native_hash:'b'.repeat(64)};
function fixture(){
    let rows=[{...owner}],native={...card};const release=vi.fn();
    const query=vi.fn(async(sql:string,_params?:unknown[])=>({rows:sql.startsWith('SELECT * FROM ai_plugins')?[native]:sql.startsWith('SELECT repository,external_id')?rows:[]}));
    const client={query,release} as unknown as PoolClient,pool={connect:vi.fn(async()=>client)} as unknown as Pool;
    return {pool,client,query,release,setOwners:(value:typeof rows)=>{rows=value;},setCard:(value:typeof card)=>{native=value;}};
}
describe('Publication consent binds native head and source ownership independently',()=>{
    it('Returns a coherent readonly preview without exposing mutable backend pin instructions',async()=>{
        const f=fixture(),value=await publicationTargetPreview(f.pool,'mcp',card.id);
        expect(value).toMatchObject({catalogId:card.id,name:card.name,description:card.description,expectedVersion:2,updateSupported:true,sourceSummaries:[{repository:'local-archive',externalId:'tool-old',assetVersion:'build-old'}]});
        expect(Object.keys(value).sort()).toEqual(['catalogId','description','expectedSourceHash','expectedVersion','kind','name','sourceSummaries','updateSupported'].sort());
        expect(f.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(f.query.mock.lastCall?.[0]).toBe('COMMIT');
    });
    it('Origin-only revision drift before admission invalidates consent even while native version stays equal',async()=>{
        const f=fixture(),publication=await publicationTargetPreview(f.pool,'mcp',card.id);f.setOwners([{...owner,revision:4}]);
        await expect(pinBuildPublication(f.pool,{kind:'mcp',name:card.name,publication})).rejects.toMatchObject({status:409});
    });
    it('Pins server origins and checks the same full snapshot after asset, graph and row lock waits',async()=>{
        const f=fixture(),publication=await publicationTargetPreview(f.pool,'mcp',card.id),pin=(await pinBuildPublication(f.pool,{kind:'mcp',name:card.name,publication}))!;
        f.query.mockClear();await lockBuildPublication(f.client,pin);
        expect(f.query.mock.calls.slice(0,2).map(call=>call[1])).toEqual([['asset-management:mcp:'+card.id],['publication:dependency-graph']]);
        expect(f.query.mock.calls[2][0]).toContain('FOR UPDATE');expect(f.query.mock.calls[3][0]).toContain('FOR UPDATE');
        f.setOwners([{...owner,descriptor_sha256:'c'.repeat(64)}]);await expect(lockBuildPublication(f.client,pin)).rejects.toMatchObject({status:409});
    });
    it('Head changes and attempts to rename the fixed target do not silently renew approval',async()=>{
        const f=fixture(),publication=await publicationTargetPreview(f.pool,'mcp',card.id);
        await expect(pinBuildPublication(f.pool,{kind:'mcp',name:'Different tool',publication})).rejects.toMatchObject({status:409});
        f.setCard({...card,version:3});await expect(pinBuildPublication(f.pool,{kind:'mcp',name:card.name,publication})).rejects.toMatchObject({status:409});
    });
    it('Preview discards a session with failed rollback and preserves the original failure',async()=>{
        const f=fixture(),primary=Error('Controlled snapshot failure'),query=f.query.getMockImplementation()!;
        f.query.mockImplementation(async sql=>{if(sql.startsWith('SELECT * FROM ai_plugins'))throw primary;if(sql==='ROLLBACK')throw Error('Rollback also failed');return query(sql);});
        await expect(publicationTargetPreview(f.pool,'mcp',card.id)).rejects.toBe(primary);expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('Explicit skill update is rejected before any SQL or native write',async()=>{
        const f=fixture();await expect(pinBuildPublication(f.pool,{kind:'skill',name:'Skill',publication:{catalogId:'common/skill',expectedVersion:1,expectedSourceHash:'a'.repeat(64)}})).rejects.toThrow('пока недоступна');expect(f.query).not.toHaveBeenCalled();
    });
});
