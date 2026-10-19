import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import type { HostingAction, IHostingJobRow, IHostingProgress } from './hosting.types';

/** Операции переживают перезапуск; незавершённая загрузка требует явного повтора. */
export class ModelHostingRepository {
    constructor(private readonly pool: Pool) {}

    async setup(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-hosting-schema',0))");
            await client.query(`CREATE TABLE IF NOT EXISTS model_hosting_jobs (
            id text PRIMARY KEY, model_id text NOT NULL, action text NOT NULL, actor text NOT NULL,
            state text NOT NULL, stage text NOT NULL, message text NOT NULL, progress integer,
            started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
            operation_id text NOT NULL UNIQUE);
            CREATE INDEX IF NOT EXISTS model_hosting_jobs_model ON model_hosting_jobs(model_id,started_at DESC)`);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    async latest(modelId: string): Promise<IHostingJobRow | undefined> {
        return (await this.pool.query<IHostingJobRow>('SELECT * FROM model_hosting_jobs WHERE model_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1', [modelId])).rows[0];
    }

    async checkedAt(modelId: string): Promise<string | null> {
        const row = (await this.pool.query<{ finished_at: Date }>(`SELECT finished_at FROM model_hosting_jobs
            WHERE model_id=$1 AND state='completed' AND action IN ('start','check') ORDER BY finished_at DESC LIMIT 1`, [modelId])).rows[0];
        return row ? new Date(row.finished_at).toISOString() : null;
    }

    /** Вызов разрешён только владельцу общей управляющей блокировки runtime. */
    async interruptStale(): Promise<void> {
        const rows = (await this.pool.query<IHostingJobRow>("SELECT * FROM model_hosting_jobs WHERE state='running'")).rows;
        for (const row of rows) {
            await this.update(row, { stage: 'interrupted', message: 'Управление хостингом прервано перезапуском. Повторите действие; сохранённые веса используются повторно.', progress: row.progress }, 'failed');
        }
    }

    async create(client: PoolClient, modelId: string, action: HostingAction, actor: string): Promise<IHostingJobRow> {
        const id = randomUUID(), operationId = 'op-model-' + id;
        const message = action === 'start' ? 'Подготовка хостинга модели' : action === 'stop' ? 'Выгрузка модели из памяти' : 'Проверка модели';
        await client.query('BEGIN');
        try {
            const row = (await client.query<IHostingJobRow>(`INSERT INTO model_hosting_jobs(id,model_id,action,actor,state,stage,message,progress,operation_id)
                VALUES($1,$2,$3,$4,'running','starting',$5,0,$6) RETURNING *`, [id, modelId, action, actor, message, operationId])).rows[0];
            await client.query(`INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,bytes_done,bytes_total,started_at,finished_at,error,log,retries)
                VALUES($1,'MODEL',NULL,'model',$2,$3,'RUNNING',0,0,0,now(),NULL,NULL,$4::jsonb,0)`,
            [operationId, modelId, actor, JSON.stringify([{ at: new Date().toISOString(), level: 'INFO', message }])]);
            await securityEvent(client, { actor, action: 'model.hosting.' + action, resourceId: modelId, before: null, after: { jobId: id, state: 'running' } });
            await client.query('COMMIT');
            return row;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
    }

    async update(row: IHostingJobRow, progress: IHostingProgress, state: IHostingJobRow['state'] = 'running'): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const updated = await client.query(`UPDATE model_hosting_jobs SET state=$2,stage=$3,message=$4,progress=$5,
                finished_at=CASE WHEN $2='running' THEN NULL ELSE now() END WHERE id=$1 AND state='running' RETURNING id`,
            [row.id, state, progress.stage, progress.message.slice(0, 1000), progress.progress]);
            if (updated.rowCount) {
                await client.query(`UPDATE operations SET state=$2,percent=COALESCE($3,percent),
                    finished_at=CASE WHEN $2='RUNNING' THEN NULL ELSE now() END,error=$4,
                    log=COALESCE(log,'[]'::jsonb)||$5::jsonb WHERE operation_id=$1`,
                [row.operation_id, state === 'running' ? 'RUNNING' : state === 'completed' ? 'SUCCEEDED' : 'FAILED', progress.progress,
                    state === 'failed' ? progress.message.slice(0, 1000) : null,
                    JSON.stringify([{ at: new Date().toISOString(), level: state === 'failed' ? 'ERROR' : 'INFO', message: progress.message.slice(0, 1000) }])]);
                if (state !== 'running') { await securityEvent(client, { actor: row.actor, action: 'model.hosting.' + state, resourceId: row.model_id, before: { jobId: row.id, state: 'running' }, after: { jobId: row.id, state } }); }
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
}
