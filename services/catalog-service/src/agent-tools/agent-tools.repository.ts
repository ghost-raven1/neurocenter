import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { agentToolHash } from './agent-tools.validation';
import type { AgentToolDb, AgentToolOwner, AgentToolStepRow } from './agent-tools.types';

/** Each transaction owns one client; an uncertain rollback discards it while retaining the primary error. */
export class AgentToolsRepository {
    constructor(readonly pool: Pool) {}
    private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        let discard = false;
        try {
            await db.query('BEGIN');
            await db.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
            const result = await work(db);
            await db.query('COMMIT');
            return result;
        } catch (error) {
            try {
                await db.query('ROLLBACK');
            } catch {
                discard = true;
            }
            throw error;
        } finally {
            if (discard) db.release(true);
            else db.release();
        }
    }
    async reserve(
        owner: AgentToolOwner,
        sequence: number,
        action: string,
        input: Record<string, unknown>,
        deadline: number,
        authorize: (db: AgentToolDb) => Promise<void>,
    ): Promise<AgentToolStepRow> {
        const hash = agentToolHash({ owner, action, input });
        return this.transaction(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                JSON.stringify(['agent-tools', owner.kind, owner.turnId, owner.recipientId, owner.generation]),
            ]);
            await authorize(db);
            const old = (
                await db.query<AgentToolStepRow>(
                    'SELECT * FROM agent_tool_steps WHERE owner_kind=$1 AND turn_id=$2 AND recipient_id=$3 AND generation=$4 AND sequence=$5 FOR UPDATE',
                    [owner.kind, owner.turnId, owner.recipientId, owner.generation, sequence],
                )
            ).rows[0];
            if (old) {
                if (old.input_hash !== hash) throw new ConflictException('Шаг уже связан с другим запросом.');
                return old;
            }
            if (deadline <= Date.now()) throw new ConflictException('Истёк срок инструментального запроса.');
            // A single PostgreSQL clock owns the physical window; host clock skew cannot widen its two-minute bound.
            return (
                await db.query<AgentToolStepRow>(
                    `INSERT INTO agent_tool_steps(id,owner_kind,origin_id,turn_id,recipient_id,generation,owner_email,actor_role,project_id,agent_id,model_id,model_pin,grant_snapshot,sequence,action,input,input_hash,deadline_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,$17,LEAST($18::timestamptz,statement_timestamp()+interval '2 minutes'),statement_timestamp(),statement_timestamp()) RETURNING *`,
                    [
                        randomUUID(),
                        owner.kind,
                        owner.originId,
                        owner.turnId,
                        owner.recipientId,
                        owner.generation,
                        owner.ownerEmail,
                        owner.actorRole,
                        owner.projectId,
                        owner.agentId,
                        owner.modelId,
                        owner.modelPin,
                        JSON.stringify(owner.grant),
                        sequence,
                        action,
                        JSON.stringify(input),
                        hash,
                        new Date(deadline),
                    ],
                )
            ).rows[0];
        });
    }
    async dispatch(id: string, authorize: (db: AgentToolDb) => Promise<void>): Promise<AgentToolStepRow> {
        return this.transaction(async (db) => {
            const row = (
                await db.query<AgentToolStepRow>('SELECT * FROM agent_tool_steps WHERE id=$1 FOR UPDATE', [id])
            ).rows[0];
            if (!row || row.state !== 'queued' || Date.parse(String(row.deadline_at)) <= Date.now())
                throw new ConflictException(
                    'Отправка уже началась или запрос остановлен. Автоматического повтора нет.',
                );
            await authorize(db);
            return (
                await db.query<AgentToolStepRow>(
                    "UPDATE agent_tool_steps SET state='dispatched',dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state='queued' RETURNING *",
                    [id],
                )
            ).rows[0];
        });
    }
    async reference(id: string, value: Record<string, unknown>): Promise<void> {
        if (Buffer.byteLength(JSON.stringify(value)) > 4096)
            throw new BadRequestException('Ссылка инструмента слишком велика.');
        const result = await this.pool.query(
            "UPDATE agent_tool_steps SET reference=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND state='dispatched' AND deadline_at>clock_timestamp() AND (reference IS NULL OR reference=$2::jsonb)",
            [id, JSON.stringify(value)],
        );
        if (!result.rowCount) throw new ConflictException('Шаг уже остановлен; ссылка не принята.');
    }
    async complete(
        id: string,
        output: unknown,
        authorize: (db: AgentToolDb) => Promise<void>,
    ): Promise<AgentToolStepRow> {
        const json = JSON.stringify(output);
        if (!json || Buffer.byteLength(json) > 32768)
            throw new BadRequestException('Результат инструмента превышает 32 КиБ.');
        return this.transaction(async (db) => {
            const row = (
                await db.query<AgentToolStepRow>('SELECT * FROM agent_tool_steps WHERE id=$1 FOR UPDATE', [id])
            ).rows[0];
            if (!row || row.state !== 'dispatched' || Date.parse(String(row.deadline_at)) <= Date.now())
                throw new ConflictException('Поздний результат инструмента не принят.');
            await authorize(db);
            return (
                await db.query<AgentToolStepRow>(
                    "UPDATE agent_tool_steps SET state='succeeded',output=$2::jsonb,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
                    [id, json],
                )
            ).rows[0];
        });
    }
    /** Cleanup never publishes output after lost authority and never changes a terminal receipt. */
    async interrupted(id: string, message: string): Promise<void> {
        await this.pool.query(
            `UPDATE agent_tool_steps SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE 'cancelled' END,
  error=$2,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state IN ('queued','dispatched')`,
            [id, message.slice(0, 1000)],
        );
    }
    /** A losing dispatch may cancel only its still-queued intent; it cannot invalidate another dispatcher. */
    async abandonQueued(id: string): Promise<void> {
        await this.pool.query(
            "UPDATE agent_tool_steps SET state='cancelled',error='Отправка не была принята.',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state='queued'",
            [id],
        );
    }
    private async expire(owner: string): Promise<void> {
        await this.pool.query(
            `UPDATE agent_tool_steps SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE 'cancelled' END,
  error='Срок выполнения истёк. Автоматического повтора нет.',finished_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE owner_email=$1 AND state IN ('queued','dispatched') AND deadline_at<=clock_timestamp()`,
            [owner],
        );
    }
    async list(owner: string, projectId: string, turnId: string): Promise<AgentToolStepRow[]> {
        await this.expire(owner);
        return (
            await this.pool.query<AgentToolStepRow>(
                'SELECT * FROM agent_tool_steps WHERE owner_email=$1 AND project_id=$2 AND turn_id=$3 ORDER BY created_at,id LIMIT 48',
                [owner, projectId, turnId],
            )
        ).rows;
    }
    async get(owner: string, id: string): Promise<AgentToolStepRow> {
        await this.expire(owner);
        const row = (
            await this.pool.query<AgentToolStepRow>('SELECT * FROM agent_tool_steps WHERE id=$1 AND owner_email=$2', [
                id,
                owner,
            ])
        ).rows[0];
        if (!row) throw new NotFoundException('Шаг инструмента недоступен.');
        return row;
    }
}
