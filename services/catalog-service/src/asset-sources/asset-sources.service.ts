import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import { LocalAssetIngest } from './local-asset-ingest';
import {LocalSkillIngest} from './local-skill-ingest';
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
import { importView, type ISourceReceipt } from './import-types';
import {assetCardState,sourceAssetView} from './asset-source-view';
import {bridgeSupplyIdentity} from './bridge-source-head';
import {validBridgeVersion} from './bridge-source-version';
import {assetSourceMode} from './source-cache';
import path from 'node:path';
import {AssetSourceArchiveUploads} from './source-archive-upload';
import {sourceSupplyViews} from './source-supply-view';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
/** Один серверный source pipeline: metadata → exact plan → проверенная supply → native publication. */
@Injectable()
export class AssetSourcesService implements OnModuleInit,OnApplicationShutdown {
    readonly pool=createPool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:5},'asset-sources');
    readonly blobs=new AssetBlobStore(this.pool);readonly jobs=new AssetImportRepository(this.pool);
    readonly sources=new AssetSourceSnapshots(this.pool,require('../../../shared/asset-source.lock.json'));
    readonly archives=new AssetSourceArchiveUploads(this.pool,this.sources,path.dirname(this.blobs.directory));
    private worker:AssetImportWorker;private timer?:ReturnType<typeof setInterval>;
    constructor(private readonly catalog:CatalogService,private readonly access:AccessDb,private readonly runtime:RuntimeArtifacts) {}
    prepareLocal(...args:Parameters<LocalAssetIngest['prepare']>){return new LocalAssetIngest(this.pool,this.blobs).prepare(...args);}
    prepareLocalSkill(...args:Parameters<LocalSkillIngest['prepare']>){return new LocalSkillIngest(this.pool,this.blobs).prepare(...args);}
    publishLocalSkill(...args:Parameters<LocalSkillIngest['publish']>){return new LocalSkillIngest(this.pool,this.blobs).publish(...args);}
    recordLocalSkill(...args:Parameters<LocalSkillIngest['record']>){return new LocalSkillIngest(this.pool,this.blobs).record(...args);}
    async exportLocalReceipt(input:{assetId:string;sourceVersion:string;sourceSha256:string}){
        if(!input||typeof input.assetId!=='string'||typeof input.sourceVersion!=='string'||!/^([a-f0-9]{64})$/.test(input.sourceSha256))throw new BadRequestException('Invalid immutable export reference.');
        const row=(await this.pool.query<ISourceReceipt>("SELECT * FROM asset_source_versions WHERE repository='local-archive' AND external_id=$1 AND asset_version=$2 AND descriptor_sha256=$3",[input.assetId,input.sourceVersion,input.sourceSha256])).rows[0];
        if(!row||!['mcp','plugin','skill'].includes(row.asset_kind))throw new NotFoundException('Local source envelope not found.');
        try{if(row.descriptor.id!==input.assetId||row.descriptor.version!==input.sourceVersion||row.descriptor.kind!==row.asset_kind||assetDigest(serializeAsset(row.descriptor))!==input.sourceSha256)throw new Error();}
        catch{throw new ConflictException('Immutable source envelope checksum changed.');}
        return row;
    }
    async exportLocal(input:{assetId:string;sourceVersion:string;sourceSha256:string}){return (await this.exportLocalReceipt(input)).descriptor;}
    recordLocal(...args:Parameters<LocalAssetIngest['record']>){return new LocalAssetIngest(this.pool,this.blobs).record(...args);}
    catalogReady():Promise<void>{return this.catalog.ensureSchema();}
    async onModuleInit():Promise<void>{
        await this.catalog.ensureSchema();
        await this.sources.bootstrap(()=>requireFeaturesEnabled(['asset_sources']));
        this.worker=new AssetImportWorker(this.pool,this.jobs,this.sources,this.blobs,this.runtime);this.worker.kick();
        this.timer=setInterval(()=>this.worker.kick(),5000);this.timer.unref();
    }
    async onApplicationShutdown():Promise<void>{if(this.timer){clearInterval(this.timer);}await this.worker?.stop();await this.pool.end();}
    async actor(req:Request):Promise<string>{const actor=await readModelActor(req,this.access);if(actor.activeRole!=='Главный админ'){throw new ForbiddenException('Управлять источниками и общим каталогом может главный администратор.');}return actor.email;}
    async view(){
        const {snapshot,last}=await this.sources.status();
        const [sourceReceipts,localReceipts]=await Promise.all([snapshot?this.jobs.receipts(snapshot.pin.repository):[],this.jobs.receipts('local-archive')]);
        const receipts=sourceReceipts.filter(receipt=>receipt.active!==false),local=localReceipts.filter(receipt=>receipt.active!==false);
        const states=new Map(await Promise.all([...receipts,...local].map(async receipt=>
            [receipt.repository+':'+receipt.external_id,await assetCardState(this.pool,receipt)] as const)));
        const view=(asset:Parameters<typeof sourceAssetView>[0],sha256:string,receipt?:ISourceReceipt)=>
            sourceAssetView(asset,sha256,receipt,receipt?states.get(receipt.repository+':'+receipt.external_id):undefined);
        const supply=snapshot?.archive_sha256||assetSourceMode()==='offline'?await sourceSupplyViews(snapshot?.assets??[],this.blobs):undefined;
        return {source:{mode:assetSourceMode(),repository:'ghost-raven1/neurocenter-assets',commit:snapshot?.pin.commit,checkedAt:snapshot?.checked_at,
            verified:!!snapshot,lastAttemptAt:last?.attempted_at,error:last?.message||undefined,archiveSha256:snapshot?.archive_sha256??undefined},
            assets:(snapshot?.assets??[]).filter(record=>record.current).map(({asset,sha256})=>({...view(asset,sha256,receipts.find(row=>row.external_id===asset.id)),...(supply?{supply:supply.get(asset.id)}:{})})),
            localAssets:local.map(receipt=>view(receipt.descriptor,receipt.descriptor_sha256,receipt))};
    }
    async refresh(){await requireFeaturesEnabled(['asset_sources']);await this.sources.refresh();return this.view();}
    async uploadArchive(req:Request,signal:AbortSignal){const actor=await this.actor(req);await requireFeaturesEnabled(['asset_sources']);await this.archives.receive(actor,req,req.headers['content-length'],signal);return this.view();}
    kickImports():void{this.worker.kick();}
    async start(actor:string,body:unknown){
        const input=body as {requestKey?:unknown;ids?:unknown;commit?:unknown};
        if(!input||!uuid(input.requestKey)||!Array.isArray(input.ids)||!input.ids.length||input.ids.length>50||input.ids.some(id=>typeof id!=='string')||new Set(input.ids).size!==input.ids.length
            ||typeof input.commit!=='string'||!/^[a-f0-9]{40}$/.test(input.commit)||Object.keys(input).some(key=>!['requestKey','ids','commit'].includes(key))){throw new BadRequestException('Передайте сохранённый ключ, commit и от 1 до 50 выбранных ассетов.');}
        await requireFeaturesEnabled(['asset_sources']);
        const snapshot=await this.sources.get(input.commit);try{selectAssets(snapshot.assets,input.ids);}catch{throw new ConflictException('Выбранный граф не соответствует точной описи источника.');}
        const job=await this.jobs.create(actor,input.requestKey,snapshot.pin,input.ids,undefined,!!snapshot.archive_sha256||assetSourceMode()==='offline');this.worker.kick();return importView(job);
    }
    async job(id:string,actor:string){if(!uuid(id)){throw new BadRequestException('Некорректный импорт.');}return importView(await this.jobs.get(id,actor));}
    async request(key:string,actor:string){if(!uuid(key)){throw new BadRequestException('Некорректный запрос импорта.');}return importView(await this.jobs.byRequest(actor,key));}
    async retry(id:string,actor:string){if(!uuid(id)){throw new BadRequestException('Некорректный импорт.');}await requireFeaturesEnabled(['asset_sources']);const job=await this.jobs.retry(id,actor);this.worker.kick();return importView(job);}
    async resolve(id:string,actor:string,body:unknown){
        const input=body as {expectedDigest?:unknown};
        if(!uuid(id)||!input||typeof input.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedDigest)||Object.keys(input).some(key=>key!=='expectedDigest')){throw new BadRequestException('Передайте точный digest сохранённого конфликта.');}
        await requireFeaturesEnabled(['asset_sources']);const job=await this.jobs.resolve(id,actor,input.expectedDigest);this.worker.kick();return importView(job);
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
        const selected=(await this.pool.query<{installed_repository:string|null;installed_asset_id:string|null}>('SELECT installed_repository,installed_asset_id FROM bridge_source_settings WHERE singleton')).rows[0];
        const rows=version?(await this.pool.query<ISourceReceipt>(`SELECT * FROM asset_source_versions WHERE asset_kind='bridge' AND descriptor->'delivery'->'release'->>'version'=$1 ORDER BY created_at DESC`,[version])).rows
            :selected?.installed_repository?(await this.pool.query<ISourceReceipt>("SELECT * FROM asset_source_receipts WHERE asset_kind='bridge' AND repository=$1 AND external_id=$2 AND active",[selected.installed_repository,selected.installed_asset_id])).rows
            :(await this.pool.query<ISourceReceipt>("SELECT * FROM asset_source_receipts WHERE asset_kind='bridge' AND active ORDER BY updated_at DESC")).rows;
        if(!rows.length){throw new NotFoundException('Мост ещё не импортирован. Главный администратор должен добавить его на странице «Ассеты».');}
        if(version&&new Set(rows.map(row=>bridgeSupplyIdentity(row.descriptor as BridgeAsset))).size!==1)throw new ConflictException('История этой версии моста содержит разные поставки. Установка остановлена.');
        if(!version&&new Set(rows.map(row=>row.external_id)).size!==1){throw new ConflictException('Импортировано несколько несовместимых источников моста. Требуется выбор администратора.');}
        const row=rows[0],release=toBridgeRelease(row.descriptor as BridgeAsset);
        if(!validBridgeVersion(release.version))throw new ConflictException('Поставка моста содержит неподдерживаемую версию. Нужен формат 1.2.3 без ведущих нулей.');
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
