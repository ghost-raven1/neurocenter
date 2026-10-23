import type { Pool } from 'pg';
import {readModelUsageReport} from './model-usage-report';
import type { UsageFilter, UsageInsert, UsageScope, UsageTerminal } from './model-usage.types';

/** Receipts are independent of catalog deletion: historical model attribution is never silently removed. */
export class ModelUsageRepository {
    constructor(readonly pool: Pool) {}
    async begin(value: UsageInsert): Promise<void> {
        await this.pool.query(`INSERT INTO model_usage_calls(id,worker_id,model_id,model_name,provider,endpoint,purpose,actor_email,project_id,agent_id,turn_id,operation_id,lease_until)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '2 minutes')`, [value.id, value.workerId, value.model.id, value.model.name, value.model.runtime,
            value.endpoint, value.purpose, value.actorEmail ?? null, value.projectId ?? null, value.agentId ?? null, value.turnId ?? null, value.operationId ?? null]);
    }
    async finish(id: string, worker: string, value: UsageTerminal): Promise<void> {
        await this.pool.query(`UPDATE model_usage_calls SET status=$3,input_tokens=$4,output_tokens=$5,latency_ms=$6,dispatch_count=$7,dispatched_at=$8,rate_wait_ms=$9,provider_latency_ms=$10,failure_code=$11,finished_at=now(),lease_until=NULL
            WHERE id=$1 AND worker_id=$2 AND status IN ('pending','interrupted')`, [id, worker, value.status, value.inputTokens, value.outputTokens, value.latencyMs, value.dispatchCount ?? null, value.dispatchedAt ?? null, value.rateWaitMs ?? null, value.providerLatencyMs ?? null, value.failureCode ?? null]);
    }
    async recover(): Promise<void> { await this.pool.query("UPDATE model_usage_calls SET status='interrupted',finished_at=now(),lease_until=NULL WHERE status='pending' AND lease_until<=now()"); }
    async renew(worker: string): Promise<void> { await this.pool.query("UPDATE model_usage_calls SET lease_until=now()+interval '2 minutes' WHERE worker_id=$1 AND status='pending' AND lease_until>now()", [worker]); }
    async interrupt(worker: string): Promise<void> { await this.pool.query("UPDATE model_usage_calls SET status='interrupted',finished_at=now(),lease_until=NULL WHERE worker_id=$1 AND status='pending'", [worker]); }
    async canonicalProject(idOrName: string): Promise<string> {
        const row = (await this.pool.query<{ id: string }>("SELECT id FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%') ORDER BY (id=$1) DESC LIMIT 1", [idOrName])).rows[0];
        return row?.id ?? idOrName;
    }
    async report(scope: UsageScope, filter: UsageFilter) {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const result = await readModelUsageReport(db, scope, filter);
            await db.query('COMMIT'); return result;
        } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }
}
