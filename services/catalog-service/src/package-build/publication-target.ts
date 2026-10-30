import {BadRequestException,ConflictException,NotFoundException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import {toPlugin} from '../publication/plugin-repository';
import {nativeCardHash} from '../publication/native-hash';
import {publicationHash} from '../publication/publication-validation';
import {SkillAssetClient} from '../asset-sources/skill-adapter';
import type {IAiPlugin} from '../catalog/dto';

export interface BuildPublicationTarget {catalogId:string;expectedVersion:number;expectedSourceHash:string}
export interface BuildSourceOrigin {repository:string;externalId:string;revision:number;assetVersion:string;descriptorSha256:string;nativeVersion:number;nativeHash:string}
export interface PinnedBuildPublication extends BuildPublicationTarget {kind:'mcp'|'plugin';name:string;nativeHash:string;origins:BuildSourceOrigin[]}
export interface BuildPublicationTargetPreview extends BuildPublicationTarget {name:string;description:string;kind:'mcp'|'plugin'|'skill';sourceSummaries:Array<{repository:string;externalId:string;assetVersion:string}>;updateSupported:boolean;unsupportedReason?:string}
export const unsupportedSkillUpdate='Новая версия скилла через упаковщик пока недоступна. Сохраните исходники и используйте редактирование скилла в каталоге.';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validCatalogId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=240&&!/[\x00-\x1f\x7f]/.test(value);

/** The public consent contains no caller-controlled origin replacement instructions. */
export function validateBuildPublication(value:unknown):BuildPublicationTarget|undefined{
    if(value===undefined)return;
    if(!object(value)||Object.keys(value).some(key=>!['catalogId','expectedVersion','expectedSourceHash'].includes(key))||!validCatalogId(value.catalogId)
        ||!Number.isSafeInteger(value.expectedVersion)||Number(value.expectedVersion)<1||typeof value.expectedSourceHash!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedSourceHash))throw new BadRequestException('Выберите актуальную карточку и подтвердите создание новой версии.');
    return {catalogId:value.catalogId,expectedVersion:Number(value.expectedVersion),expectedSourceHash:value.expectedSourceHash};
}

/** A create intent never implicitly approves replacement of an existing native card. */
export async function assertBuildCreateName(pool:Pool,input:{kind:string;name:string;publication?:BuildPublicationTarget}):Promise<void>{
    if(input.publication||input.kind==='skill')return;
    if((await pool.query('SELECT id FROM ai_plugins WHERE lower(name)=lower($1)',[input.name])).rows.length)throw new ConflictException('Инструмент с таким названием уже существует. Откройте «Новая версия» в его карточке или выберите другое имя; исходники сохранены.');
}

async function origins(db:Pick<PoolClient,'query'>,kind:string,id:string,lock=false):Promise<BuildSourceOrigin[]>{
    const {rows}=await db.query(`SELECT repository,external_id,revision,asset_version,descriptor_sha256,native_version,native_hash FROM asset_source_receipts WHERE asset_kind=$1 AND native_id=$2 AND active ORDER BY repository,external_id${lock?' FOR UPDATE':''}`,[kind,id]);
    return rows.map(row=>({repository:String(row.repository),externalId:String(row.external_id),revision:Number(row.revision),assetVersion:String(row.asset_version),descriptorSha256:String(row.descriptor_sha256),nativeVersion:Number(row.native_version),nativeHash:String(row.native_hash)}));
}
const sourceHash=(nativeHash:string,owners:BuildSourceOrigin[])=>publicationHash({nativeHash,origins:owners});

/** Caller holds the asset lock before the dependency graph and native row locks. */
async function toolSnapshot(db:Pick<PoolClient,'query'>,kind:'mcp'|'plugin',id:string,lock=false):Promise<{card:IAiPlugin;pin:PinnedBuildPublication}>{
    const {rows}=await db.query('SELECT * FROM ai_plugins WHERE id=$1 AND kind=$2'+(lock?' FOR UPDATE':''),[id,kind]);
    if(!rows[0])throw new NotFoundException('Карточка инструмента не найдена.');
    if(rows[0].archived_at)throw new ConflictException('Карточка находится в архиве. Сначала верните её в каталог.');
    const card=toPlugin(rows[0]),owners=await origins(db,kind,id,lock),nativeHash=nativeCardHash(card);
    return {card,pin:{catalogId:id,kind,name:card.name,expectedVersion:card.version,nativeHash,origins:owners,expectedSourceHash:sourceHash(nativeHash,owners)}};
}

