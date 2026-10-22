import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {toSkillCreate,validateAsset,type ResolvedAsset,type SkillAsset} from '@neurocenter/asset-contract';
import {LocalSkillIngest,skillPublicationKey} from '../src/asset-sources/local-skill-ingest';
import type {SkillAssetAdapter} from '../src/asset-sources/skill-adapter';
import type {AssetBlobStore} from '../src/asset-sources/asset-blob-store';

const asset=validateAsset({schemaVersion:1,id:'skill-existing',kind:'skill',version:'source-next',source:{type:'git',repository:'https://github.com/fixture/skills',commit:'a'.repeat(40)},license:{spdx:'NOASSERTION'},compatibility:{packageFormat:5},card:{path:'common',slug:'existing',name:'Existing skill',body:'New instruction',meta:{description:'A managed fixture skill'},resources:[]},delivery:{type:'inline'}}) as SkillAsset;
function fixture(recovered=false){
    const current={kind:'skill',id:'common/existing',version:2,hash:'b'.repeat(64),...(recovered?{importRequestKey:skillPublicationKey(asset)}:{})};
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('AND active')?[{repository:'local-archive',external_id:asset.id,native_id:current.id,native_hash:current.hash,asset_kind:'skill'}]:[]}));
    const preview=vi.fn(async(resolved:ResolvedAsset,requestKey:string)=>({resolved,requestKey,name:asset.card.name,action:'update',state:'PENDING',payload:toSkillCreate(asset),expected:current,native:current}));
    const ingestLocal=vi.fn(async()=>[]),adapter={client:{inspect:vi.fn(async()=>current)},preview} as unknown as SkillAssetAdapter;
    return {ingest:new LocalSkillIngest({query} as unknown as Pool,{ingestLocal} as unknown as AssetBlobStore,adapter),preview,ingestLocal};
}
describe('The packager must not silently update an existing skill by slug',()=>{
    it('Create-only packaging rejects a changed managed skill before retaining bytes or writing native state',async()=>{
        const f=fixture();await expect(f.ingest.prepare(asset,randomUUID(),undefined,{createOnly:true})).rejects.toThrow('Новая версия');
        expect(f.ingestLocal).not.toHaveBeenCalled();
    });
    it('The generic explicit import keeps its existing update contract',async()=>{
        const f=fixture();expect((await f.ingest.prepare(asset,randomUUID())).item.action).toBe('update');
    });
    it('An exact native journal recovers the same write even in create-only packaging',async()=>{
        const f=fixture(true);expect((await f.ingest.prepare(asset,randomUUID(),undefined,{createOnly:true})).item.action).toBe('unchanged');
    });
});
