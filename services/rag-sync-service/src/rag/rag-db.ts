import {createPool} from '../database/pool';
import { Pool } from 'pg';
import {BadRequestException,HttpException,ServiceUnavailableException} from '@nestjs/common';
import {setupRagQuota,ragQuotaPolicy,ragQuota,mapRagQuotaError,reserveLegacyRagQuota,type IRagQuota,type IRagQuotaUpdate} from './quota/rag-quota';
import {applyPlatformQuotaPolicy,platformQuotaPolicy,seedPlatformQuotaPolicy,type IPlatformQuotaUpdate,type IPlatformQuotaPolicy} from './quota/platform-quota';
import {PLATFORM_QUOTA_MIGRATION,PLATFORM_QUOTA_CACHE_MIGRATION} from '../database/migration-definitions';
import {RAG_WRITE_LOCK} from './quota/rag-quota-schema';
import {reserveCapacity} from '../../../shared/capacity.cjs';
import {normalizeChunkRow,rowFingerprint} from '../../../shared/rag-index-contract.cjs';
import {readIndexManifest,readIndexSummary,bindIndexProfile,invalidateIndexSeal,sealIndex,requireUsableVectors,validateIndexWrite,
    type IRagIndexWrite,type IRagIndexManifest,type IRagIndexSummary} from './rag-index-state';
import {migrateRag,checkRagQuotaMigration} from '../database/migrations';
import {GENERATION_MIGRATION,IDENTITY_MIGRATION} from '../database/migration-definitions';
import {RagGenerations,ensureGenerationSearchIndex} from './rag-generations';
import {buildUpsert,parseVector,type IUpsertRow} from './rag-rows';
import {searchProjectIndex,type ProjectSearchInput} from './rag-search';
export {buildUpsert,type IUpsertRow} from './rag-rows';

export interface IRagDbConfig {
    url: string;
    scope?:'base'|'project';
}

/**
 * Строка таблицы `rag_chunks` для dельта-apply (без projectKey — добавляется
 * при вставке как часть PK).
 */

export interface IRagProjectSummary extends IRagIndexSummary {
    projectKey: string;
}


/**
 * Чистый SQL-обёртка над postgres+pgvector для develop-индекса RAG.
 * Идемпотентная схема (CREATE ... IF NOT EXISTS), dельта-apply batched upsert.
 */
export class RagDb {
    private readonly pool: Pool;
    private setupDone: Promise<void> | null = null;
    private readonly quotaPolicy=ragQuotaPolicy();
    private readonly scope:'base'|'project';
    public readonly generations:RagGenerations;

    public search(input:ProjectSearchInput){return searchProjectIndex(this.pool,input);}

    constructor(config: IRagDbConfig) {
        this.scope=config.scope??'project';
        this.pool = createPool({ connectionString: config.url, max: 5 },'rag-data');
        this.generations=new RagGenerations(this.pool);
    }

    /**
     * Общая попытка инициализации: успех запоминается, временный отказ допускает повтор.
     *
     * @returns {Promise<void>}
     */
    public setup(): Promise<void> {
        if (!this.setupDone) {
            this.setupDone = this.init().catch(error=>{this.setupDone=null;throw error;});
        }
        return this.setupDone;
    }

    private async init(): Promise<void> {
        await migrateRag(this.pool,this.scope==='project'?[GENERATION_MIGRATION,IDENTITY_MIGRATION]:[GENERATION_MIGRATION]);
        await setupRagQuota(this.pool,this.quotaPolicy);
        if(!await checkRagQuotaMigration(this.pool))throw new Error('Миграция квоты RAG не подтверждена.');
        await migrateRag(this.pool,[PLATFORM_QUOTA_CACHE_MIGRATION]);
        if(this.scope==='base') {
            await migrateRag(this.pool,[PLATFORM_QUOTA_MIGRATION]);
            await seedPlatformQuotaPolicy(this.pool);
        }
    }

