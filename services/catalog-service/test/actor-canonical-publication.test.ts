import {ForbiddenException} from '@nestjs/common';
import {assetDigest,serializeAsset,validateAsset} from '@neurocenter/asset-contract';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {authorizeImportActor} from '../src/asset-sources/import-worker';
import type {IImportItem,INativeAssetPin} from '../src/asset-sources/import-types';
import {SkillAssetAdapter,SkillAssetClient} from '../src/asset-sources/skill-adapter';

const canonical='main@example.test';
const actors=[canonical,'Main@EXAMPLE.test',' Main@example.test '] as const;
const invalidActors=[
    ['empty',''],['missing-at','not-an-email'],['internal-space','main user@example.test'],
    ['too-long','a'.repeat(242)+'@example.test'],['null',null],['undefined',undefined],['number',42],['object',{}],
] as const;
const lookup='SELECT is_main_admin,enabled FROM platform_users WHERE email=$1';
const settled=<T>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));

/** The SQL double matches only the stored canonical key; no query-side case folding hides the regression. */
function database(account:{is_main_admin:boolean;enabled:boolean}|null={is_main_admin:true,enabled:true}){
    const query=vi.fn(async(_sql:string,values?:unknown[])=>({rows:values?.[0]===canonical&&account?[account]:[]}));
    return {query,client:{query} as unknown as Pick<PoolClient,'query'>};
}

const asset=validateAsset({schemaVersion:1,id:'skill-canonical-actor',kind:'skill',version:'source-v1',source:{type:'git',repository:'https://github.com/fixture/skills',commit:'a'.repeat(40)},license:{spdx:'NOASSERTION'},compatibility:{packageFormat:5},card:{path:'common',slug:'canonical-actor',name:'Canonical actor',body:'Owned fixture',meta:{description:'Actor boundary'},resources:[]},delivery:{type:'inline'}});
function nativeFixture(){
    vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','owned-actor-unit-token');
    vi.stubEnv('SKILLS_SERVICE_URL','http://skills.fixture');
    const native:INativeAssetPin={kind:'skill',id:'common/canonical-actor',version:2,hash:'b'.repeat(64)};
    const request=vi.fn<typeof fetch>(async()=>Response.json(native));
    const item:IImportItem={resolved:{asset,sha256:assetDigest(serializeAsset(asset)),path:'assets/actor/source-v1/asset.json',current:true},requestKey:randomUUID(),name:asset.card.name,action:'update',state:'PENDING',payload:{slug:'canonical-actor',body:'Owned fixture'},expected:{kind:'skill',id:native.id,version:1,hash:'a'.repeat(64)}};
    return {adapter:new SkillAssetAdapter(new SkillAssetClient(request)),request,native,item};
}
afterEach(()=>vi.unstubAllEnvs());

describe('Canonical privilege lookup preserves the supplied durable actor',()=>{
    for(const lock of [false,true]){
        it.each(actors)('looks up the canonical account for %j with lock='+lock,async raw=>{
            const f=database(),intent={actor:raw,requestKey:randomUUID()},before=structuredClone(intent);
            const result=await settled(authorizeImportActor(f.client,intent.actor,lock));
            expect(f.query).toHaveBeenCalledExactlyOnceWith(lookup+(lock?' FOR SHARE':''),[canonical]);
            expect(result).toEqual({ok:true,value:undefined});
            expect(intent).toEqual(before);
        });
    }
    it.each([
        ['revoked',{is_main_admin:false,enabled:true}],['disabled',{is_main_admin:true,enabled:false}],['missing',null],
    ] as const)('still rejects a %s canonical account under its row lock',async(_label,account)=>{
        const f=database(account);
        await expect(authorizeImportActor(f.client,canonical,true)).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.query).toHaveBeenCalledExactlyOnceWith(lookup+' FOR SHARE',[canonical]);
    });
    it.each(invalidActors)('rejects malformed actor %s before sending any SQL',async(_label,value)=>{
        const f=database();
        // Exercise the existing JavaScript runtime boundary without widening the production string signature.
        const result=await settled(Reflect.apply(authorizeImportActor,undefined,[f.client,value,true]) as Promise<void>);
        expect(f.query).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        if(!result.ok)expect(result.error).toBeInstanceOf(ForbiddenException);
    });
});

describe('Native skill publication canonicalizes only its outbound actor',()=>{
    it.each(actors)('sends canonical actor for %j while preserving request, payload and CAS data',async raw=>{
        const f=nativeFixture(),intent={actor:raw,requestKey:f.item.requestKey,item:f.item},before=structuredClone(intent);
        expect(await f.adapter.publish(intent.item,intent.actor)).toEqual(f.native);
        expect(f.request).toHaveBeenCalledOnce();
        const [url,options]=f.request.mock.calls[0];
        expect(url).toBe('http://skills.fixture/internal/asset-sources/skills/publish');
        expect(JSON.parse(String(options?.body))).toEqual({input:before.item.payload,requestKey:before.requestKey,actor:canonical,expected:{id:before.item.expected!.id,version:before.item.expected!.version,hash:before.item.expected!.hash}});
        expect(intent).toEqual(before);
    });
    it.each(invalidActors)('rejects malformed native actor %s before dispatch',async(_label,value)=>{
        const f=nativeFixture(),before=structuredClone(f.item);
        const result=await settled(Reflect.apply(f.adapter.publish,f.adapter,[f.item,value]) as Promise<INativeAssetPin>);
        expect(f.request).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        if(!result.ok)expect(result.error).toBeInstanceOf(ForbiddenException);
        expect(f.item).toEqual(before);
    });
});
