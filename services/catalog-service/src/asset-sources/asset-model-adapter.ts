import { ConflictException } from '@nestjs/common';
import { toModelRecord, type ModelAsset, type ResolvedAsset } from '@neurocenter/asset-contract';
import type { Pool, PoolClient } from 'pg';
import { publicationHash } from '../publication/publication-validation';
import { validateModelDescriptor, validateModelId } from '../models/model-validation';
import { nextModelRevision, saveModelVersion, type IModelRow } from '../models/model-history';
import { securityEvent } from '../access/security-events';
import type { IImportItem, INativeAssetPin, ISourceReceipt } from './import-types';

export const modelAssetHash=(row:IModelRow):string=>publicationHash({id:row.id,name:row.name,descriptor:row.descriptor,revision:Number(row.revision),archived:!!row.archived_at});
/** Внешняя модель не получает секреты или чужой probe. Source supply edges остаются в immutable receipt. */
export class ModelAssetAdapter {
 constructor(private readonly pool:Pool) {}
 private row(item:IImportItem):IModelRow {
  return {id:item.native!.id,name:String(item.payload!.name),descriptor:validateModelDescriptor(item.payload!.descriptor),revision:item.native!.version,created_at:'',updated_at:''};
 }
 async preview(resolved:ResolvedAsset,key:string,planned:IImportItem[],receipt?:ISourceReceipt,versionReceipt?:ISourceReceipt,overrideHash?:string):Promise<IImportItem>{
  const native=toModelRecord(resolved.asset as ModelAsset),id=validateModelId(receipt?.native_id??native.id),descriptor=validateModelDescriptor(native.descriptor),name=native.name.trim(),payload={id,name,descriptor};
  if(!name||name.length>128){throw new ConflictException('Название модели не поддерживается native-каталогом.');}
  const previous=[...planned].reverse().find(item=>item.resolved.asset.id===resolved.asset.id&&item.native&&item.payload&&!item.preserveHead&&item.action!=='conflict');
  const row=previous?this.row(previous):(await this.pool.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1',[id])).rows[0];
  const base:IImportItem={resolved,requestKey:key,name,action:'create',state:'PENDING',payload};
  if(row?.archived_at){return {...base,action:'conflict',reason:'Модель находится в архиве. Сначала верните её в каталог.'};}
  const approved=!!row&&overrideHash===modelAssetHash(row);
  if(overrideHash&&!approved){return {...base,action:'conflict',reason:'Модель изменилась после подтверждения замены. Проверьте конфликт заново.'};}
  if(receipt&&resolved.current&&!previous&&!approved&&(!row||modelAssetHash(row)!==receipt.native_hash)){
   return {...base,action:'conflict',expected:row?this.pin(row):undefined,replaceable:!!row,reason:'Карточка модели изменена локально. Можно сохранить её или явно заменить источником; существующие project pins сохранятся.'};
  }
  if(versionReceipt&&!approved){
   if(versionReceipt.descriptor_sha256!==resolved.sha256||!row||versionReceipt.native_id!==id){return {...base,action:'conflict',reason:'Версия источника связана с другим неизменяемым снимком модели.'};}
   const old=(await this.pool.query<IModelRow>('SELECT model_id AS id,name,descriptor,revision,created_at,updated_at FROM model_catalog_versions WHERE model_id=$1 AND revision=$2',[id,versionReceipt.native_version])).rows[0];
   if(!old||modelAssetHash(old)!==versionReceipt.native_hash){return {...base,action:'conflict',reason:'Исторический снимок модели не совпадает с квитанцией.'};}
   return {...base,action:'unchanged',preserveHead:true,native:this.pin(old)};
  }
  const same=row&&publicationHash({name:row.name,descriptor:row.descriptor})===publicationHash({name,descriptor});
  if(row&&!receipt&&!previous&&!same&&!approved){return {...base,action:'conflict',expected:this.pin(row),replaceable:resolved.current,reason:'ID модели занят локальной карточкой. Доступна явная замена содержимым источника.'};}
  const maximum=row?Number((await this.pool.query<{v:number}>('SELECT COALESCE(MAX(revision),0) AS v FROM model_catalog_versions WHERE model_id=$1',[id])).rows[0]?.v??0):0;
  const plannedMaximum=Math.max(maximum,...planned.filter(item=>item.native?.id===id&&item.native.kind==='model').map(item=>item.native!.version)),version=row?(same?Number(row.revision):Math.max(Number(row.revision),plannedMaximum)+1):1;
  const snapshot=!!row&&!resolved.current&&!same,candidate={id,name,descriptor,revision:version,created_at:'',updated_at:''};
  return {...base,action:row?(same?'unchanged':snapshot?'snapshot':'update'):'create',preserveHead:snapshot,replacesLocal:approved,expected:row?this.pin(row):undefined,native:this.pin(candidate)};
 }
 async publish(item:IImportItem,actor:string,client:PoolClient):Promise<INativeAssetPin>{
  if(!item.payload||!item.native||item.action==='conflict'){throw new ConflictException('План не разрешает публикацию модели.');}
  const {id,name}=item.payload,descriptor=validateModelDescriptor(item.payload.descriptor);
  const lock=await client.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended('neurocenter:model-hosting',0)) AS locked");
  if(!lock.rows[0]?.locked){throw new ConflictException('Дождитесь завершения операции хостинга модели.');}
  const row=(await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(item.action==='unchanged'&&item.preserveHead){
   const old=(await client.query<IModelRow>('SELECT model_id AS id,name,descriptor,revision,created_at,updated_at FROM model_catalog_versions WHERE model_id=$1 AND revision=$2',[id,item.native.version])).rows[0];
   if(!old||modelAssetHash(old)!==item.native.hash){throw new ConflictException('Исторический снимок модели изменился.');}return this.pin(old);
  }
  if(item.expected?(!row||this.pin(row).hash!==item.expected.hash):!!row){throw new ConflictException('Карточка модели изменилась после предварительного просмотра.');}
  if(item.action==='unchanged'){return this.pin(row);}
  if(row){
   const next=await nextModelRevision(client,String(id),Number(row.revision));
   if(next!==item.native.version){throw new ConflictException('История модели изменилась после предварительного просмотра.');}await saveModelVersion(client,row);
   if(item.action==='snapshot'){
    const historical={...row,name:String(name),descriptor,revision:next,archived_at:null};await saveModelVersion(client,historical);
    await securityEvent(client,{actor,action:'model.snapshot',resourceId:String(id),before:{head:row.revision},after:{head:row.revision,snapshot:next}});return this.pin(historical);
   }
  }
  const saved=row?await client.query<IModelRow>('UPDATE model_catalog SET name=$2,descriptor=$3::jsonb,revision=$4,updated_at=now() WHERE id=$1 RETURNING *',[id,name,JSON.stringify(descriptor),item.native.version])
   :await client.query<IModelRow>('INSERT INTO model_catalog(id,name,descriptor,revision) VALUES($1,$2,$3::jsonb,1) RETURNING *',[id,name,JSON.stringify(descriptor)]);
  if(!saved.rows[0]){throw new ConflictException('База не подтвердила карточку модели.');}await saveModelVersion(client,saved.rows[0]);
  await securityEvent(client,{actor,action:'model.import',resourceId:String(id),before:row?{hash:modelAssetHash(row)}:null,after:{hash:modelAssetHash(saved.rows[0])}});return this.pin(saved.rows[0]);
 }
 pin(row:IModelRow):INativeAssetPin{return {kind:'model',id:row.id,version:Number(row.revision),hash:modelAssetHash(row)};}
}
