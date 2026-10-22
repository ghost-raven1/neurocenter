import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {PluginRepository,toPlugin} from '../src/publication/plugin-repository';
import {nativeCardHash} from '../src/publication/native-hash';
import {publicationHash} from '../src/publication/publication-validation';
import {publishBuiltTool} from '../src/package-build/publish-built-tool';
import type {BuildRow} from '../src/package-build/package-build.model';
import type {PinnedBuildPublication} from '../src/package-build/publication-target';
import type {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import type {IPreparedLocalAsset} from '../src/asset-sources/local-asset-ingest';
import type {PackageBuildRepository} from '../src/package-build/package-build.repository';

const native={id:'ai-plug-11111111-1111-4111-8111-111111111111',name:'Publication fixture',kind:'mcp',description:'Old source',version:2,compatibility:null,tags:[],origin:'upload',revision:null,config:null,files:[],created_at:'old',updated_at:'old'};
const origin={repository:'local-archive',externalId:'tool-old',revision:3,assetVersion:'build-old',descriptorSha256:'a'.repeat(64),nativeVersion:2,nativeHash:'b'.repeat(64)};
const nativeHash=nativeCardHash(toPlugin(native));
const target:PinnedBuildPublication={catalogId:native.id,name:native.name,kind:'mcp',expectedVersion:2,nativeHash,origins:[origin],expectedSourceHash:publicationHash({nativeHash,origins:[origin]})};
afterEach(()=>vi.restoreAllMocks());
function fixture(){
    let owners=[origin],rollbackFails=false;const events:string[]=[];
    const query=vi.fn(async(sql:string)=>{
        events.push(sql);
        if(sql==='ROLLBACK'&&rollbackFails)throw Error('Rollback failed');
        if(sql.includes('EXTRACT(EPOCH'))return {rows:[{lock_ms:'0',statement_ms:'0'}]};
        return {rows:sql.startsWith('SELECT * FROM ai_plugins')||sql.startsWith('INSERT INTO ai_plugins')?[native]:sql.startsWith('SELECT repository,external_id')?owners.map(value=>({repository:value.repository,external_id:value.externalId,revision:value.revision,asset_version:value.assetVersion,descriptor_sha256:value.descriptorSha256,native_version:value.nativeVersion,native_hash:value.nativeHash})):sql.startsWith('SELECT is_main_admin')?[{is_main_admin:true,enabled:true}]:[]};
    });
    const lease={query} as unknown as PoolClient,pool={} as Pool,recordLocal=vi.fn(async()=>({assetId:'tool-new',sourceVersion:'build-new',sourceSha256:'c'.repeat(64)})),completeWithPublication=vi.fn(async()=>{events.push('build success');}),guard=vi.fn(async()=>{events.push('fresh guard');}),discard=vi.fn();
    const row={id:'22222222-2222-4222-8222-222222222222',actor:'main@example.test',config:{publication:target}} as BuildRow;
    const publication={name:native.name,kind:'mcp' as const,description:'New source',files:[],config:null};
    const prepared={asset:{id:'tool-new'}} as IPreparedLocalAsset;
    const update=vi.spyOn(PluginRepository.prototype,'update').mockImplementation(async(_id,_raw,_actor,finish,client)=>{events.push('native update');const card={...toPlugin(native),version:3};await finish?.(client!,card);return card;});
    const create=vi.spyOn(PluginRepository.prototype,'create');
    const run=()=>publishBuiltTool({pool,lease,sources:{recordLocal} as unknown as AssetSourcesService,repository:{completeWithPublication} as unknown as PackageBuildRepository,row,publication,prepared,guard,discard});
    return {run,lease,query,events,recordLocal,completeWithPublication,guard,discard,update,create,setOwners:(value:typeof owners)=>{owners=value;},failRollback:()=>{rollbackFails=true;}};
}
describe('Explicit build update commits the existing native identity and source as one operation',()=>{
    it('Uses update with expectedVersion, preserves origin consent and saves source plus build receipt on the borrowed transaction',async()=>{
        const f=fixture();await f.run();expect(f.create).not.toHaveBeenCalled();
        expect(f.update).toHaveBeenCalledWith(native.id,expect.objectContaining({expectedVersion:2,description:'New source'}),'main@example.test',expect.any(Function),f.lease,true);
        expect(f.recordLocal).toHaveBeenCalledWith(f.lease,expect.anything(),expect.objectContaining({id:native.id,version:3}),'main@example.test',{replaceOrigins:[{repository:'local-archive',externalId:'tool-old',revision:3}]});
        expect(f.completeWithPublication).toHaveBeenCalledWith(f.lease,expect.any(String),expect.objectContaining({catalogId:native.id,version:3,assetId:'tool-new'}));
        expect(f.events.indexOf('fresh guard')).toBeLessThan(f.events.indexOf('native update'));expect(f.events.at(-1)).toBe('COMMIT');expect(f.discard).not.toHaveBeenCalled();
        expect(f.events.findIndex(sql=>sql.includes('set_config'))).toBeLessThan(f.events.findIndex(sql=>sql.includes('pg_advisory_xact_lock')));
    });
    it('Source-only drift after build prevents every native/source/result mutation',async()=>{
        const f=fixture();f.setOwners([{...origin,revision:4}]);await expect(f.run()).rejects.toMatchObject({status:409});
        expect(f.update).not.toHaveBeenCalled();expect(f.recordLocal).not.toHaveBeenCalled();expect(f.completeWithPublication).not.toHaveBeenCalled();expect(f.events.at(-1)).toBe('ROLLBACK');
    });
    it('Revoked fresh rights after locks prevents update; failed rollback discards the lease and retains the primary error',async()=>{
        const f=fixture(),primary=Error('Rights changed after lock');f.guard.mockRejectedValue(primary);f.failRollback();await expect(f.run()).rejects.toBe(primary);
        expect(f.update).not.toHaveBeenCalled();expect(f.discard).toHaveBeenCalledExactlyOnceWith(f.lease);
    });
    it('A failed final receipt never commits the new head and the primary result failure remains visible',async()=>{
        const f=fixture(),primary=Error('Receipt ACK lost');f.completeWithPublication.mockRejectedValue(primary);await expect(f.run()).rejects.toBe(primary);
        expect(f.events).not.toContain('COMMIT');expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.discard).not.toHaveBeenCalled();
    });
    it('A new tool passes the owned-transaction deadline callback to the real repository create path',async()=>{
        const f=fixture();
        const row={id:'22222222-2222-4222-8222-222222222222',actor:'main@example.test',config:{}} as BuildRow;
        await publishBuiltTool({pool:{} as Pool,lease:f.lease,sources:{recordLocal:f.recordLocal} as unknown as AssetSourcesService,repository:{completeWithPublication:f.completeWithPublication} as unknown as PackageBuildRepository,row,publication:{name:native.name,kind:'mcp',description:'New source',config:{transport:'remote',url:'https://example.test/mcp'}},prepared:{asset:{id:'tool-new'}} as IPreparedLocalAsset,guard:f.guard,discard:f.discard});
        expect(f.create).toHaveBeenCalledOnce();expect(f.events.findIndex(sql=>sql.includes('set_config'))).toBeGreaterThan(f.events.indexOf('BEGIN'));
        expect(f.events.findIndex(sql=>sql.includes('set_config'))).toBeLessThan(f.events.findIndex(sql=>sql.includes('pg_advisory_xact_lock')));
        expect(f.completeWithPublication).toHaveBeenCalledOnce();expect(f.events.at(-1)).toBe('COMMIT');
    });
});
