import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { BuildConfiguration, BuildResult, BuildRow, BuildState } from './package-build.model';

/** Очередь сборки и её проекция в «Операциях» фиксируются одной транзакцией. */
export class PackageBuildRepository {
    constructor(private readonly pool: Pool) {}
    async setup(): Promise<void> {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_build_jobs (
            id uuid PRIMARY KEY,actor text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,config jsonb NOT NULL,
            state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),percent integer NOT NULL DEFAULT 0,
            message text NOT NULL,result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(actor,request_key));
            DROP INDEX IF EXISTS tool_build_one_active;
            CREATE UNIQUE INDEX IF NOT EXISTS tool_build_one_running ON tool_build_jobs ((true)) WHERE state='RUNNING';`);
    }
    async existing(actor: string, key: string, fingerprint: string): Promise<BuildRow | undefined> {
        const {rows} = await this.pool.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2', [actor, key]);
        if (rows[0] && rows[0].request_hash !== fingerprint) { throw new ConflictException('Ключ запроса уже использован для другой сборки.'); }
        return rows[0];
    }
    async get(id: string): Promise<BuildRow> {
        const {rows} = await this.pool.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE id=$1', [id]);
        if (!rows[0]) { throw new NotFoundException('Сборка не найдена.'); }
        return rows[0];
    }
    async findByRequest(actor: string, key: string): Promise<BuildRow> {
        const {rows} = await this.pool.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2', [actor, key]);
        if (!rows[0]) {throw new NotFoundException('Сборка по этому запросу ещё не найдена.');}
        return rows[0];
    }
    async enqueue(actor: string, key: string, fingerprint: string, config: BuildConfiguration, lease?: PoolClient,retain?: (client:PoolClient)=>Promise<void>): Promise<BuildRow> {
        return this.transaction(async client => {
            await client.query('SELECT pg_advisory_xact_lock(72465396)');
            const previous = await client.query<BuildRow>('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2', [actor, key]);
            if (previous.rows[0]) {
                if (previous.rows[0].request_hash !== fingerprint) { throw new ConflictException('Ключ запроса уже использован для другой сборки.'); }
                return previous.rows[0];
            }
            if(retain)await retain(client);
            const pending = await client.query<{count: number}>("SELECT count(*)::int AS count FROM tool_build_jobs WHERE state IN ('QUEUED','RUNNING')");
            if ((pending.rows[0]?.count ?? 0) >= 10) { throw new ConflictException('В очереди уже 10 сборок. Дождитесь освобождения места в «Операциях» и повторите запрос.'); }
            const {rows} = await client.query<BuildRow>(`INSERT INTO tool_build_jobs(id,actor,request_key,request_hash,config,state,message)
                VALUES($1,$2,$3,$4,$5,'QUEUED','В очереди сборки. Начнём после предыдущих инструментов.') RETURNING *`, [randomUUID(), actor, key, fingerprint, config]);
            await this.operation(client, rows[0]);
            return rows[0];
        }, lease);
    }
    /** Единственный владелец запускает задания по порядку, сохраняя ожидающие при перезапуске. */
    async takeQueued(lease: PoolClient): Promise<BuildRow | undefined> {
        return this.transaction(async client => {
            const {rows} = await client.query<BuildRow>("SELECT * FROM tool_build_jobs WHERE state='QUEUED' ORDER BY created_at,id LIMIT 1 FOR UPDATE");
            if (!rows[0]) {return undefined;}
            return this.saveProgress(client, rows[0].id, 'RUNNING', 0, 'Подготовка сборки');
        }, lease);
    }
    async progress(id: string, state: BuildState, percent: number, message: string, result?: BuildResult, error?: string): Promise<BuildRow> {
        return this.transaction(client => this.saveProgress(client, id, state, percent, message, result, error));
    }
    /** Карточка, аудит публикации и успешная сборка используют один внешний COMMIT. */
    async completeWithPublication(client: PoolClient, id: string, result: BuildResult): Promise<void> {
        await this.saveProgress(client, id, 'SUCCEEDED', 100, 'Инструмент опубликован. Его можно установить через мост.', result);
    }
    private async saveProgress(client: PoolClient, id: string, state: BuildState, percent: number, message: string, result?: BuildResult, error?: string): Promise<BuildRow> {
        const {rows} = await client.query<BuildRow>(`UPDATE tool_build_jobs SET state=$2,percent=$3,message=$4,result=$5,error=$6,updated_at=now()
                WHERE id=$1 AND state IN ('QUEUED','RUNNING') RETURNING *`, [id, state, percent, message, result ?? null, error ?? null]);
        if (!rows[0]) { throw new ConflictException('Сборка уже завершена или её прервал перезапуск сервера.'); }
        await this.operation(client, rows[0]);
        return rows[0];
    }
    /** Вызывается только владельцем межпроцессного advisory lock: живую реплику не прерываем. */
    async failInterrupted(lease?: PoolClient): Promise<void> {
        await this.transaction(async client => {
            const {rows} = await client.query<BuildRow>(`UPDATE tool_build_jobs SET state='FAILED',message='Сборка прервана перезапуском сервера',
                error='Сервер перезапустился. Повторите сборку новым запросом; уже опубликованные карточки сохранены.',updated_at=now()
                WHERE state='RUNNING' RETURNING *`);
            for (const row of rows) { await this.operation(client, row); }
        }, lease);
    }
    private async operation(client: PoolClient, row: BuildRow): Promise<void> {
        const entry = JSON.stringify([{at: new Date().toISOString(), level: row.state === 'FAILED' ? 'ERROR' : 'INFO', message: row.message}]);
        await client.query(`INSERT INTO operations(operation_id,type,resource_type,resource_id,actor,state,percent,started_at,finished_at,error,log)
            VALUES($1,'BUILD','tool-build',$2,$3,$4,$5,CASE WHEN $4='QUEUED' THEN NULL ELSE now() END,
                CASE WHEN $4 IN ('QUEUED','RUNNING') THEN NULL ELSE now() END,$6,$7::jsonb)
            ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,percent=EXCLUDED.percent,error=EXCLUDED.error,
                started_at=COALESCE(operations.started_at,EXCLUDED.started_at),finished_at=EXCLUDED.finished_at,log=operations.log||EXCLUDED.log`,
        ['tool-build-' + row.id, row.id, row.actor, row.state, row.percent, row.error, entry]);
    }
    private async transaction<T>(work: (client: PoolClient) => Promise<T>, borrowedClient?: PoolClient): Promise<T> {
        const client = borrowedClient ?? await this.pool.connect();
        try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { if (!borrowedClient) {client.release();} }
    }
}
