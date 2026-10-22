import {ConflictException} from '@nestjs/common';
import {assetDigest,serializeAsset,validateAsset,toSkillCreate,type SkillAsset} from '@neurocenter/asset-contract';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {publicationHash} from '../publication/publication-validation';
import {AssetImportRepository} from './import-repository';
import type {IImportItem,ISourceReceipt} from './import-types';
import {SkillAssetAdapter} from './skill-adapter';
import {AssetBlobStore,type IAssetBlob} from './asset-blob-store';
import {validateSkillLinks} from '../../../shared/skill-source.cjs';

export interface IPreparedLocalSkill {asset:SkillAsset;sha256:string;item:IImportItem;blobs:IAssetBlob[]}
/** Stable native intent survives a lost acknowledgement and a new durable build request. */
export function skillPublicationKey(asset:Pick<SkillAsset,'id'|'version'>):string{
    const bytes=createHash('sha256').update('neurocenter-source-asset\0'+asset.id+'\0'+asset.version).digest().subarray(0,16);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** Uses the existing skill publication guard and the same immutable source receipt as tool builds. */
export class LocalSkillIngest {
    constructor(private readonly pool:Pool,private readonly blobs:AssetBlobStore,private readonly adapter=new SkillAssetAdapter()){}
    async prepare(raw:SkillAsset,requestKey:string,sourceFile?:{archivePath:string},options?:{createOnly?:boolean}):Promise<IPreparedLocalSkill>{
        const asset=validateAsset(JSON.parse(JSON.stringify(raw))) as SkillAsset;
        if(asset.kind!=='skill'||asset.dependencies?.length||asset.recipe)throw new ConflictException('Нужен самостоятельный inline skill asset без зависимостей или внешнего рецепта.');
        try{validateSkillLinks(asset.card.body,['SKILL.md',...(asset.card.resources as Array<{path:string}>??[]).map(file=>file.path)]);}catch(error){throw new ConflictException(error instanceof Error?error.message:'Скилл содержит повреждённые ссылки.');}
        const sha256=assetDigest(serializeAsset(asset)),key=skillPublicationKey(asset),nativeId='common/'+asset.card.slug;
        const receipts=(await this.pool.query<ISourceReceipt>('SELECT * FROM asset_source_receipts WHERE asset_kind=$1 AND native_id=$2 AND active',['skill',nativeId])).rows;
        if(receipts.some(row=>row.repository!=='local-archive'||row.external_id!==asset.id))throw new ConflictException('Скилл связан с другим источником. Измените идентификатор или управляйте им в разделе ассетов.');
        const receipt=receipts.find(row=>row.repository==='local-archive'&&row.external_id===asset.id);
        const version=(await this.pool.query<ISourceReceipt>('SELECT * FROM asset_source_versions WHERE repository=$1 AND external_id=$2 AND asset_version=$3',['local-archive',asset.id,asset.version])).rows[0];
        let current;
        try{current=await this.adapter.client.inspect(nativeId);}catch(error){if((error as {getStatus?:()=>number}).getStatus?.()!==404)throw error;}
        if(current&&!receipt&&current.importRequestKey!==key)throw new ConflictException('Путь занят локальным скиллом. Упаковщик не заменяет его без явного решения администратора.');
        // A matching native journal proves the exact prior write even if Catalog lost its COMMIT/ACK.
        const recovered=current?.importRequestKey===key;
        const item=await this.adapter.preview({asset,sha256,path:'assets/'+asset.id+'/'+asset.version+'/asset.json',current:true},key,[],recovered?undefined:receipt,version);
        if(item.action==='conflict')throw new ConflictException(item.reason);
        if(current&&recovered){item.expected=current;item.native=current;item.action='unchanged';}
        if(options?.createOnly&&item.action==='update')throw new ConflictException('Новая версия существующего скилла требует явного подтверждения. Обновление через упаковщик пока недоступно; используйте редактирование скилла в каталоге.');
        const files:Array<IAssetBlob&{archivePath:string}>=[];
        if(asset.source.type==='archive'){
            let archivePath=sourceFile?.archivePath;
            if(!archivePath){try{archivePath=await this.blobs.checkedPath(asset.source.sha256,asset.source.bytes);}catch{throw new ConflictException('Исходные SHA-файлы скилла отсутствуют. Загрузите поставку повторно.');}}
            files.push({archivePath,sha256:asset.source.sha256,bytes:asset.source.bytes,filename:asset.source.sha256+'.source'});
        }else if(sourceFile)throw new ConflictException('Локальный снимок допустим только для archive source.');
        const blobs=await this.blobs.ingestLocal(files,requestKey);
        return {asset,sha256,item,blobs};
    }
    async publish(prepared:IPreparedLocalSkill,actor:string){
        this.check(prepared);
        const native=prepared.item.action==='unchanged'?await this.adapter.client.inspect('common/'+prepared.asset.card.slug):await this.adapter.publish(prepared.item,actor);
        if(prepared.item.action==='unchanged'&&native.hash!==prepared.item.native?.hash)throw new ConflictException('Скилл изменился перед сохранением связи с ассетом.');
        return native;
    }
    async record(client:PoolClient,prepared:IPreparedLocalSkill,native:Awaited<ReturnType<LocalSkillIngest['publish']>>,actor:string){
        this.check(prepared);
        for(const blob of prepared.blobs)await this.blobs.checkedPath(blob.sha256,blob.bytes);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:skill:'+native.id]);
        const current=await this.adapter.client.inspect(native.id);
        if(current.hash!==native.hash||current.version!==native.version)throw new ConflictException('Скилл изменился до сохранения immutable receipt.');
        await new AssetImportRepository(this.pool).recordLocal(client,actor,{...prepared.item,state:'SUCCEEDED',native},prepared.blobs);
        return {assetId:prepared.asset.id,sourceVersion:prepared.asset.version,sourceSha256:prepared.sha256};
    }
    private check(prepared:IPreparedLocalSkill){
        const ordered=(value:Record<string,unknown>)=>({...value,resources:[...(value.resources as Array<{path:string}>??[])].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
        if(assetDigest(serializeAsset(validateAsset(prepared.asset)))!==prepared.sha256||!prepared.item.payload||publicationHash(ordered(toSkillCreate(prepared.asset)))!==publicationHash(ordered(prepared.item.payload)))throw new ConflictException('Подготовленный скилл изменился.');
    }
}
