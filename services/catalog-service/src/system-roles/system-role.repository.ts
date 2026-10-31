import { ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { projectRoleOperation } from './system-role.operations';
import { ROLE_BUDGET, roleCallBudget } from './system-role.definitions';
import type { RoleRunRow, RoleRunState, SystemRoleId } from './system-role.types';

export type RoleDb = Pick<PoolClient, 'query'>;
export type RoleExecutionLane = 'server' | 'device-codex';
const lost = (): never => {
    throw new ConflictException('Задание изменилось, отменено или потеряло lease. Обновите состояние.');
};
type RolePatch = Partial<Pick<RoleRunRow, 'facts' | 'result' | 'applied'>>;
/** One journal serves builtin roles; a new process never claims another process's paid work.
 * Identity is immutable, so NO KEY UPDATE serializes state while allowing a dialog's FK receipt attachment.
 */
export class SystemRoleRepository {
    constructor(
        readonly pool: Pool,
        readonly instance = randomUUID(),
    ) {}
    async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            const result = await work(db);
            await db.query('COMMIT');
            return result;
        } catch (cause) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw cause;
        } finally {
            db.release();
        }
    }
    async get(id: string, db: RoleDb = this.pool, lock = false): Promise<RoleRunRow | null> {
        return (
            (
                await db.query<RoleRunRow>(
                    'SELECT * FROM system_role_runs WHERE id=$1' + (lock ? ' FOR NO KEY UPDATE' : ''),
                    [id],
                )
            ).rows[0] ?? null
        );
    }
    async existing(actor: string, request: string, db: RoleDb = this.pool): Promise<RoleRunRow | null> {
        return (
            (
                await db.query<RoleRunRow>('SELECT * FROM system_role_runs WHERE actor=$1 AND request_id=$2', [
                    actor,
                    request,
                ])
            ).rows[0] ?? null
        );
    }
    async list(actor: string, agent: SystemRoleId, project: string | null): Promise<RoleRunRow[]> {
        return (
            await this.pool.query<RoleRunRow>(
                'SELECT * FROM system_role_runs WHERE actor=$1 AND agent_id=$2 AND project_id IS NOT DISTINCT FROM $3 ORDER BY created_at DESC,id DESC LIMIT 20',
                [actor, agent, project],
            )
        ).rows;
    }
    async create(
        input: Pick<
            RoleRunRow,
            | 'agent_id'
            | 'project_id'
            | 'actor'
            | 'actor_role'
            | 'request_id'
            | 'request_hash'
            | 'request'
            | 'snapshot'
            | 'model'
        >,
        authorize: (db: RoleDb) => Promise<void>,
        accepted?: (db: RoleDb, row: RoleRunRow) => Promise<void>,
    ): Promise<RoleRunRow> {
        return this.transaction(async (db) => {
            await authorize(db);
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('system-role-create',0))");
            const old = await this.existing(input.actor, input.request_id, db);
            if (old) {
                if (old.request_hash !== input.request_hash)
                    throw new ConflictException('Ключ запроса относится к другому запуску.');
                await accepted?.(db, old);
                return old;
            }
            if (
                (
                    await db.query(
                        "SELECT 1 FROM system_role_runs WHERE actor=$1 AND agent_id=$2 AND project_id IS NOT DISTINCT FROM $3 AND state IN ('queued','running','applying')",
                        [input.actor, input.agent_id, input.project_id],
                    )
                ).rowCount
            )
                throw new ConflictException('Дождитесь или отмените предыдущий запуск этого агента.');
            const lane: RoleExecutionLane = input.model.runtime === 'device-codex' ? 'device-codex' : 'server';
            // Keep one place for the other transport within the shared eight-intent budget.
            const pending = (
                await db.query<{ total: string; lane: string }>(
                    `SELECT count(*) AS total,
                count(*) FILTER (WHERE CASE WHEN model->>'runtime'='device-codex' THEN 'device-codex' ELSE 'server' END=$1) AS lane
                FROM system_role_runs WHERE state IN ('queued','running','applying')`,
                    [lane],
                )
            ).rows[0];
            if (Number(pending.total) >= 8 || Number(pending.lane) >= 7)
                throw new ConflictException('Системные агенты заняты. Повторите запуск позднее.');
            const now = new Date().toISOString(),
                step = { at: now, phase: 'queued', message: 'Явный запуск системного агента принят.' };
            const row = (
                await db.query<RoleRunRow>(
                    `INSERT INTO system_role_runs(id,agent_id,project_id,actor,actor_role,request_id,request_hash,request,snapshot,model,runner_instance,lease_token,lease_until,message,steps)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,now()+($13::int*interval '1 millisecond'),$14,$15::jsonb) RETURNING *`,
                    [
                        randomUUID(),
                        input.agent_id,
                        input.project_id,
                        input.actor,
                        input.actor_role,
                        input.request_id,
                        input.request_hash,
                        JSON.stringify(input.request),
                        JSON.stringify(input.snapshot),
                        JSON.stringify(input.model),
                        this.instance,
                        randomUUID(),
                        ROLE_BUDGET.deadlineMs,
                        step.message,
                        JSON.stringify([step]),
                    ],
                )
            ).rows[0];
            await accepted?.(db, row);
            await projectRoleOperation(db, row);
            return row;
        });
    }
    async claim(lanes: readonly RoleExecutionLane[] = ['server', 'device-codex']): Promise<RoleRunRow | null> {
        if (!lanes.length) return null;
        return this.transaction(async (db) => {
            const row = (
                await db.query<RoleRunRow>(
                    `SELECT * FROM system_role_runs WHERE runner_instance=$1 AND state='queued' AND lease_until>now()
                AND CASE WHEN model->>'runtime'='device-codex' THEN 'device-codex' ELSE 'server' END=ANY($2::text[])
                ORDER BY created_at,id LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED`,
                    [this.instance, lanes],
                )
            ).rows[0];
            return row
                ? this.change(db, row, 'running', 'collecting', 'Собираем выбранные диагностические сведения.')
                : null;
        });
    }
    async fenced<T>(id: string, lease: string, work: (db: RoleDb, row: RoleRunRow) => Promise<T>): Promise<T> {
        return this.transaction(async (db) => {
            const row = (
                await db.query<RoleRunRow>(
                    "SELECT * FROM system_role_runs WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>now() FOR NO KEY UPDATE",
                    [id, lease],
                )
            ).rows[0];
            if (!row) return lost();
            return work(db, row);
        });
    }
    async reserveCall(
        id: string,
        lease: string,
        authorize: (db: RoleDb, row: RoleRunRow) => Promise<void>,
    ): Promise<RoleRunRow> {
        return this.fenced(id, lease, async (db, row) => {
            await authorize(db, row);
            if (row.calls_started >= roleCallBudget(row.agent_id, !!row.request.mcp?.length)) return lost();
            row.calls_started++;
            return this.change(db, row, 'running', 'model_step', 'Запускаем ограниченный вызов выбранной модели.');
        });
    }
    async applying(id: string, phase: string, db: RoleDb): Promise<RoleRunRow> {
        const row = (
            await db.query<RoleRunRow>(
                "SELECT * FROM system_role_runs WHERE id=$1 AND state='applying' AND phase=$2 AND lease_until>now() FOR NO KEY UPDATE",
                [id, phase],
            )
        ).rows[0];
        if (!row) return lost();
        return row;
    }
    async change(
        db: RoleDb,
        row: RoleRunRow,
        state: RoleRunState,
        phase: string,
        message: string,
        patch: RolePatch = {},
    ): Promise<RoleRunRow> {
        const steps = [...row.steps, { at: new Date().toISOString(), phase, message }].slice(-32);
        const active = ['queued', 'running'].includes(state);
        const result = patch.result === undefined ? row.result : patch.result;
        const updated = (
            await db.query<RoleRunRow>(
                `UPDATE system_role_runs SET state=$2,phase=$3,message=$4,revision=revision+1,steps=$5::jsonb,
            facts=$6::jsonb,result=$7::jsonb,applied=$8::jsonb,calls_started=$11,lease_until=CASE WHEN $2='applying' THEN now()+interval '60 seconds' WHEN $9 THEN lease_until ELSE NULL END,
            finished_at=CASE WHEN $2 IN ('queued','running','awaiting_review','applying') THEN NULL ELSE now() END
            WHERE id=$1 AND revision=$10 RETURNING *`,
                [
                    row.id,
                    state,
                    phase,
                    message,
                    JSON.stringify(steps),
                    JSON.stringify(patch.facts ?? row.facts),
                    result === null ? null : JSON.stringify(result),
                    JSON.stringify(patch.applied ?? row.applied),
                    active,
                    row.revision,
                    row.calls_started,
                ],
            )
        ).rows[0];
        if (!updated) return lost();
        await projectRoleOperation(db, updated);
        return updated;
    }
    async expire(): Promise<void> {
        await this.transaction(async (db) => {
            const rows = (
                await db.query<RoleRunRow>(
                    "SELECT * FROM system_role_runs WHERE state IN ('queued','running','applying') AND lease_until<=now() FOR NO KEY UPDATE SKIP LOCKED",
                )
            ).rows;
            for (const row of rows)
                await this.change(
                    db,
                    row,
                    'interrupted',
                    'interrupted',
                    row.state === 'applying'
                        ? 'Исход применения не подтверждён. Проверьте настройки у владельца перед новым действием.'
                        : 'Исполнение прервано. Новый вызов модели требует явного запуска.',
                );
        });
    }
}
