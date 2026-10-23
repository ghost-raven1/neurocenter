import type { Pool } from 'pg';

import type { IOperation, IOperationDetail, IOperationPage } from '../catalog/dto';
import { toOperation, toOperationDetail } from './operation-mappers';
import type { IOperationCreate, IOperationReadScope, IOperationRow, IOperationStatePatch } from './operation.types';

/** Один SQL-предикат защищает список и detail; исполнитель не заменяет отозванный доступ к проекту. */
function readScopeCondition(scope: IOperationReadScope, params: unknown[]): string {
    params.push(scope.projectIds, scope.actor);
    return `(project_id = ANY($${params.length - 1}::text[]) OR (project_id IS NULL AND resource_type IN ('bridge','system-role') AND actor=$${params.length}))`;
}

/** Хранит журнал операций; исполнение заданий остаётся в соответствующих очередях. */
export class OperationRepository {
    constructor(private readonly pool: Pool) {}

    /** Метаданные берём из личного задания, сверяя владельца и проект; обычный журнал не затрагивает очередь. */
    private async withBridgeJobs(rows: IOperationRow[]): Promise<IOperationRow[]> {
        const ids = [...new Set(rows.filter(row => row.resource_type === 'bridge'
            && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.resource_id))
            .map(row => row.resource_id))];
        if (!ids.length) { return rows; }
        const jobs = await this.pool.query<{ id: string; email: string; project_id: string | null; kind: string; project_exists: boolean }>(
            `SELECT id, email, project_id, kind,
                EXISTS (SELECT 1 FROM projects WHERE projects.id=bridge_jobs.project_id) AS project_exists
             FROM bridge_jobs WHERE id = ANY($1::text[])`, [ids],
        );
        const byId = new Map(jobs.rows.map(job => [job.id, job]));
        return rows.map(row => {
            const job = row.resource_type === 'bridge' ? byId.get(row.resource_id) : undefined;
            return job && job.email === row.actor && job.project_id === row.project_id
                ? { ...row, bridge_job_kind: job.kind, bridge_job_project_exists: job.project_exists } : row;
        });
    }

    /** Only safe phase metadata is joined; proposal content remains in the private owner endpoint. */
    private async withSystemRoles(rows: IOperationRow[]): Promise<IOperationRow[]> {
        const ids = rows.filter(row => row.resource_type === 'system-role' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.resource_id)).map(row => row.resource_id);
        if (!ids.length) return rows;
        const result = await this.pool.query<{id: string; actor: string; project_id: string | null; agent_id: string; phase: string}>('SELECT id,actor,project_id,agent_id,phase FROM system_role_runs WHERE id=ANY($1::uuid[])', [ids]);
        const byId = new Map(result.rows.map(row => [row.id, row]));
        return rows.map(row => { const run = row.resource_type === 'system-role' ? byId.get(row.resource_id) : undefined;
            return run && run.actor === row.actor && run.project_id === row.project_id ? {...row, system_role_agent_id: run.agent_id, system_role_phase: run.phase} : row; });
    }

    /** Фильтр проекта не заменяет scope; undefined scope используется только для главного администратора. */
    async list(page: number, size: number, projectIds?: string[], state?: string, scope?: IOperationReadScope): Promise<IOperationPage> {
        const offset = (page - 1) * size;
        const where: string[] = [];
        const filterParams: unknown[] = [];
        if (projectIds !== undefined) {
            filterParams.push(projectIds);
            where.push(`project_id = ANY($${filterParams.length}::text[])`);
        }
        if (scope) { where.push(readScopeCondition(scope, filterParams)); }
        if (state) {
            filterParams.push(state);
            where.push(`state = $${filterParams.length}`);
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const [totalResult, rowsResult] = await Promise.all([
            this.pool.query<{ n: number; active: number; active_percent: number; running: number; queued: number }>(
                `SELECT count(*)::int AS n,
                        count(*) FILTER (WHERE state IN ('QUEUED','RUNNING'))::int AS active,
                        COALESCE(avg(LEAST(100, GREATEST(0, percent))) FILTER (WHERE state IN ('QUEUED','RUNNING')), 0)::float8 AS active_percent,
                        count(*) FILTER (WHERE state = 'RUNNING')::int AS running,
                        count(*) FILTER (WHERE state = 'QUEUED')::int AS queued
                 FROM operations ${whereSql}`,
                filterParams,
            ),
            this.pool.query<IOperationRow>(
                `SELECT * FROM operations ${whereSql} ORDER BY created_at DESC LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
                [...filterParams, size, offset],
            ),
        ]);
        const rows = await this.withSystemRoles(await this.withBridgeJobs(rowsResult.rows));
        return {
            items: rows.map(toOperation),
            page,
            size,
            total: totalResult.rows[0].n,
            activeCount: Number(totalResult.rows[0].active),
            activeProgress: {
                percent: Number(totalResult.rows[0].active_percent),
                running: Number(totalResult.rows[0].running),
                queued: Number(totalResult.rows[0].queued),
            },
        };
    }

    async get(operationId: string, scope?: IOperationReadScope): Promise<IOperationDetail | null> {
        const params: unknown[] = [operationId];
        const condition = scope ? ` AND ${readScopeCondition(scope, params)}` : '';
        const result = await this.pool.query<IOperationRow>('SELECT * FROM operations WHERE operation_id = $1' + condition, params);
        const [row] = await this.withSystemRoles(await this.withBridgeJobs(result.rows));
        return row ? toOperationDetail(row) : null;
    }

    /** Сброс ошибки, времён и дополнение журнала выполняются одним UPDATE. */
    async setState(operationId: string, state: string, patch?: IOperationStatePatch): Promise<IOperationDetail | null> {
        const result = await this.pool.query<IOperationRow>(
            `UPDATE operations
             SET state = $2,
                 percent = COALESCE($3, percent),
                 error = CASE WHEN $6::boolean THEN NULL ELSE COALESCE($4, error) END,
                 started_at = CASE WHEN $7::boolean THEN now() ELSE started_at END,
                 finished_at = CASE
                     WHEN $7::boolean THEN NULL
                     WHEN $5::timestamptz IS NULL THEN finished_at
                     ELSE $5::timestamptz
                 END,
                 log = CASE
                     WHEN $8::text IS NULL THEN log
                     ELSE COALESCE(log, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'level', 'INFO', 'message', $8::text))
                 END,
                 retries = CASE WHEN $2 = 'RUNNING' THEN retries + 1 ELSE retries END
             WHERE operation_id = $1 RETURNING *`,
            [operationId, state, patch?.percent ?? null, patch?.error ?? null, patch?.finishedAt ?? null,
                patch?.clearError ?? false, patch?.resetTimes ?? false, patch?.logMessage ?? null],
        );
        const row = result.rows[0];
        return row ? toOperationDetail(row) : null;
    }

    async create(input: IOperationCreate): Promise<IOperation> {
        const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const now = new Date().toISOString();
        const state = input.state ?? 'SUCCEEDED';
        const level = input.error ? 'ERROR' : (state === 'CANCELLED' || state === 'CONFLICT' ? 'WARN' : 'INFO');
        const logJson = JSON.stringify([{ at: now, level, message: input.message ?? input.type }]);
        const result = await this.pool.query<IOperationRow>(
            `INSERT INTO operations (operation_id, type, project_id, resource_type, resource_id, actor, state, percent, bytes_done, bytes_total, started_at, finished_at, error, log, retries)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9,$10,$11,$12::jsonb,0) RETURNING *`,
            [id, input.type, input.projectId ?? null, input.resourceType ?? null, input.resourceId ?? null,
                input.actor?.trim() || 'admin', state, input.percent ?? 100, now,
                (state === 'RUNNING' || state === 'QUEUED') ? null : now, input.error ?? null, logJson],
        );
        return toOperation(result.rows[0]);
    }
}
