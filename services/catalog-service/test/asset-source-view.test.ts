import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ISourceReceipt} from '../src/asset-sources/import-types';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {SkillAssetClient} from '../src/asset-sources/skill-adapter';
import {assetDigest,serializeAsset,type ResolvedAsset,type ToolAsset,type SkillAsset} from '@neurocenter/asset-contract';

function record(id:string,repository='local-archive',active=true):ISourceReceipt {
    const descriptor:ToolAsset={schemaVersion:1,id,version:'1.0.0',kind:'plugin',source:{type:'git',repository:'https://github.com/example/fixture',commit:'a'.repeat(40)},license:{spdx:'MIT'},compatibility:{packageFormat:5},card:{kind:'plugin',name:'Карточка '+id,description:'Описание '+id,revision:'1.0.0',origin:'upload',tags:[],files:[],config:{entrypoint:'index.mjs'}},delivery:{type:'runtime-artifacts',artifacts:[]}};
    return {repository,active,external_id:id,asset_kind:'plugin',asset_version:'1.0.0',descriptor_sha256:assetDigest(serializeAsset(descriptor)),source_commit:repository==='local-archive'?null:'a'.repeat(40),native_id:'native-'+id,native_version:1,native_hash:'b'.repeat(64),descriptor,blobs:[]};
}
const repository='ghost-raven1/neurocenter-assets';
let local:ISourceReceipt[],remote:ISourceReceipt[],records:ResolvedAsset[],snapshot:boolean,error:string;
const query=vi.fn(),receipts=vi.fn();
function service():AssetSourcesService {
    const view=Object.create(AssetSourcesService.prototype) as AssetSourcesService;
    return Object.assign(view,{pool:{query},sources:{status:async()=>({snapshot:snapshot?{pin:{repository,commit:'a'.repeat(40)},assets:records,checked_at:'2026-10-21T00:00:00Z'}:undefined,last:{message:error}})},jobs:{receipts}});
}
beforeEach(()=>{
    local=[record('local')];remote=[];records=[];snapshot=true;error='';
    query.mockReset().mockResolvedValue({rows:[{archived_at:null}]});
    receipts.mockReset().mockImplementation(async(value:string)=>value==='local-archive'?local:remote);
});
afterEach(()=>vi.restoreAllMocks());

it('Локальные актуальные упаковки видны без внешнего snapshot и не становятся выбором для source-import',async()=>{
    snapshot=false;error='GitHub временно недоступен';local.push(record('old','local-archive',false));
    const data=await service().view();
    expect(data.source.verified).toBe(false);expect(data.source.error).toBe(error);expect(data.assets).toEqual([]);
    expect(data.localAssets).toHaveLength(1);expect(data.localAssets[0]).toMatchObject({id:'local',name:'Карточка local',imported:{id:'native-local',archived:false,unavailable:false,updateAvailable:false}});
    expect(receipts).toHaveBeenCalledExactlyOnceWith('local-archive');
    expect(JSON.stringify(data)).not.toContain('entrypoint');expect(JSON.stringify(data)).not.toContain('https://github.com/example/fixture');
});
it('Совпадающие external IDs двух источников сохраняют отдельные native-состояния',async()=>{
    local=[record('same')];remote=[record('same',repository)];remote[0].native_id='remote-native';
    records=[{asset:remote[0].descriptor,sha256:remote[0].descriptor_sha256,path:'assets/same/1.0.0/asset.json',current:true}];
    query.mockImplementation(async(_sql:string,params:string[])=>({rows:[{archived_at:params[0]==='native-same'?'2026-10-21':null}]}));
    const data=await service().view();expect(data.assets[0].imported).toMatchObject({id:'remote-native',archived:false});expect(data.localAssets[0].imported).toMatchObject({id:'native-same',archived:true});
});
it('Неактивный прежний источник не притворяется владельцем принятой локальной карточки',async()=>{
    remote=[record('adopted',repository,false)];records=[{asset:remote[0].descriptor,sha256:remote[0].descriptor_sha256,path:'assets/adopted/1.0.0/asset.json',current:true}];
    const data=await service().view();expect(data.assets[0].imported).toBeUndefined();expect(data.localAssets[0].imported?.id).toBe('native-local');
});
it('Отсутствующая native карточка отмечена недоступной, остальные упаковки остаются видны',async()=>{
    local.push(record('missing'));query.mockImplementation(async(_sql:string,params:string[])=>({rows:params[0]==='native-missing'?[]:[{archived_at:null}]}));
    const data=await service().view();expect(data.localAssets[0].imported?.unavailable).toBe(false);expect(data.localAssets[1].imported?.unavailable).toBe(true);
});
it('Отказ сервиса скиллов не скрывает другие локальные упаковки',async()=>{
    const descriptor:SkillAsset={schemaVersion:1,id:'skill-fixture',version:'1.0.0',kind:'skill',source:{type:'git',repository:'https://github.com/example/fixture',commit:'a'.repeat(40)},license:{spdx:'MIT'},compatibility:{packageFormat:5},card:{path:'common',slug:'fixture',name:'Локальный скилл',body:'Инструкция',meta:{description:'Полезная инструкция'},resources:[]},delivery:{type:'inline'}};
    local.push({...record(descriptor.id),asset_kind:'skill',native_id:'common/fixture',descriptor,descriptor_sha256:assetDigest(serializeAsset(descriptor))});
    vi.spyOn(SkillAssetClient.prototype,'inspect').mockRejectedValue(new Error('Service unavailable'));
    const data=await service().view();expect(data.localAssets).toHaveLength(2);expect(data.localAssets[0].imported?.unavailable).toBe(false);expect(data.localAssets[1]).toMatchObject({kind:'skill',name:'Локальный скилл',description:'Полезная инструкция',imported:{unavailable:true}});
});
it('Текущие имя и видимость native-карточки не переписывают immutable descriptor',async()=>{
    query.mockResolvedValue({rows:[{name:'Переименованная карточка',archived_at:null}]});const data=await service().view();
    expect(data.localAssets[0].name).toBe('Карточка local');expect(data.localAssets[0].imported?.name).toBe('Переименованная карточка');expect(local[0].descriptor.card.name).toBe('Карточка local');
});
