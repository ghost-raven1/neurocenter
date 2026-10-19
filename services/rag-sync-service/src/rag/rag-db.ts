import {createPool} from '../database/pool';
import { Pool } from 'pg';
import {ServiceUnavailableException} from '@nestjs/common';
import {setupRagQuota,ragQuotaPolicy,ragQuota,mapRagQuotaError,reserveLegacyRagQuota,type IRagQuota,type IRagQuotaUpdate} from './quota/rag-quota';
import {RAG_WRITE_LOCK} from './quota/rag-quota-schema';
import {reserveCapacity} from '../../../shared/capacity.cjs';

export interface IRagDbConfig {
    url: string;
    dim: number;
}

/**
 * Строка таблицы `rag_chunks` для dельта-apply (без projectKey — добавляется
 * при вставке как часть PK).
 */
export interface IUpsertRow {
    id: string;
    filePath: string;
    content: string;
    description: string | null;
    startLine: number | null;
    endLine: number | null;
    language: string | null;
    kind: string;
    role: string | null;
    quirkType: string | null;
    tags: string | null;
    contentHash: string;
    embedding: number[] | null;
}

interface IManifestRow {
    id: string;
    content_hash: string;
}

interface ISummaryRow {
    n: number;
    ts: string | null;
}

export interface IRagProjectSummary {
    projectKey: string;
    rowCount: number;
    lastSyncedAt: string | null;
    dimension: number;
}

interface IListProjectRow {
    project_key: string;
    n: number;
    ts: string | null;
}

/**
 * Чистый SQL-обёртка над postgres+pgvector для develop-индекса RAG.
 * Идемпотентная схема (CREATE ... IF NOT EXISTS), dельта-apply batched upsert.
 */
export class RagDb {
    private readonly pool: Pool;
    private setupDone: Promise<void> | null = null;
    private readonly quotaPolicy=ragQuotaPolicy();

    constructor(private readonly config: IRagDbConfig) {
        this.pool = createPool({ connectionString: config.url, max: 5 },'rag-data');
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
        const dim = this.config.dim;
        // pgvector индексирует векторы только до 2000 dim (ivfflat/hnsw).
        // Для dim > 2000 индекс не создаём — поиск точный (exact, без индекса).
        const vectorIndex = dim <= 2000
            ? 'DROP INDEX IF EXISTS rag_chunks_emb_hnsw; ' +
              'CREATE INDEX IF NOT EXISTS rag_chunks_emb_ivfflat ' +
              'ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);'
            : `SELECT 1; -- dim ${dim} > 2000: pgvector без индекса, поиск точный (exact)`;

        await this.pool.query(
            `CREATE EXTENSION IF NOT EXISTS vector;
             CREATE TABLE IF NOT EXISTS rag_chunks (
               id TEXT NOT NULL,
               project_key TEXT NOT NULL,
               file_path TEXT NOT NULL DEFAULT '',
               content TEXT NOT NULL,
               description TEXT,
               start_line INTEGER,
               end_line INTEGER,
               language TEXT,
               kind TEXT NOT NULL DEFAULT '',
               role TEXT,
               quirk_type TEXT,
               tags TEXT,
               content_hash TEXT NOT NULL,
               embedding vector(${dim}),
               updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
               PRIMARY KEY (id, project_key)
             );
             CREATE INDEX IF NOT EXISTS rag_chunks_project_idx ON rag_chunks (project_key);
             CREATE INDEX IF NOT EXISTS rag_chunks_hash_idx ON rag_chunks (project_key, content_hash);
             ${vectorIndex}`,
        );
        await setupRagQuota(this.pool,this.quotaPolicy);
    }

    /** Лимит и счётчик принадлежат той же БД, что и знания проекта. */
    public quota(projectKey:string,update?:IRagQuotaUpdate,actor?:string):Promise<IRagQuota>{return ragQuota(this.pool,projectKey,update,actor);}

    /** Размер старого индекса пересчитывается с постоянным ID нового проекта. */
    public async legacyQuotaBytes(source:string,target:string):Promise<number>{
        const {rows}=await this.pool.query('SELECT COALESCE(sum(public.neurocenter_rag_row_bytes(c)-octet_length(project_key)+octet_length($2::text)),0) AS bytes FROM rag_chunks c WHERE project_key=$1',[source,target]);
        const bytes=Number(rows[0].bytes);if(!Number.isSafeInteger(bytes)||bytes<0){throw new Error('Некорректный объём старого индекса');}return bytes;
    }
    public reserveLegacyQuota(projectKey:string,bytes:number):Promise<void>{return reserveLegacyRagQuota(this.pool,projectKey,bytes);}

    /**
     * Снимок сервера для project: `{ id -> content_hash }` (baseline для local diff).
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<Record<string, string>>}
     */
    public async manifest(projectKey: string): Promise<Record<string, string>> {
        const res = await this.pool.query(
            'SELECT id, content_hash FROM rag_chunks WHERE project_key = $1',
            [projectKey],
        );
        const map: Record<string, string> = Object.create(null) as Record<string,string>;
        for (const r of res.rows as IManifestRow[]) {
            map[r.id] = r.content_hash;
        }
        return map;
    }

    /**
     * Суммарная статистика по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<{ rowCount: number; lastSyncedAt: string | null; dimension: number }>}
     */
    public async summary(
        projectKey: string,
    ): Promise<{ rowCount: number; lastSyncedAt: string | null; dimension: number }> {
        const res = await this.pool.query(
            'SELECT count(*)::int AS n, max(updated_at) AS ts FROM rag_chunks WHERE project_key = $1',
            [projectKey],
        );
        const row = res.rows[0] as ISummaryRow | undefined;
        return {
            rowCount: row ? row.n : 0,
            lastSyncedAt: row?.ts ?? null,
            dimension: this.config.dim,
        };
    }

