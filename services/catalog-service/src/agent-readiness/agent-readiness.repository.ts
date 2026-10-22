import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { AgentDefinition } from '../../../shared/project-agents.cjs';
import type { StartAgentTrial, AgentTrialReceipt, AgentTrialStatus } from './agent-readiness.types';

export type TrialDb = Pick<PoolClient, 'query'>;
export interface TrialSnapshot { definition: AgentDefinition; agentPin: string; nonce: string; toolPin: string | null }
export interface TrialRow {
    id: string; project_id: string; agent_id: string; owner_email: string; request_id: string; request_hash: string;
    request: StartAgentTrial; snapshot: TrialSnapshot; receipt: AgentTrialReceipt; status: AgentTrialStatus; revision: number;
    lease_token: string; lease_until: Date | null; message: string; created_at: Date; finished_at: Date | null;
}
export const trialPending = (row: Pick<TrialRow, 'status'>): boolean => row.status === 'queued' || row.status === 'running';
export class AgentTrialRepository {
    constructor(readonly pool: Pool) {}
    async transaction<T>(action: (db: TrialDb) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            await db.query("SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='3000ms'");
            const result = await action(db); await db.query('COMMIT'); return result;
        }
        catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; } finally { db.release(); }
    }
    async prior(owner: string, request: string, db: TrialDb = this.pool): Promise<TrialRow | undefined> {
        return (await db.query<TrialRow>('SELECT * FROM agent_readiness_trials WHERE owner_email=$1 AND request_id=$2', [owner, request])).rows[0];
    }
    async owned(owner: string, project: string, agent: string, id: string, db: TrialDb = this.pool, lock = false): Promise<TrialRow> {
        const row = (await db.query<TrialRow>('SELECT * FROM agent_readiness_trials WHERE owner_email=$1 AND project_id=$2 AND agent_id=$3 AND id=$4' + (lock ? ' FOR UPDATE' : ''), [owner, project, agent, id])).rows[0];
        if (!row) throw new NotFoundException('Испытание не найдено.'); return row;
    }
    async latest(owner: string, project: string): Promise<TrialRow[]> {
        return (await this.pool.query<TrialRow>('SELECT DISTINCT ON(agent_id) * FROM agent_readiness_trials WHERE owner_email=$1 AND project_id=$2 ORDER BY agent_id,created_at DESC,id DESC', [owner, project])).rows;
    }
    async expire(): Promise<void> {
        await this.transaction(db => db.query("UPDATE agent_readiness_trials SET status='interrupted',revision=revision+1,lease_until=NULL,finished_at=now(),message='Испытание прервано. Запустите новое испытание явно.' WHERE status IN ('queued','running') AND lease_until<=now()").then(() => undefined));
    }
    async insert(db: TrialDb, row: { id: string; owner: string; project: string; agent: string; hash: string; input: StartAgentTrial; snapshot: TrialSnapshot; receipt: AgentTrialReceipt; lease: string }): Promise<TrialRow> {
        const active = await db.query("SELECT 1 FROM agent_readiness_trials WHERE owner_email=$1 AND project_id=$2 AND agent_id=$3 AND status IN ('queued','running')", [row.owner, row.project, row.agent]);
        if (active.rowCount) throw new ConflictException('Ваше испытание этого агента уже выполняется.');
        return (await db.query<TrialRow>(`INSERT INTO agent_readiness_trials(id,project_id,agent_id,owner_email,request_id,request_hash,request,snapshot,receipt,lease_token,lease_until,message)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,now()+interval '100 seconds','Испытание ожидает запуска.') RETURNING *`,
            [row.id, row.project, row.agent, row.owner, row.input.requestId, row.hash, JSON.stringify(row.input), JSON.stringify(row.snapshot), JSON.stringify(row.receipt), row.lease])).rows[0];
    }
    async save(db: TrialDb, row: TrialRow, status: AgentTrialStatus, receipt: AgentTrialReceipt, message: string): Promise<TrialRow> {
        const result = await db.query<TrialRow>(`UPDATE agent_readiness_trials SET status=$4,receipt=$5::jsonb,message=$6,revision=revision+1,
            finished_at=CASE WHEN $4 IN ('queued','running') THEN NULL ELSE now() END,lease_until=CASE WHEN $4 IN ('queued','running') THEN lease_until ELSE NULL END
            WHERE id=$1 AND lease_token=$2 AND revision=$3 AND status IN ('queued','running') AND lease_until>now() RETURNING *`, [row.id, row.lease_token, row.revision, status, JSON.stringify(receipt), message]);
        if (!result.rows[0]) throw new ConflictException('Испытание уже остановлено или завершено.'); return result.rows[0];
    }
    async stop(id: string, lease: string, status: 'failed' | 'cancelled' | 'interrupted', receipt: AgentTrialReceipt, message: string): Promise<void> {
        await this.transaction(db => db.query(`UPDATE agent_readiness_trials SET status=$3,receipt=$4::jsonb,message=$5,revision=revision+1,lease_until=NULL,finished_at=now()
            WHERE id=$1 AND lease_token=$2 AND status IN ('queued','running')`, [id, lease, status, JSON.stringify(receipt), message]).then(() => undefined));
    }
}
