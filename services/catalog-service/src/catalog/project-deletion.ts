import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { requireRetirementIdle } from '../retired-rag/retirement-guards';

/** Удаление с FK-cascade и единственная запись истории фиксируются одним соединением. */
export async function deleteProjectWithAudit(pool: Pool, idOrName: string, actor: string): Promise<boolean> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const identity = await client.query<{ id: string }>(
            "SELECT id FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%') LIMIT 1",
            [idOrName],
        );
        if (!identity.rows[0]) {
            await client.query('COMMIT');
            return false;
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||$1,0))", [
            identity.rows[0].id,
        ]);
        const selected = await client.query<{ id: string; name: string }>(
            `SELECT id,name FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%')
             ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE`,
            [identity.rows[0].id],
        );
        const project = selected.rows[0];
        if (!project) {
            await client.query('COMMIT');
            return false;
        }
        await requireRetirementIdle(client, project.id);
        const removed = await client.query('DELETE FROM projects WHERE id=$1', [project.id]);
        if (!removed.rowCount) {
            await client.query('COMMIT');
            return false;
        }
        if ((await client.query("SELECT to_regclass('bridge_hosted_rag_grants') AS name")).rows[0]?.name) {
            await client.query(
                'UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=$1 AND revoked_at IS NULL',
                [project.id],
            );
        }
        await client.query(`INSERT INTO project_retirements(project_id,project_name,actor) VALUES($1,$2,$3)`, [
            project.id,
            project.name,
            actor.trim() || 'admin',
        ]);
        await client.query(
            `INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,
                bytes_done,bytes_total,started_at,finished_at,error,log,retries)
             VALUES($1,'DELETE',$2,'project',$2,$3,'SUCCEEDED',100,0,0,now(),now(),NULL,
                jsonb_build_array(jsonb_build_object('at',now(),'level','INFO','message',$4::text)),0)`,
            [`op-${randomUUID()}`, project.id, actor.trim() || 'admin', `Удаление проекта «${project.name}»`],
        );
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}
