import type { Pool, PoolClient } from 'pg';
import { insertHostedRagGrant } from './hosted-rag-grants';
import { readPinnedModel } from '../models/model-history';
import { hostedGrantPayload } from './hosted-rag-grants';
import type { Job } from './device-job.model';

type Db = Pick<PoolClient, 'query'>;

/** Отзывы являются событиями, поэтому remove→readd не оживляет старое разрешение. */
export async function backfillHostedRagGrants(
    pool: Pool,
    validateMigrationJob: (job: Job, db: Db) => Promise<void>,
): Promise<void> {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:hosted-grants-schema',0))");
        const migrated = await db.query(
            "SELECT 1 FROM bridge_hosted_grant_migrations WHERE name='trusted-succeeded-connections-v1'",
        );
        if (!migrated.rows.length) {
            const jobs =
                await db.query<Job>(`SELECT DISTINCT ON(device_id,project_id,payload->>'bindingId',payload->>'instanceId',payload->>'assetKind',payload->>'assetId') * FROM bridge_jobs
                WHERE kind='connect-rag-model' AND state='succeeded' AND result->>'status'='connected' AND result->>'requiresRestart'='true'
                AND result->'revision'=payload->'embedding'->'revision' AND result->'modelPin'=payload->'embedding'->'modelPin' AND result->'profile'=payload->'embedding'->'profile'
                ORDER BY device_id,project_id,payload->>'bindingId',payload->>'instanceId',payload->>'assetKind',payload->>'assetId',COALESCE(started_at,created_at) DESC,id DESC`);
            for (const job of jobs.rows) {
                let valid = false;
                try {
                    const { selection } = hostedGrantPayload(job.payload, job.project_id!);
                    await validateMigrationJob(job, db);
                    const replaced = await db.query(
                        `SELECT 1 FROM project_models pm JOIN bridge_jobs origin ON origin.id=$1 WHERE pm.project_id=$2 AND pm.model_id=$3 AND pm.added_at>COALESCE(origin.started_at,origin.created_at)
                        UNION ALL SELECT 1 FROM bridge_jobs later JOIN bridge_jobs origin ON origin.id=$1 WHERE later.device_id=origin.device_id AND later.project_id=origin.project_id AND later.state='succeeded'
                        AND later.kind IN ('install','uninstall','apply-local-change','apply-adopt-installation') AND COALESCE(later.started_at,later.created_at)>COALESCE(origin.started_at,origin.created_at)
                        AND later.payload->>'bindingId'=origin.payload->>'bindingId' AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(later.payload->'installSet'->'packages')='array' THEN later.payload->'installSet'->'packages' ELSE jsonb_build_array(later.payload->'package') END) member
                        WHERE member->'plugin'->>'kind'=origin.payload->>'assetKind' AND member->'plugin'->>'id'=origin.payload->>'assetId')
                        UNION ALL SELECT 1 FROM security_events se JOIN bridge_jobs origin ON origin.id=$1 WHERE se.created_at>COALESCE(origin.started_at,origin.created_at) AND (
                            se.action IN ('project.member.update','project.member.remove') AND lower(se.resource_id)=lower(origin.project_id||' · '||origin.email)
                            OR se.action='project.model.remove' AND se.resource_id=origin.project_id||' · '||(origin.payload->'embedding'->'model'->>'id')
                            OR se.action IN ('project.asset.remove','project.asset.pin') AND se.resource_id=origin.project_id||' · '||(origin.payload->'approvalRoot'->>'kind')||' · '||(origin.payload->'approvalRoot'->>'id')
                            OR se.action='model.connection.revoke' AND se.resource_id=origin.payload->'embedding'->'model'->>'id'
                            OR se.action='project.embedding.update' AND se.resource_id=origin.project_id AND se.after_state->'modelId'='null'::jsonb
                            OR se.action='user.update' AND lower(se.resource_id)=lower(origin.email) AND (se.after_state->>'enabled'='false' OR se.before_state->>'isMainAdmin'='true' AND se.after_state->>'isMainAdmin'='false'))`,
                        [job.id, job.project_id, selection.model.id],
                    );
                    valid =
                        !replaced.rows.length && !!(await readPinnedModel(db, selection.model.id, selection.modelPin));
                } catch {
                    /* Неподтверждённая история требует нового явного подключения. */
                }
                if (
                    valid &&
                    (
                        await db.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2', [
                            job.project_id,
                            (job.payload.embedding as { model: { id: string } }).model.id,
                        ])
                    ).rows.length
                )
                    await insertHostedRagGrant(db, job);
            }
            await db.query(
                "INSERT INTO bridge_hosted_grant_migrations(name) VALUES('trusted-succeeded-connections-v1')",
            );
        }
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        db.release();
    }
}