async function readToolSnapshot(pool:Pool,kind:'mcp'|'plugin',id:string){
    const client=await pool.connect();let tainted=false;
    try{
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const snapshot=await toolSnapshot(client,kind,id);await client.query('COMMIT');return snapshot;
    }catch(error){try{await client.query('ROLLBACK');}catch{tainted=true;}throw error;}finally{if(tainted)client.release(true);else client.release();}
}

/** Automatic rebuild may replace only a head that still exactly matches its managed source receipt. */
export async function managedRebuildPublication(pool:Pool,kind:'mcp'|'plugin',id:string,sourceId:string):Promise<{name:string;publication:BuildPublicationTarget}>{
    const {card,pin}=await readToolSnapshot(pool,kind,id);
    if(!pin.origins.some(origin=>origin.externalId===sourceId)||pin.origins.some(origin=>origin.nativeVersion!==card.version||origin.nativeHash!==pin.nativeHash))
        throw new ConflictException('Управляемая карточка изменена вручную. Подтвердите новую версию в каталоге.');
    return {name:card.name,publication:{catalogId:id,expectedVersion:pin.expectedVersion,expectedSourceHash:pin.expectedSourceHash}};
}

/** Preview is one repeatable SQL snapshot; refreshing it never approves a write. */
export async function publicationTargetPreview(pool:Pool,kind:unknown,id:unknown):Promise<BuildPublicationTargetPreview>{
    if(!['mcp','plugin','skill'].includes(String(kind))||!validCatalogId(id))throw new BadRequestException('Выберите карточку общего каталога.');
    if(kind==='skill'){
        if(!/^common\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))throw new BadRequestException('Выберите общий скилл.');
        const native=await new SkillAssetClient().inspect(id),owners=await origins(pool,'skill',id);
        return {catalogId:id,name:native.name??id,description:'',kind:'skill',expectedVersion:native.version,expectedSourceHash:sourceHash(native.hash,owners),sourceSummaries:owners.map(({repository,externalId,assetVersion})=>({repository,externalId,assetVersion})),updateSupported:false,unsupportedReason:unsupportedSkillUpdate};
    }
    const {card,pin}=await readToolSnapshot(pool,kind as 'mcp'|'plugin',id);
    return {catalogId:id,name:card.name,description:card.description,kind:pin.kind,expectedVersion:pin.expectedVersion,expectedSourceHash:pin.expectedSourceHash,sourceSummaries:pin.origins.map(({repository,externalId,assetVersion})=>({repository,externalId,assetVersion})),updateSupported:true};
}

/** Pins are prepared by the server, then checked again inside enqueue and publication. */
export async function pinBuildPublication(pool:Pool,input:{publication?:BuildPublicationTarget;kind:string;name:string}):Promise<PinnedBuildPublication|undefined>{
    if(!input.publication)return;
    if(input.kind==='skill')throw new BadRequestException(unsupportedSkillUpdate);
    const {pin}=await readToolSnapshot(pool,input.kind as 'mcp'|'plugin',input.publication.catalogId);
    if(pin.expectedVersion!==input.publication.expectedVersion||pin.expectedSourceHash!==input.publication.expectedSourceHash||pin.name!==input.name)throw new ConflictException('Карточка или её источник изменились. Проверьте новую версию и подтвердите её заново; исходники сохранены.');
    return pin;
}

export async function lockBuildPublication(client:PoolClient,pin:PinnedBuildPublication):Promise<void>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:'+pin.kind+':'+pin.catalogId]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['publication:dependency-graph']);
    const actual=await toolSnapshot(client,pin.kind,pin.catalogId,true);
    if(actual.pin.expectedVersion!==pin.expectedVersion||actual.pin.expectedSourceHash!==pin.expectedSourceHash||actual.pin.name!==pin.name)throw new ConflictException('Карточка или её источник изменились во время сборки. Проверьте карточку и подтвердите новую версию заново.');
}
