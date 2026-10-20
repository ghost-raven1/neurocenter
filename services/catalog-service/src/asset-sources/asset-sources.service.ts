import { LocalAssetIngest } from './local-asset-ingest';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { assetDigest,serializeAsset,selectAssets, toBridgeRelease, type BridgeAsset, type ModelAsset } from '@neurocenter/asset-contract';
import { AccessDb } from '../access/access-db';
import { CatalogService } from '../catalog/catalog.service';
import { readModelActor } from '../models/model-access';
import { createPool } from '../database/pool';
import { RuntimeArtifacts } from '../runtime-artifacts/runtime-artifacts';
import { AssetBlobStore } from './asset-blob-store';
import { AssetSourceSnapshots } from './source-snapshots';
import { AssetImportRepository } from './import-repository';
import { AssetImportWorker } from './import-worker';
import { migrateNativeAssetData } from './migrate-native-data';
import { SkillAssetClient } from './skill-adapter';
import { importView, type ISourceReceipt } from './import-types';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
/** Один серверный source pipeline: metadata → exact plan → проверенная supply → native publication. */
@Injectable()
export class AssetSourcesService implements OnModuleInit,OnApplicationShutdown {
    readonly pool=createPool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:5},'asset-sources');
    readonly blobs=new AssetBlobStore(this.pool);readonly jobs=new AssetImportRepository(this.pool);
    readonly sources=new AssetSourceSnapshots(this.pool,require('../../../shared/asset-source.lock.json'));
    private worker:AssetImportWorker;private timer?:ReturnType<typeof setInterval>;
    constructor(private readonly catalog:CatalogService,private readonly access:AccessDb,private readonly runtime:RuntimeArtifacts) {}
    prepareLocal(...args:Parameters<LocalAssetIngest['prepare']>){return new LocalAssetIngest(this.pool,this.blobs).prepare(...args);}
    async exportLocalReceipt(input:{assetId:string;sourceVersion:string;sourceSha256:string}){
        if(!input||typeof input.assetId!=='string'||typeof input.sourceVersion!=='string'||!/^([a-f0-9]{64})$/.test(input.sourceSha256))throw new BadRequestException('Invalid immutable export reference.');
        const row=(await this.pool.query<ISourceReceipt>("SELECT * FROM asset_source_versions WHERE repository='local-archive' AND external_id=$1 AND asset_version=$2 AND descriptor_sha256=$3",[input.assetId,input.sourceVersion,input.sourceSha256])).rows[0];
        if(!row||!['mcp','plugin'].includes(row.asset_kind))throw new NotFoundException('Local source envelope not found.');
        try{if(row.descriptor.id!==input.assetId||row.descriptor.version!==input.sourceVersion||row.descriptor.kind!==row.asset_kind||assetDigest(serializeAsset(row.descriptor))!==input.sourceSha256)throw new Error();}
        catch{throw new ConflictException('Immutable source envelope checksum changed.');}
        return row;
    }
    async exportLocal(input:{assetId:string;sourceVersion:string;sourceSha256:string}){return (await this.exportLocalReceipt(input)).descriptor;}
    recordLocal(...args:Parameters<LocalAssetIngest['record']>){return new LocalAssetIngest(this.pool,this.blobs).record(...args);}
    catalogReady():Promise<void>{return this.catalog.ensureSchema();}
    async onModuleInit():Promise<void>{
        await this.catalog.ensureSchema();await this.blobs.setup();await this.jobs.setup();await migrateNativeAssetData(this.pool);await this.sources.setup();
        this.worker=new AssetImportWorker(this.pool,this.jobs,this.sources,this.blobs,this.runtime);this.worker.kick();
        this.timer=setInterval(()=>this.worker.kick(),5000);this.timer.unref();
    }
    async onApplicationShutdown():Promise<void>{if(this.timer){clearInterval(this.timer);}await this.worker?.stop();await this.pool.end();}
    async actor(req:Request):Promise<string>{const actor=await readModelActor(req,this.access);if(actor.activeRole!=='Главный админ'){throw new ForbiddenException('Управлять источниками и общим каталогом может главный администратор.');}return actor.email;}
    async view(){
        const {snapshot,last}=await this.sources.status(),receipts=snapshot?await this.jobs.receipts(snapshot.pin.repository):[];
        const states=new Map<string,{archived:boolean;unavailable?:boolean}>();
        await Promise.all(receipts.map(async receipt=>{
            try{
                const row=receipt.asset_kind==='model'?(await this.pool.query('SELECT archived_at FROM model_catalog WHERE id=$1',[receipt.native_id])).rows[0]
                    :receipt.asset_kind==='skill'?await new SkillAssetClient().inspect(receipt.native_id)
                    :['mcp','plugin'].includes(receipt.asset_kind)?(await this.pool.query('SELECT archived_at FROM ai_plugins WHERE id=$1',[receipt.native_id])).rows[0]:{};
                states.set(receipt.external_id,{archived:!!(row?.archived_at??row?.archivedAt),unavailable:!row});
            }catch{states.set(receipt.external_id,{archived:false,unavailable:true});}
        }));
        return {source:{repository:'ghost-raven1/neurocenter-assets',commit:snapshot?.pin.commit,checkedAt:snapshot?.checked_at,
            verified:!!snapshot,lastAttemptAt:last?.attempted_at,error:last?.message||undefined},
            assets:(snapshot?.assets??[]).filter(record=>record.current).map(({asset,sha256})=>{
                const receipt=receipts.find(row=>row.external_id===asset.id),card=asset.card;
                return {id:asset.id,kind:asset.kind,version:asset.version,sha256,name:card.name,description:'description'in card?card.description:asset.kind==='skill'?asset.card.meta.description:asset.kind==='model'?asset.card.descriptor.description:undefined,
                    license:asset.license.spdx,dependencies:(asset.dependencies??[]).map(({id,version})=>({id,version})),
                    imported:receipt?{id:receipt.native_id,version:receipt.native_version,originVersion:receipt.asset_version,
                        updateAvailable:receipt.descriptor_sha256!==sha256,...states.get(asset.id)}:undefined};
            })};
    }
    async refresh(){await this.sources.refresh();return this.view();}
    async start(actor:string,body:unknown){
        const input=body as {requestKey?:unknown;ids?:unknown;commit?:unknown};
        if(!input||!uuid(input.requestKey)||!Array.isArray(input.ids)||!input.ids.length||input.ids.length>50||input.ids.some(id=>typeof id!=='string')||new Set(input.ids).size!==input.ids.length
            ||typeof input.commit!=='string'||!/^[a-f0-9]{40}$/.test(input.commit)||Object.keys(input).some(key=>!['requestKey','ids','commit'].includes(key))){throw new BadRequestException('Передайте сохранённый ключ, commit и от 1 до 50 выбранных ассетов.');}
        const snapshot=await this.sources.get(input.commit);try{selectAssets(snapshot.assets,input.ids);}catch{throw new ConflictException('Выбранный граф не соответствует точной описи источника.');}
        const job=await this.jobs.create(actor,input.requestKey,snapshot.pin,input.ids);this.worker.kick();return importView(job);
    }
    async job(id:string,actor:string){if(!uuid(id)){throw new BadRequestException('Некорректный импорт.');}return importView(await this.jobs.get(id,actor));}
    async request(key:string,actor:string){if(!uuid(key)){throw new BadRequestException('Некорректный запрос импорта.');}return importView(await this.jobs.byRequest(actor,key));}
    async retry(id:string,actor:string){if(!uuid(id)){throw new BadRequestException('Некорректный импорт.');}const job=await this.jobs.retry(id,actor);this.worker.kick();return importView(job);}
    async resolve(id:string,actor:string,body:unknown){
        const input=body as {expectedDigest?:unknown};
        if(!uuid(id)||!input||typeof input.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedDigest)||Object.keys(input).some(key=>key!=='expectedDigest')){throw new BadRequestException('Передайте точный digest сохранённого конфликта.');}
        const job=await this.jobs.resolve(id,actor,input.expectedDigest);this.worker.kick();return importView(job);
    }
    async cancel(id:string,actor:string){if(!uuid(id)){throw new BadRequestException('Некорректный импорт.');}return importView(await this.jobs.cancel(id,actor));}
    /** Только server runtime получает native bundle и проверенные пути; этот payload не выдаётся UI/устройствам. */
    async modelSupply(modelId:string,manifestSha256:string) {
        if(!/^model-[a-z0-9][a-z0-9-]{0,120}$/.test(modelId)||!/^[a-f0-9]{64}$/.test(manifestSha256)){throw new BadRequestException('Нужен точный model ID и SHA манифеста.');}
        const row=(await this.pool.query<ISourceReceipt>(`SELECT * FROM asset_source_versions WHERE asset_kind='model' AND native_id=$1
            AND descriptor->'card'->'descriptor'->>'manifestSha256'=$2 ORDER BY created_at DESC LIMIT 1`,[modelId,manifestSha256])).rows[0];
        if(!row){throw new NotFoundException('Файлы этой версии модели ещё не импортированы. Добавьте её на странице «Ассеты».');}
        const asset=row.descriptor as ModelAsset;
        if(asset.delivery.type!=='model-bundle'){throw new ConflictException('Удалённая модель не содержит локальных весов.');}
        const parts=[];
        for(const blob of row.blobs){parts.push({name:blob.filename,sha256:blob.sha256,bytes:blob.bytes,path:await this.blobs.checkedPath(blob.sha256,blob.bytes)});}
        return {assetId:row.external_id,originVersion:row.asset_version,sourceCommit:row.source_commit,manifestSha256,
            lock:asset.delivery.lock,bundle:asset.delivery.bundle,parts};
    }

    /** Gateway запрашивает только уже импортированную immutable release; никакого network/legacy fallback. */
    async bridgeSupply(version?:string){
        if(version!==undefined&&(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))){throw new BadRequestException('Некорректная версия моста.');}
        const rows=version?(await this.pool.query<ISourceReceipt>(`SELECT * FROM asset_source_versions WHERE asset_kind='bridge' AND descriptor->'delivery'->'release'->>'version'=$1 ORDER BY created_at DESC`,[version])).rows
            :(await this.pool.query<ISourceReceipt>("SELECT * FROM asset_source_receipts WHERE asset_kind='bridge' ORDER BY updated_at DESC")).rows;
        if(!rows.length){throw new NotFoundException('Мост ещё не импортирован. Главный администратор должен добавить его на странице «Ассеты».');}
        if(new Set(rows.map(row=>row.external_id)).size!==1){throw new ConflictException('Импортировано несколько несовместимых источников моста. Требуется выбор администратора.');}
        const row=rows[0],release=toBridgeRelease(row.descriptor as BridgeAsset);
        const artifacts=[];
        for(const artifact of release.artifacts){
            const sha=String(artifact.metadata.sha256??''),blob=row.blobs.find(blob=>blob.sha256===sha);
            if(!blob){throw new ConflictException('Квитанция моста не содержит проверенного архива.');}
            await this.blobs.checkedPath(blob.sha256,blob.bytes);
            artifacts.push({file:artifact.file,target:blob.target,sha256:blob.sha256,bytes:blob.bytes,metadata:artifact.metadata});
        }
        return {assetId:row.external_id,version:release.version,buildId:release.buildId,sourceCommit:row.source_commit,artifacts};
    }
}
