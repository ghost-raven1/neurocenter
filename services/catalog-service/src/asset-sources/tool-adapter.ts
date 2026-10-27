import { ConflictException } from '@nestjs/common';
import { toToolPublication, type DependencyContext, type ResolvedAsset, type ToolAsset } from '@neurocenter/asset-contract';
import type { Pool, PoolClient } from 'pg';
import type { IAiPlugin, IAiPluginCreate } from '../catalog/dto';
import { buildPackage } from '../catalog/bundle-package';
import { assertInstallablePackage } from '../devices/installation-set';
import { PluginRepository, toPlugin } from '../publication/plugin-repository';
import { publicationHash, validatePublication } from '../publication/publication-validation';
import { nativeCardHash } from '../publication/native-hash';
import type { IImportItem, INativeAssetPin, ISourceReceipt } from './import-types';

export const assetKey=(value:ResolvedAsset):string=>value.asset.id+'@'+value.asset.version;
/** Native pins берутся из exact source tuple, включая historical source revision. */
export function importDependencyContext(asset:ResolvedAsset['asset'],planned:IImportItem[]):DependencyContext {
    return {dependencies:(asset.dependencies??[]).map(dependency=>{
        const item=planned.find(candidate=>candidate.resolved.asset.id===dependency.id&&candidate.resolved.asset.version===dependency.version&&candidate.resolved.sha256===dependency.sha256);
        const native=item?.native;
        if(!item||item.action==='conflict'||!native||!['mcp','plugin'].includes(native.kind)||!native.manifest){throw new ConflictException('Зависимость не имеет точного MCP/плагин-снимка: '+dependency.id+'@'+dependency.version);}
        return {...dependency,kind:native.kind as 'mcp'|'plugin',native:{id:native.id,kind:native.kind as 'mcp'|'plugin',version:native.version,manifest:native.manifest}};
    })};
}
export function toolPublication(plugin:IAiPlugin):IAiPluginCreate {
    return validatePublication({name:plugin.name,kind:plugin.kind,description:plugin.description,tags:plugin.tags,origin:plugin.origin,
        revision:plugin.revision,compatibility:plugin.compatibility,files:plugin.files,config:plugin.config,dependencies:plugin.dependencies});
}
/** Preview хеширует те же normalized поля, что native SQL serializer. Время не участвует. */
export function plannedToolCard(id:string,version:number,publication:IAiPluginCreate):IAiPlugin {
    return {id,name:publication.name,kind:publication.kind,description:publication.description,tags:publication.tags??[],origin:publication.origin??'',
        revision:publication.revision??null,compatibility:publication.compatibility??null,files:publication.files??[],config:publication.config??null,
        version,createdAt:'',updatedAt:'',...(publication.dependencies?.length?{dependencies:publication.dependencies}:{})};
}
export function toolNativePin(id:string,version:number,publication:IAiPluginCreate,hash:string):INativeAssetPin {
    const dependencies=publication.dependencies??[],config=dependencies.length?{...publication.config,extra:{...publication.config?.extra,requirements:{mcp:[],plugins:[],dependencies}}}:publication.config;
    const pkg=buildPackage({id,name:publication.name,kind:publication.kind,version},(publication.files??[]).map(file=>({path:file.path,content:file.content??''})),'',config);
    assertInstallablePackage(pkg);return {kind:publication.kind,id,version,hash,manifest:pkg.manifest.sha256};
}
export class ToolAssetAdapter {
    private readonly repository:PluginRepository;
    constructor(private readonly pool:Pool){this.repository=new PluginRepository(pool);}
    async preview(resolved:ResolvedAsset,requestKey:string,planned:IImportItem[],receipt?:ISourceReceipt,versionReceipt?:ISourceReceipt,overrideHash?:string):Promise<IImportItem> {
        const asset=resolved.asset as ToolAsset,publication=validatePublication(toToolPublication(asset,importDependencyContext(asset,planned)));
        const base:IImportItem={resolved,requestKey,name:publication.name,action:'create',state:'PENDING',publication};
        const previous=[...planned].reverse().find(item=>item.resolved.asset.id===asset.id&&!item.preserveHead&&item.native&&item.action!=='conflict');
        let current=previous?.publication&&previous.native?plannedToolCard(previous.native.id,previous.native.version,previous.publication):await this.repository.get(receipt?.native_id??publication.name);
        // Native name is an installation key and part of historical package hashes; the source title remains in base.name.
        if(current){publication.name=current.name;}
        const approved=!!current&&overrideHash===nativeCardHash(current);
        if(overrideHash&&!approved){return {...base,action:'conflict',reason:'Локальная карточка изменилась после подтверждения замены. Проверьте конфликт заново.'};}
        if(receipt&&resolved.current&&!previous&&!approved&&(!current||receipt.asset_kind!==asset.kind||current.id!==receipt.native_id||nativeCardHash(current)!==receipt.native_hash)){
            return {...base,action:'conflict',expected:current?this.pin(current):undefined,replaceable:!!current&&current.kind===asset.kind&&resolved.current,reason:'Локальная карточка изменена после импорта. Можно сохранить её или явно заменить содержимым источника; история и pins проектов сохранятся.'};
        }
        if(current&&(await this.pool.query('SELECT archived_at FROM ai_plugins WHERE id=$1',[current.id])).rows[0]?.archived_at){return {...base,action:'conflict',reason:'Карточка находится в архиве. Сначала верните её в каталог.'};}
        if(versionReceipt&&!approved){
            if(versionReceipt.descriptor_sha256!==resolved.sha256||!current||versionReceipt.native_id!==current.id){return {...base,action:'conflict',reason:'Опись опубликованной версии источника изменилась.'};}
            const historic=await this.repository.version(current.id,versionReceipt.native_version);
            if(!historic){return {...base,action:'conflict',reason:'Неизменяемый native-снимок отсутствует. Импорт не может подменить его текущей версией.'};}
            const candidate=plannedToolCard(current.id,historic.version,validatePublication({...toolPublication(current),...historic.metadata,files:historic.files,config:historic.config}));
            const native=this.pin(candidate);
            if(native.hash!==versionReceipt.native_hash||native.manifest!==versionReceipt.native_manifest){return {...base,action:'conflict',reason:'Сохранённый native-снимок не совпадает с квитанцией источника.'};}
            return {...base,action:'unchanged',native,preserveHead:true};
        }
        if(current&&current.kind!==asset.kind||current&&!receipt&&!previous&&!approved&&publicationHash(toolPublication(current))!==publicationHash(publication)){
            return {...base,action:'conflict',expected:current?this.pin(current):undefined,replaceable:!!current&&current.kind===asset.kind&&resolved.current,reason:'Название занято локальной карточкой. Её можно сохранить или явно заменить содержимым источника.'};
        }
        const unchanged=current&&publicationHash(toolPublication(current))===publicationHash(publication);
        const snapshot=!!current&&!resolved.current&&!unchanged;
        const maximum=current?Number((await this.pool.query<{v:number}>('SELECT COALESCE(MAX(version),0) AS v FROM ai_plugin_versions WHERE ai_plugin_id=$1',[current.id])).rows[0]?.v??0):0;
        const plannedMaximum=Math.max(maximum,...planned.filter(item=>item.native?.id===current?.id).map(item=>item.native!.version));
        const version=current?(unchanged?current.version:Math.max(current.version,plannedMaximum)+1):1,id=current?.id??'ai-plug-'+requestKey;
        const candidate=plannedToolCard(id,version,publication);
        return {...base,replacesLocal:approved,action:current?(unchanged?'unchanged':snapshot?'snapshot':'update'):'create',preserveHead:snapshot,
            expected:current?this.pin(current):undefined,native:this.pin(candidate)};
    }
    /** SQL native version + source receipt + item-state используют один borrowed transaction. */
    async publish(item:IImportItem,actor:string,client:PoolClient,committed:(card:IAiPlugin)=>Promise<void>):Promise<void> {
        const publication=validatePublication(item.publication),repository=new PluginRepository(this.pool);
        if(!item.native||item.action==='conflict'){throw new ConflictException('План не разрешает публикацию.');}
        if(item.action==='unchanged'&&item.preserveHead){
            const previous=await repository.version(item.native.id,item.native.version),head=await repository.get(item.native.id);
            if(!previous||!head){throw new ConflictException('Снимок зависимости больше не доступен.');}
            const card=plannedToolCard(head.id,previous.version,validatePublication({...toolPublication(head),...previous.metadata,files:previous.files,config:previous.config}));
            if(this.pin(card).hash!==item.native.hash){throw new ConflictException('Снимок зависимости изменился.');}await committed(card);return;
        }
        if(item.expected){
            const found=await client.query('SELECT * FROM ai_plugins WHERE id=$1 FOR UPDATE',[item.expected.id]);
            const current=found.rows[0]?toPlugin(found.rows[0]):null;
            if(!current||nativeCardHash(current)!==item.expected.hash){throw new ConflictException('Карточка изменилась после предварительного просмотра.');}
            if(item.action==='unchanged'){await committed(current);return;}
            if(item.action==='snapshot'){await repository.snapshot(item.native.id,publication,actor,item.native.version,item.expected.hash,client,committed);return;}
            const {name:_name,version:_version,publicationKey:_key,...changes}=publication;
            const saved=await repository.update(current.id,{...changes,expectedVersion:current.version},actor,undefined,client,true);
            if(!saved){throw new ConflictException('Карточка удалена во время импорта.');}await committed(saved);
        }else{await repository.create({...publication,publicationKey:item.requestKey},actor,async(_lease,card)=>committed(card),client,true,item.native.id);}
    }
    pin(card:IAiPlugin):INativeAssetPin{return toolNativePin(card.id,card.version,toolPublication(card),nativeCardHash(card));}
}
