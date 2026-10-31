import { ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IAccessActor } from '../access/access.model';
import { publicationHash } from '../publication/publication-validation';
import { authorizeAgentWrite } from './agent-access';
import { request } from './agent-validation';
/** A durable result prevents lost HTTP acknowledgements from creating a second version or changing a later edit. */
export async function agentMutation<T>(
    pool: Pool,
    actor: IAccessActor,
    key: unknown,
    operation: string,
    input: unknown,
    projectId: string | undefined,
    work: (db: PoolClient) => Promise<T>,
): Promise<T> {
    request(key);
    const hash = publicationHash({ role: actor.activeRole, operation, input }),
        db = await pool.connect();
    try {
        await db.query('BEGIN');
        await authorizeAgentWrite(db, actor, projectId);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            'agent-request:' + actor.email + ':' + key,
        ]);
        const old = (
            await db.query<{ request_hash: string; result: T }>(
                'SELECT request_hash,result FROM agent_mutation_requests WHERE actor=$1 AND request_key=$2',
                [actor.email, key],
            )
        ).rows[0];
        if (old) {
            if (old.request_hash !== hash)
                throw new ConflictException('Ключ запроса уже относится к другому изменению агента.');
            await db.query('COMMIT');
            return old.result;
        }
        const result = await work(db);
        await db.query(
            'INSERT INTO agent_mutation_requests(actor,request_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
            [actor.email, key, hash, JSON.stringify(result)],
        );
        await db.query('COMMIT');
        return result;
    } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        if ((error as { code?: string }).code === '23505')
            throw new ConflictException('Имя агента или версия уже заняты. Обновите каталог.');
        throw error;
    } finally {
        db.release();
    }
}