    public platformQuota(update?:IPlatformQuotaUpdate,actor?:string){
        if(this.scope!=='base')throw new Error('Настройки платформы принадлежат общей базе.');
        return platformQuotaPolicy(this.pool,update,actor);
    }
    public configureQuota(policy:IPlatformQuotaPolicy|(()=>Promise<IPlatformQuotaPolicy>)):Promise<void>{return applyPlatformQuotaPolicy(this.pool,policy);}

    /** Лимит и счётчик принадлежат той же БД, что и знания проекта. */
    public quota(projectKey:string,update?:IRagQuotaUpdate,actor?:string):Promise<IRagQuota>{return ragQuota(this.pool,projectKey,update,actor);}

    /** Размер старого индекса пересчитывается с постоянным ID нового проекта. */
    public async migrationQuotaBytes(source:string,target:string):Promise<number>{
        const {rows}=await this.pool.query('SELECT COALESCE(sum(public.neurocenter_rag_row_bytes(c)-octet_length(project_key)+octet_length($2::text)),0) AS bytes FROM rag_chunks c WHERE project_key=$1',[source,target]);
        const bytes=Number(rows[0].bytes);if(!Number.isSafeInteger(bytes)||bytes<0){throw new Error('Некорректный объём старого индекса');}return bytes;
    }
    public reserveMigrationQuota(projectKey:string,bytes:number):Promise<void>{return reserveLegacyRagQuota(this.pool,projectKey,bytes);}

    /**
     * Снимок сервера для project: `{ id -> content_hash }` (baseline для local diff).
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<Record<string, string>>}
     */
    public manifest(projectKey: string,generation:string): Promise<IRagIndexManifest> {
        return readIndexManifest(this.pool,projectKey,generation);
    }

    /**
     * Суммарная статистика по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<{ rowCount: number; lastSyncedAt: string | null; dimension: number }>}
     */
    public async summary(
        projectKey: string,
        generation:string,
    ): Promise<IRagIndexSummary> {
        return readIndexSummary(this.pool,projectKey,generation);
    }

    /**
     * Оценка размера develop-индекса проекта в байтах (pgvector, без полного
     * сканирования содержимого): доля таблицы `rag_chunks` (таблица + индексы,
     * pg_total_relation_size), пропорциональная количеству строк проекта.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<number>} оценка в байтах (0, если таблицы/строк нет).
     */
    public async retainedEstimateBytes(projectKey: string): Promise<number> {
        let res: import('pg').QueryResult;

        try {
            res = await this.pool.query(
                `SELECT (SELECT pg_total_relation_size('rag_chunks')::int8) AS tsize,
                 (SELECT count(*)::int8 FROM rag_chunks WHERE project_key = $1) AS pcount,
                 (SELECT count(*)::int8 FROM rag_chunks) AS tcount`,
                [projectKey],
            );
        } catch (error) {
            throw new ServiceUnavailableException('Не удалось измерить объём базы знаний. Повторите запрос после восстановления PostgreSQL.',{cause:error});
        }

        const row = res.rows[0] as { tsize: number | string | null; pcount: number | string; tcount: number | string } | undefined;
        const tsize = Number(row?.tsize ?? 0);
        const pcount = Number(row?.pcount ?? 0);
        const tcount = Number(row?.tcount ?? 0);
        if (!row || tsize <= 0 || tcount <= 0 || pcount <= 0) {
            return 0;
        }
        return Math.floor((tsize * pcount) / tcount);
    }

    /** Exact committed replies remain readable when admission of new writes has been disabled. */
    public async completedWrite(projectKey:string,generation:string,intent:{id:string;payloadHash:string}):Promise<({upserted:number;deleted:number}&IRagIndexSummary)|null>{
        const saved=(await this.pool.query('SELECT * FROM rag_write_receipts WHERE id=$1',[intent.id])).rows[0];
        if(!saved)return null;
        if(saved.project_key!==projectKey||saved.generation_id!==generation||saved.payload_hash!==intent.payloadHash)throw new BadRequestException('Идентификатор записи уже закреплён за другим содержимым.');
        if(saved.state==='failed')throw new BadRequestException(saved.error?.message||'Запись была отменена без изменения данных.');
        return saved.state==='succeeded'?saved.result:null;
    }