    /**
     * Список develop-индексов по всем projectKey (для админ-модуля RAG).
     *
     * @returns {Promise<IRagProjectSummary[]>}
     */
    public async listProjects(): Promise<IRagProjectSummary[]> {
        const res = await this.pool.query(
            'SELECT project_key, count(*)::int AS n, max(updated_at) AS ts ' +
            'FROM rag_chunks GROUP BY project_key ORDER BY project_key',
        );
        const rows = res.rows as IListProjectRow[];
        return rows.map((r) => ({
            projectKey: r.project_key,
            rowCount: r.n,
            lastSyncedAt: r.ts ?? null,
            dimension: this.config.dim,
        }));
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
            if ((error as {code?:string}).code==='42P01') { return 0; }
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
        upserts: IUpsertRow[],
        deletes: string[],
    ): Promise<{ upserted: number; deleted: number }> {
        // Перезапись строк/индексов и WAL требуют запаса сверх логической квоты RAG.
        const estimate=Math.max(16*1024**2,Buffer.byteLength(JSON.stringify(upserts),'utf8')*6);
        const releaseCapacity=await reserveCapacity({resource:'postgres',bytes:estimate});
        const client = await this.pool.connect().catch(error=>{releaseCapacity();throw error;});
        let deleted = 0;
        let upserted = 0;

        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout='10s'");
            await client.query('LOCK TABLE rag_chunks IN ROW EXCLUSIVE MODE');
            await client.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);

            if (deletes.length > 0) {
                const delRes = await client.query(
                    'DELETE FROM rag_chunks WHERE project_key = $1 AND id = ANY($2)',
                    [projectKey, deletes],
                );
                deleted = delRes.rowCount ?? 0;
            }

            const BATCH = 50;
            for (let i = 0; i < upserts.length; i += BATCH) {
                const batch: IUpsertRow[] = upserts.slice(i, i + BATCH);
                const { sql, params } = buildUpsert(projectKey, batch);
                const insRes = await client.query(sql, params);
                upserted += insRes.rowCount ?? batch.length;
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw mapRagQuotaError(error);
        } finally {
            try{client.release();}finally{releaseCapacity();}
        }

        return { upserted, deleted };
    }

    /**
     * Количество строк develop-индекса по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<number>}
     */
    public async count(projectKey: string): Promise<number> {
        const res = await this.pool.query('SELECT count(*)::int AS n FROM rag_chunks WHERE project_key = $1', [projectKey]);
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
    public async rowsPage(projectKey: string, limit: number, offset: number): Promise<IUpsertRow[]> {
        const res = await this.pool.query(
            'SELECT id, file_path, content, description, start_line, end_line, language, ' +
            'kind, role, quirk_type, tags, content_hash, embedding ' +
            'FROM rag_chunks WHERE project_key = $1 ORDER BY id LIMIT $2 OFFSET $3',
            [projectKey, limit, offset],
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

    /**
     * Закрывает пул (по завершении сервиса).
     *
     * @returns {Promise<void>}
     */
    public async close(): Promise<void> {
        await this.pool.end();
    }
}

/**
 * Преобразует эмбеддинг из postgres в плоский массив чисел. pg отдаёт
 * вектор как строку `'[0.1,0.2,…]'`; если уже массив — возвращает как есть.
 *
 * @param v - сырое значение колонки embedding.
 * @returns {number[] | null}
 */
function parseVector(v: string | number[] | null): number[] | null {
    if (v == null) {
        return null;
    }
    if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed === '' || (trimmed[0] !== '[' && trimmed[trimmed.length - 1] !== ']')) {
            return null;
        }
        try {
            return JSON.parse(trimmed) as number[];
        } catch {
            return null;
        }
    }
    return v;
}

function vectorLiteral(v: number[] | null): string | null {
    if (v == null) {
        return null;
    }
    return `[${v.join(',')}]`;
}

/**
 * Собирает многострочный upsert `INSERT ... VALUES (...), ... ON CONFLICT DO UPDATE`
 * с параметризованными плейсхолдерами (эмбеддинг — строка `'[...]'`::vector).
 */
function buildUpsert(
    projectKey: string,
    rows: IUpsertRow[],
): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const push = (v: unknown): string => {
        params.push(v);
        return `$${params.length}`;
    };
    const tuples: string[] = rows.map((r) => {
        const emb = vectorLiteral(r.embedding);
        return (
            `(${push(r.id)},${push(projectKey)},${push(r.filePath)},${push(r.content)},` +
            `${push(r.description)},${push(r.startLine)},${push(r.endLine)},${push(r.language)},` +
            `${push(r.kind)},${push(r.role)},${push(r.quirkType)},${push(r.tags)},` +
            `${push(r.contentHash)},(${push(emb)})::vector)`
        );
    });
    const sql =
        `INSERT INTO rag_chunks (id, project_key, file_path, content, description, ` +
        `start_line, end_line, language, kind, role, quirk_type, tags, content_hash, embedding) ` +
        `VALUES ${tuples.join(', ')} ` +
        `ON CONFLICT (id, project_key) DO UPDATE SET ` +
        `file_path = EXCLUDED.file_path, content = EXCLUDED.content, description = EXCLUDED.description, ` +
        `start_line = EXCLUDED.start_line, end_line = EXCLUDED.end_line, language = EXCLUDED.language, ` +
        `kind = EXCLUDED.kind, role = EXCLUDED.role, quirk_type = EXCLUDED.quirk_type, ` +
        `tags = EXCLUDED.tags, content_hash = EXCLUDED.content_hash, ` +
        `embedding = EXCLUDED.embedding, updated_at = now()`;
    return { sql, params };
}
