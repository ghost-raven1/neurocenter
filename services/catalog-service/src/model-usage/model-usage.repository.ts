import type { Pool } from 'pg';
import type { ModelUsageItem, ModelUsageTotals, UsageFilter, UsageInsert, UsageScope, UsageTerminal } from './model-usage.types';

const totals = `count(*) AS requests,count(*) FILTER(WHERE status='success') AS success,count(*) FILTER(WHERE status='error') AS error,
count(*) FILTER(WHERE status='cancelled') AS cancelled,count(*) FILTER(WHERE status='interrupted') AS interrupted,count(*) FILTER(WHERE status='pending') AS pending,
sum(input_tokens) AS "inputTokens",sum(output_tokens) AS "outputTokens",count(input_tokens) AS "knownInputRequests",count(output_tokens) AS "knownOutputRequests",
count(*) FILTER(WHERE input_tokens IS NULL) AS "unknownInputRequests",count(*) FILTER(WHERE output_tokens IS NULL) AS "unknownOutputRequests",avg(latency_ms) AS "averageLatencyMs"`;
const numericTotals = (row: Record<string, unknown>): ModelUsageTotals => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : ['inputTokens', 'outputTokens'].includes(key) ? String(value) : Number(value)])) as unknown as ModelUsageTotals;

/** Receipts are independent of catalog deletion: historical model attribution is never silently removed. */
export class ModelUsageRepository {
    constructor(readonly pool: Pool) {}
    async begin(value: UsageInsert): Promise<void> {
        await this.pool.query(`INSERT INTO model_usage_calls(id,worker_id,model_id,model_name,provider,endpoint,purpose,actor_email,project_id,agent_id,turn_id,operation_id,lease_until)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '2 minutes')`, [value.id, value.workerId, value.model.id, value.model.name, value.model.runtime,
            value.endpoint, value.purpose, value.actorEmail ?? null, value.projectId ?? null, value.agentId ?? null, value.turnId ?? null, value.operationId ?? null]);
    }
    async finish(id: string, worker: string, value: UsageTerminal): Promise<void> {
        await this.pool.query(`UPDATE model_usage_calls SET status=$3,input_tokens=$4,output_tokens=$5,latency_ms=$6,finished_at=now(),lease_until=NULL
            WHERE id=$1 AND worker_id=$2 AND status IN ('pending','interrupted')`, [id, worker, value.status, value.inputTokens, value.outputTokens, value.latencyMs]);
    }
    async recover(): Promise<void> { await this.pool.query("UPDATE model_usage_calls SET status='interrupted',finished_at=now(),lease_until=NULL WHERE status='pending' AND lease_until<=now()"); }
    async renew(worker: string): Promise<void> { await this.pool.query("UPDATE model_usage_calls SET lease_until=now()+interval '2 minutes' WHERE worker_id=$1 AND status='pending' AND lease_until>now()", [worker]); }
    async interrupt(worker: string): Promise<void> { await this.pool.query("UPDATE model_usage_calls SET status='interrupted',finished_at=now(),lease_until=NULL WHERE worker_id=$1 AND status='pending'", [worker]); }
    async report(scope: UsageScope, filter: UsageFilter) {
        const values: unknown[] = [filter.days, scope.all, scope.actor, scope.projectIds], where = ["started_at>=now()-($1::integer*interval '1 day')", '($2 OR ($3::text IS NOT NULL AND actor_email=$3 AND (project_id IS NULL OR project_id=ANY($4::text[]))) OR ($3::text IS NULL AND project_id=ANY($4::text[])))'];
        const bind = (value: unknown): string => { values.push(value); return '$' + values.length; };
        for (const [column, value] of [['project_id', filter.projectId], ['model_id', filter.modelId], ['purpose', filter.purpose], ['status', filter.status]]) if (value !== undefined) where.push(column + '=' + bind(value));
        const clause = where.join(' AND ');
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const summary = numericTotals((await db.query('SELECT ' + totals + ' FROM model_usage_calls WHERE ' + clause, values)).rows[0]);
            const byModel = (await db.query(`SELECT model_id,max(model_name) AS name,${totals} FROM model_usage_calls WHERE ${clause} GROUP BY model_id ORDER BY count(*) DESC,model_id LIMIT 100`, values)).rows.map(({ model_id, name, ...row }) => ({ modelId: model_id, name, ...numericTotals(row) }));
            const byPurpose = (await db.query(`SELECT purpose,${totals} FROM model_usage_calls WHERE ${clause} GROUP BY purpose ORDER BY count(*) DESC,purpose`, values)).rows.map(({ purpose, ...row }) => ({ purpose, ...numericTotals(row) }));
            const page = [...values]; let cursor = '';
            if (filter.cursor) { page.push(filter.cursor.startedAt, filter.cursor.id); cursor = ` AND (started_at,id)<($${page.length - 1}::timestamptz,$${page.length}::uuid)`; }
            page.push(filter.limit + 1);
            const rows = (await db.query(`SELECT id,model_id AS "modelId",model_name AS "modelName",provider,endpoint,purpose,actor_email AS "actorEmail",project_id AS "projectId",agent_id AS "agentId",turn_id AS "turnId",operation_id AS "operationId",
                status,started_at AS "startedAt",to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt",finished_at AS "finishedAt",latency_ms AS "latencyMs",input_tokens AS "inputTokens",output_tokens AS "outputTokens" FROM model_usage_calls WHERE ${clause}${cursor} ORDER BY started_at DESC,id DESC LIMIT $${page.length}`, page)).rows;
            await db.query('COMMIT');
            const items = rows.slice(0, filter.limit).map(({ cursorAt: _cursorAt, ...row }) => ({ ...row, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
                inputTokens: row.inputTokens === null ? null : Number(row.inputTokens), outputTokens: row.outputTokens === null ? null : Number(row.outputTokens) })) as ModelUsageItem[];
            const last = rows[Math.min(rows.length, filter.limit) - 1];
            return { summary, byModel, byPurpose, items, hasMore: rows.length > filter.limit, cursor: last ? { startedAt: last.cursorAt as string, id: last.id as string } : null };
        } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }
}
