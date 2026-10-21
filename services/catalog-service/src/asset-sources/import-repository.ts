import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { publicationHash } from '../publication/publication-validation';
import type { IAssetSourcePin } from './source-client';
import { importPlanDigest } from './import-types';
import type { IImportItem, IImportJob, ISourceReceipt, TImportState } from './import-types';
import { securityEvent } from '../access/security-events';
import {assertBridgeHead} from './bridge-source-head';

/** Намерение и точные описи переживают reload и restart; частичный импорт не маскируется общим успехом. */
export class AssetImportRepository {
    constructor(readonly pool: Pool) {}

    async create(actor: string, requestKey: string, source: IAssetSourcePin, ids: string[], bridgeSourceRevision?:number): Promise<IImportJob> {
        const fingerprint = publicationHash({source,ids:[...ids].sort(),...(bridgeSourceRevision!==undefined?{bridgeSourceRevision}:{})});
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-import-request:'+actor+':'+requestKey]);
            const previous = await client.query<IImportJob>('SELECT * FROM asset_source_jobs WHERE actor=$1 AND request_key=$2',[actor,requestKey]);
            if (previous.rows[0]) {
                if (previous.rows[0].request_hash !== fingerprint) { throw new ConflictException('Этот запрос уже относится к другому выбору ассетов или источнику.'); }
                await client.query('COMMIT'); return previous.rows[0];
            }
            if(bridgeSourceRevision!==undefined){
                const settings=(await client.query<{revision:number;url:string;check_commit:string;error:string|null}>('SELECT revision,url,check_commit,error FROM bridge_source_settings WHERE singleton FOR UPDATE')).rows[0];
                if(!settings||settings.revision!==bridgeSourceRevision||settings.check_commit!==source.commit||settings.error||settings.url!=='https://github.com/'+source.repository)throw new ConflictException('Источник моста изменился до сохранения импорта. Обновите проверку.');
            }
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-import-queue']);
            const pending = await client.query<{count:number}>("SELECT count(*)::int AS count FROM asset_source_jobs WHERE state IN ('QUEUED','RUNNING')");
            if ((pending.rows[0]?.count??0) >= 10) { throw new ConflictException('В очереди уже 10 импортов. Дождитесь завершения текущих операций.'); }
            const {rows} = await client.query<IImportJob>(`INSERT INTO asset_source_jobs(id,actor,request_key,request_hash,source,selected_ids,state,message,bridge_source_revision)
                VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'QUEUED','Проверяем выбранные ассеты и точные зависимости',$7) RETURNING *`,
            [randomUUID(),actor,requestKey,fingerprint,JSON.stringify(source),JSON.stringify(ids),bridgeSourceRevision??null]);
            await securityEvent(client,{actor,action:'asset.import.request',resourceId:rows[0].id,before:null,
                after:{repository:source.repository,commit:source.commit,ids}});
            await client.query('COMMIT'); return rows[0];
        } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
        finally { client.release(); }
    }

    async get(id: string, actor?: string, client: Pick<PoolClient,'query'> = this.pool): Promise<IImportJob> {
        const {rows} = await client.query<IImportJob>('SELECT * FROM asset_source_jobs WHERE id=$1',[id]);
        if (!rows[0] || actor !== undefined && rows[0].actor !== actor) { throw new NotFoundException('Импорт не найден для текущего пользователя.'); }
        return rows[0];
    }

    async byRequest(actor: string, key: string): Promise<IImportJob> {
        const {rows} = await this.pool.query<IImportJob>('SELECT * FROM asset_source_jobs WHERE actor=$1 AND request_key=$2',[actor,key]);
        if (!rows[0]) { throw new NotFoundException('Импорт по этому запросу ещё не найден.'); }
        return rows[0];
    }

    async next(client: PoolClient): Promise<IImportJob | undefined> {
        const {rows} = await client.query<IImportJob>("SELECT * FROM asset_source_jobs WHERE state IN ('QUEUED','RUNNING') ORDER BY created_at,id LIMIT 1");
        return rows[0];
    }

    /** A committed success survives lost ACKs and stale failure writers without changing its receipt. */
    async save(client: Pick<PoolClient,'query'>, job: IImportJob, state: TImportState, message: string, items = job.items): Promise<IImportJob> {
        const {rows} = await client.query<IImportJob>(`UPDATE asset_source_jobs SET state=$2,message=$3,items=$4::jsonb,updated_at=now() WHERE id=$1 AND state<>'SUCCEEDED' RETURNING *`,
            [job.id,state,message,JSON.stringify(items)]);
        return rows[0] ?? this.get(job.id,undefined,client);
    }

    async receipts(repository: string): Promise<ISourceReceipt[]> {
        return (await this.pool.query<ISourceReceipt>('SELECT * FROM asset_source_receipts WHERE repository=$1',[repository])).rows;
    }

    async versions(repository: string): Promise<ISourceReceipt[]> {
        return (await this.pool.query<ISourceReceipt>('SELECT * FROM asset_source_versions WHERE repository=$1',[repository])).rows;
    }

    /** Вызывается в той же транзакции, что native-публикация и SUCCEEDED конкретного элемента. */
    async receipt(client: PoolClient, job: IImportJob, item: IImportItem, blobs: ISourceReceipt['blobs']): Promise<void> {
        if(item.resolved.asset.kind==='bridge'&&!item.preserveHead){
            const settings=(await client.query<{revision:number;url:string}>('SELECT revision,url FROM bridge_source_settings WHERE singleton FOR UPDATE')).rows[0];
            if(job.bridge_source_revision!=null&&(settings?.revision!==job.bridge_source_revision||settings.url!=='https://github.com/'+job.source.repository))throw new ConflictException('Источник моста изменился во время подготовки. Текущая поставка сохранена.');
            await assertBridgeHead(client,item.resolved.asset);
        }
        await this.persistReceipt(client,{repository:job.source.repository,commit:job.source.commit,origin:'repository'},job.actor,item,blobs);
        if(item.resolved.asset.kind==='bridge'&&!item.preserveHead)await client.query('UPDATE bridge_source_settings SET installed_repository=$1,installed_asset_id=$2 WHERE singleton',[job.source.repository,item.resolved.asset.id]);
    }

    /** Локальная сборка использует тот же immutable versionmap, без вымышленного public commit. */
    async recordLocal(client:PoolClient,actor:string,item:IImportItem,blobs:ISourceReceipt['blobs']):Promise<void>{
        return this.persistReceipt(client,{repository:'local-archive',commit:null,origin:'local-archive'},actor,item,blobs);
    }

    private async persistReceipt(client:PoolClient,source:{repository:string;commit:string|null;origin:'repository'|'local-archive'},actor:string,item:IImportItem,blobs:ISourceReceipt['blobs']):Promise<void>{
        const native = item.native!;
        if(!item.preserveHead){
            const owners=(await client.query<ISourceReceipt>('SELECT * FROM asset_source_receipts WHERE asset_kind=$1 AND native_id=$2 AND active ORDER BY repository,external_id FOR UPDATE',[native.kind,native.id])).rows;
            const foreign=owners.filter(row=>row.repository!==source.repository||row.external_id!==item.resolved.asset.id);
            const actual=foreign.map(row=>({repository:row.repository,externalId:row.external_id,revision:Number(row.revision)}));
            if(publicationHash(actual)!==publicationHash(item.originReceipts??[])||foreign.length&&!item.replacesLocal)throw new ConflictException('Источник карточки изменился после проверки. Подтвердите принятие нового источника заново.');
            for(const row of foreign)await client.query('UPDATE asset_source_receipts SET active=false,revision=revision+1,updated_at=now() WHERE repository=$1 AND external_id=$2',[row.repository,row.external_id]);
        }
        await client.query(`INSERT INTO asset_source_versions(repository,external_id,asset_kind,asset_version,descriptor_sha256,source_commit,
            native_id,native_version,native_hash,native_manifest,descriptor,blobs,imported_by,origin)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14) ON CONFLICT(repository,external_id,asset_version) DO NOTHING`,
        [source.repository,item.resolved.asset.id,item.resolved.asset.kind,item.resolved.asset.version,item.resolved.sha256,source.commit,
            native.id,native.version,native.hash,native.manifest??null,JSON.stringify(item.resolved.asset),JSON.stringify(blobs),actor,source.origin]);
        const saved=await client.query<ISourceReceipt>('SELECT * FROM asset_source_versions WHERE repository=$1 AND external_id=$2 AND asset_version=$3',
            [source.repository,item.resolved.asset.id,item.resolved.asset.version]);
        const version=saved.rows[0];
        if(!version||version.descriptor_sha256!==item.resolved.sha256||version.native_id!==native.id||item.action!=='unchanged'&&!item.replacesLocal&&(version.native_version!==native.version||version.native_hash!==native.hash)){
            throw new ConflictException('Опубликованная версия источника уже связана с другим неизменяемым снимком.');
        }
        if(!item.preserveHead) { await client.query(`INSERT INTO asset_source_receipts(repository,external_id,asset_kind,asset_version,descriptor_sha256,source_commit,
            native_id,native_version,native_hash,descriptor,blobs,imported_by,origin)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13) ON CONFLICT(repository,external_id) DO UPDATE SET
            asset_kind=EXCLUDED.asset_kind,asset_version=EXCLUDED.asset_version,descriptor_sha256=EXCLUDED.descriptor_sha256,
            source_commit=EXCLUDED.source_commit,native_id=EXCLUDED.native_id,native_version=EXCLUDED.native_version,native_hash=EXCLUDED.native_hash,
            descriptor=EXCLUDED.descriptor,blobs=EXCLUDED.blobs,imported_by=EXCLUDED.imported_by,origin=EXCLUDED.origin,active=true,
            revision=asset_source_receipts.revision+1,updated_at=now()`,
        [source.repository,item.resolved.asset.id,item.resolved.asset.kind,item.resolved.asset.version,item.resolved.sha256,source.commit,
            native.id,native.version,native.hash,JSON.stringify(item.resolved.asset),JSON.stringify(blobs),actor,source.origin]); }
        for (const blob of blobs) {
            await client.query(`INSERT INTO asset_source_blob_refs(repository,asset_id,asset_version,descriptor_sha256,blob_sha256)
                VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[source.repository,item.resolved.asset.id,item.resolved.asset.version,item.resolved.sha256,blob.sha256]);
        }
    }

    /** Explicit replace сохраняет exact current hash; worker повторно проверяет его до native write. */
    async resolve(id:string,actor:string,digest:string):Promise<IImportJob> {
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN');const {rows}=await client.query<IImportJob>('SELECT * FROM asset_source_jobs WHERE id=$1 AND actor=$2 FOR UPDATE',[id,actor]);
            const job=rows[0];if(!job){throw new NotFoundException('Импорт недоступен текущему пользователю.');}
            if(job.state!=='NEEDS_INPUT'||importPlanDigest(job)!==digest){throw new ConflictException('Проверка конфликта устарела. Обновите состояние импорта.');}
            const conflicts=job.items.filter(item=>item.action==='conflict');
            if(!conflicts.length||conflicts.some(item=>!item.replaceable||!item.expected)){throw new ConflictException('Этот конфликт нельзя решить заменой локальной карточки. Исправьте указанные причины.');}
            const hashes=Object.fromEntries(conflicts.map(item=>[item.resolved.asset.id+'@'+item.resolved.asset.version,item.expected!.hash]));
            const origins=Object.fromEntries(conflicts.map(item=>[item.resolved.asset.id+'@'+item.resolved.asset.version,item.originReceipts??[]]));
            const updated=await client.query<IImportJob>("UPDATE asset_source_jobs SET state='QUEUED',replacement_hashes=$2::jsonb,replacement_origins=$3::jsonb,items='[]'::jsonb,cancel_requested=false,message='Применяем явно выбранную замену локальных карточек',updated_at=now() WHERE id=$1 RETURNING *",[id,JSON.stringify(hashes),JSON.stringify(origins)]);
            await securityEvent(client,{actor,action:'asset.import.replace',resourceId:id,before:{digest,conflicts:conflicts.map(item=>({id:item.expected!.id,version:item.expected!.version,hash:item.expected!.hash}))},after:{source:job.source.commit}});
            await client.query('COMMIT');return updated.rows[0];
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }

    async retry(id: string, actor: string): Promise<IImportJob> {
        await this.get(id,actor);
        const {rows} = await this.pool.query<IImportJob>(`UPDATE asset_source_jobs SET state='QUEUED',cancel_requested=false,
            replacement_hashes=CASE WHEN state='NEEDS_INPUT' THEN '{}'::jsonb ELSE replacement_hashes END,
            replacement_origins=CASE WHEN state='NEEDS_INPUT' THEN '{}'::jsonb ELSE replacement_origins END,
            items=CASE WHEN state='NEEDS_INPUT' THEN '[]'::jsonb ELSE items END,message='Повторяем сохранённый импорт',updated_at=now()
            WHERE id=$1 AND actor=$2 AND state IN ('FAILED','PARTIAL','NEEDS_INPUT') RETURNING *`,[id,actor]);
        if (!rows[0]) { throw new ConflictException('Повтор доступен после ошибки или исправления конфликта.'); }
        return rows[0];
    }

    async cancel(id: string, actor: string): Promise<IImportJob> {
        await this.get(id,actor);
        const {rows} = await this.pool.query<IImportJob>(`UPDATE asset_source_jobs SET cancel_requested=true,
            state=CASE WHEN state IN ('QUEUED','NEEDS_INPUT') THEN 'CANCELLED' ELSE state END,updated_at=now()
            WHERE id=$1 AND actor=$2 AND state IN ('QUEUED','RUNNING','NEEDS_INPUT') RETURNING *`,[id,actor]);
        return rows[0] ?? this.get(id,actor);
    }
}