    /**
     * Идемпотентный dельта-apply: upsert новых/изменённых, delete удалённых.
     *
     * @param projectKey - ключ проекта.
     * @param upserts - строки для вставки/обновления.
     * @param deletes - id для удаления.
     * @returns {Promise<{ upserted: number; deleted: number }>}
     */
    public async applyDelta(
        projectKey: string,
        generation:string,
        upserts: IUpsertRow[],
        deletes: string[],
        write:IRagIndexWrite={indexProfile:null},
        intent?:{id:string;payloadHash:string},
    ): Promise<{ upserted: number; deleted: number }&IRagIndexSummary> {
        if(!/^(?:initial-[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.test(generation))throw new BadRequestException('Некорректное поколение индекса.');
        if(!intent&&!generation.startsWith('initial-'))throw new BadRequestException('Запись управляемого поколения требует сохранённый catalog intent.');
        write=validateIndexWrite(write.indexProfile,write.snapshot);
        if(write.snapshot?.complete&&(upserts.length||deletes.length)){throw new BadRequestException('Подтверждение снимка передаётся отдельным пустым пакетом после всех изменений.');}
        if(write.indexProfile){requireUsableVectors(upserts,write.indexProfile.dimension);}
        const normalized=upserts.map(row=>({...row,...normalizeChunkRow(row),syncHash:write.indexProfile?rowFingerprint(row):null}));
        if(intent){
            await this.pool.query(`INSERT INTO rag_write_receipts(id,project_key,generation_id,payload_hash,state)
                VALUES($1,$2,$3,$4,'running') ON CONFLICT(id) DO NOTHING`,[intent.id,projectKey,generation,intent.payloadHash]);
        }
        // Перезапись строк/индексов и WAL требуют запаса сверх логической квоты RAG.
        const estimate=Math.max(16*1024**2,Buffer.byteLength(JSON.stringify(upserts),'utf8')*6);
        const releaseCapacity=await reserveCapacity({resource:'postgres',bytes:estimate});
        const client = await this.pool.connect().catch(error=>{releaseCapacity();throw error;});
        let deleted = 0;
        let upserted = 0;

        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout='10s'");
            if(intent){
                const receipt=await client.query('SELECT * FROM rag_write_receipts WHERE id=$1 FOR UPDATE',[intent.id]);
                const saved=receipt.rows[0];
                if(!saved||saved.project_key!==projectKey||saved.generation_id!==generation||saved.payload_hash!==intent.payloadHash){throw new BadRequestException('Идентификатор записи уже закреплён за другим содержимым.');}
                if(saved.state==='succeeded'){await client.query('COMMIT');return saved.result;}
                if(saved.state==='failed'){throw new BadRequestException(saved.error?.message||'Запись была отменена без изменения данных.');}
            }
            await client.query('LOCK TABLE rag_chunks IN ROW EXCLUSIVE MODE');
            await client.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
            await bindIndexProfile(client,projectKey,generation,write);
            if(!write.snapshot?.complete){await invalidateIndexSeal(client,projectKey,generation);}

            if (deletes.length > 0) {
                const delRes = await client.query(
                    'DELETE FROM rag_chunks WHERE project_key = $1 AND generation_id=$2 AND id = ANY($3)',
                    [projectKey,generation,deletes],
                );
                deleted = delRes.rowCount ?? 0;
            }

            const BATCH = 50;
            for (let i = 0; i < normalized.length; i += BATCH) {
                const batch: IUpsertRow[] = normalized.slice(i, i + BATCH);
                const { sql, params } = buildUpsert(projectKey,generation,batch);
                const insRes = await client.query(sql, params);
                upserted += insRes.rowCount ?? batch.length;
            }

            if(write.snapshot?.complete){await sealIndex(client,projectKey,generation,write);if(write.indexProfile)await ensureGenerationSearchIndex(client,generation,write.indexProfile.dimension);}
            const summary=await readIndexSummary(client,projectKey,generation);
            await client.query(`INSERT INTO rag_generations(id,project_key,index_profile,state,snapshot_hash,source_rows,processed_rows)
                VALUES($1,$2,$3::jsonb,'ready',$4,$5,$5) ON CONFLICT(id) DO UPDATE SET index_profile=EXCLUDED.index_profile,
                snapshot_hash=EXCLUDED.snapshot_hash,receipt_hash=NULL,source_rows=EXCLUDED.source_rows,processed_rows=EXCLUDED.processed_rows,updated_at=now()`,
            [generation,projectKey,JSON.stringify(write.indexProfile),summary.snapshotHash,summary.rowCount]);
            const result={upserted,deleted,...summary};
            if(intent){await client.query("UPDATE rag_write_receipts SET state='succeeded',result=$2::jsonb,updated_at=now() WHERE id=$1",[intent.id,JSON.stringify(result)]);}
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            const mapped=mapRagQuotaError(error);
            if(intent&&mapped instanceof HttpException&&[400,403,409,413].includes(mapped.getStatus())){
                await client.query("UPDATE rag_write_receipts SET state='failed',error=$2::jsonb,updated_at=now() WHERE id=$1 AND state='running'",
                    [intent.id,JSON.stringify({message:'Пакет отклонён без изменения данных.'})]).catch(()=>undefined);
            }
            throw mapped;
        } finally {
            try{client.release();}finally{releaseCapacity();}
        }

    }

    /**
     * Количество строк develop-индекса по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<number>}
     */
    public async count(projectKey: string,generation:string): Promise<number> {
        const res = await this.pool.query('SELECT count(*)::int AS n FROM rag_chunks WHERE project_key=$1 AND generation_id=$2',[projectKey,generation]);
        return (res.rows[0] as { n: number }).n;
    }

    /**
     * Страница строк develop-индекса (пагинация по id) — для потоковой
     * обратной синхронизации без сбора всего индекса в памяти (OOM-защита).
     *
     * @param projectKey - ключ проекта.
     * @param limit - размер страницы.
     * @param offset - смещение.
     * @returns {Promise<IUpsertRow[]>}
     */
    public async rowsPage(projectKey: string,generation:string, limit: number, offset: number,db:Pick<import('pg').PoolClient,'query'>=this.pool): Promise<IUpsertRow[]> {
        const res = await db.query(
            'SELECT id, file_path, content, description, start_line, end_line, language, ' +
            'kind, role, quirk_type, tags, content_hash, embedding ' +
            'FROM rag_chunks WHERE project_key=$1 AND generation_id=$2 ORDER BY id LIMIT $3 OFFSET $4',
            [projectKey,generation,limit,offset],
        );
        const list = res.rows as Array<{
            id: string;
            file_path: string;
            content: string;
            description: string | null;
            start_line: number | null;
            end_line: number | null;
            language: string | null;
            kind: string;
            role: string | null;
            quirk_type: string | null;
            tags: string | null;
            content_hash: string;
            embedding: string | number[] | null;
        }>;
        return list.map((r) => ({
            id: r.id,
            filePath: r.file_path ?? '',
            content: r.content ?? '',
            description: r.description,
            startLine: r.start_line,
            endLine: r.end_line,
            language: r.language,
            kind: r.kind ?? '',
            role: r.role,
            quirkType: r.quirk_type,
            tags: r.tags,
            contentHash: r.content_hash,
            embedding: parseVector(r.embedding),
        }));
    }

    /** Страница и seal видят один PostgreSQL snapshot даже при параллельной active синхронизации. */
    public async exportPage(project:string,generation:string,limit:number,offset:number){
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const rows=await this.rowsPage(project,generation,limit,offset,client),summary=await readIndexSummary(client,project,generation);
            await client.query('COMMIT');return {chunks:rows,...summary};
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }

    /**
     * Закрывает пул (по завершении сервиса).
     *
     * @returns {Promise<void>}
     */
    public async close(): Promise<void> {
        await this.pool.end();
    }
}
