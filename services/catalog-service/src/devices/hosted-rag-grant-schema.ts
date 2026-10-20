import type {Pool,PoolClient} from 'pg';
import {insertHostedRagGrant} from './hosted-rag-grants';
import {readPinnedModel} from '../models/model-history';
import {hostedGrantPayload} from './hosted-rag-grants';
import type {Job} from './device-job.model';

type Db=Pick<PoolClient,'query'>;
/** Сначала существуют device/jobs; модельные FK не связывают порядок инициализации Nest-модулей. */
export async function setupHostedRagGrantTable(db:Db):Promise<void>{
    await db.query(`CREATE TABLE IF NOT EXISTS bridge_hosted_rag_grants(
        id UUID PRIMARY KEY,authorization_order BIGSERIAL NOT NULL,device_id TEXT NOT NULL REFERENCES bridge_devices(id),project_id TEXT NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL,
        binding_id TEXT NOT NULL,instance_id TEXT NOT NULL,asset_kind TEXT NOT NULL CHECK(asset_kind IN ('mcp','plugin')),asset_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),manifest TEXT NOT NULL CHECK(manifest ~ '^[a-f0-9]{64}$'),selection_revision BIGINT NOT NULL CHECK(selection_revision>0),
        model_id TEXT NOT NULL,model_pin TEXT NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'),model_assignment_epoch UUID NOT NULL,
        payload JSONB NOT NULL,job_id TEXT NOT NULL UNIQUE REFERENCES bridge_jobs(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),revoked_at TIMESTAMPTZ);
        ALTER TABLE bridge_hosted_rag_grants ADD COLUMN IF NOT EXISTS authorization_order BIGSERIAL NOT NULL;
        CREATE INDEX IF NOT EXISTS bridge_hosted_grant_scope ON bridge_hosted_rag_grants(device_id,project_id,binding_id,instance_id) WHERE revoked_at IS NULL;
        CREATE TABLE IF NOT EXISTS bridge_hosted_grant_migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}

/** Отзывы являются событиями, поэтому remove→readd не оживляет старое разрешение. */
export async function setupHostedRagGrantRevocations(pool:Pool,validateMigrationJob:(job:Job,db:Db)=>Promise<void>):Promise<void>{
    const db=await pool.connect();
    try{
        await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:hosted-grants-schema',0))");
        await db.query(`CREATE OR REPLACE FUNCTION revoke_hosted_rag_grants() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_TABLE_NAME='project_models' THEN
                UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id AND model_id=OLD.model_id AND revoked_at IS NULL;
            ELSIF TG_TABLE_NAME='project_embedding_settings' THEN
                IF TG_OP='DELETE' OR (OLD.model_id IS NOT NULL AND NEW.model_id IS NULL) THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='project_assets' THEN
                IF TG_OP='DELETE' OR OLD.asset_version IS DISTINCT FROM NEW.asset_version OR OLD.asset_manifest IS DISTINCT FROM NEW.asset_manifest THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id
                        AND payload->'approvalRoot'->>'id'=OLD.asset_id AND payload->'approvalRoot'->>'kind'=OLD.asset_kind AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='device_install_plans' THEN
                IF NEW.status IS DISTINCT FROM OLD.status OR NEW.revision IS DISTINCT FROM OLD.revision THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE payload->>'planId'=OLD.id::text AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='bridge_devices' THEN
                UPDATE bridge_hosted_rag_grants g SET revoked_at=now() WHERE g.device_id=NEW.id AND g.revoked_at IS NULL
                    AND (NEW.revoked OR NEW.email<>OLD.email OR NEW.role<>OLD.role OR EXISTS(
                        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.report->'bindings')='array' THEN NEW.report->'bindings' ELSE '[]'::jsonb END) b
                        WHERE b->>'projectId'=g.project_id AND b->>'valid'='true'
                        AND (b->>'bindingId' IS DISTINCT FROM g.binding_id OR b->>'instanceId' IS DISTINCT FROM g.instance_id)));
            ELSIF TG_TABLE_NAME='project_members' THEN
                IF TG_OP='DELETE' OR OLD.role IS DISTINCT FROM NEW.role OR OLD.principal_name IS DISTINCT FROM NEW.principal_name THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE project_id=OLD.project_id AND lower(email)=lower(OLD.principal_name) AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='platform_users' THEN
                IF NOT NEW.enabled OR (OLD.is_main_admin AND NOT NEW.is_main_admin) THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE lower(email)=lower(OLD.email) AND revoked_at IS NULL
                        AND (NOT NEW.enabled OR role='Главный админ');
                END IF;
            ELSIF TG_TABLE_NAME='model_remote_connections' THEN
                IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
                    UPDATE bridge_hosted_rag_grants SET revoked_at=now() WHERE model_id=NEW.model_id AND revoked_at IS NULL;
                END IF;
            ELSIF TG_TABLE_NAME='bridge_jobs' THEN
                IF NEW.state='succeeded' AND OLD.state<>'succeeded' AND NEW.kind IN ('install','uninstall','apply-local-change','apply-adopt-installation') THEN
                    UPDATE bridge_hosted_rag_grants g SET revoked_at=now() WHERE g.device_id=NEW.device_id AND g.project_id=NEW.project_id
                        AND g.binding_id=NEW.payload->>'bindingId' AND g.revoked_at IS NULL AND EXISTS(
                            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.payload->'installSet'->'packages')='array' THEN NEW.payload->'installSet'->'packages' ELSE jsonb_build_array(NEW.payload->'package') END) p
                            WHERE p->'plugin'->>'kind'=g.asset_kind AND p->'plugin'->>'id'=g.asset_id
                            AND (NEW.kind='uninstall' OR p->'manifest'->>'sha256'<>g.manifest OR p->'plugin'->>'version'<>g.version::text));
                END IF;
            END IF;
            RETURN NULL;
        END $$;`);
        for(const [table,events] of [['project_models','DELETE'],['project_embedding_settings','UPDATE OR DELETE'],['project_assets','UPDATE OR DELETE'],['device_install_plans','UPDATE'],['bridge_devices','UPDATE'],['project_members','UPDATE OR DELETE'],['platform_users','UPDATE'],['bridge_jobs','UPDATE'],['model_remote_connections','UPDATE']]){
            await db.query(`DROP TRIGGER IF EXISTS hosted_rag_grant_revoke ON ${table}; CREATE TRIGGER hosted_rag_grant_revoke AFTER ${events} ON ${table} FOR EACH ROW EXECUTE FUNCTION revoke_hosted_rag_grants()`);
        }
        const migrated=await db.query("SELECT 1 FROM bridge_hosted_grant_migrations WHERE name='trusted-succeeded-connections-v1'");
        if(!migrated.rows.length){
            const jobs=await db.query<Job>(`SELECT DISTINCT ON(device_id,project_id,payload->>'bindingId',payload->>'instanceId',payload->>'assetKind',payload->>'assetId') * FROM bridge_jobs
                WHERE kind='connect-rag-model' AND state='succeeded' AND result->>'status'='connected' AND result->>'requiresRestart'='true'
                AND result->'revision'=payload->'embedding'->'revision' AND result->'modelPin'=payload->'embedding'->'modelPin' AND result->'profile'=payload->'embedding'->'profile'
                ORDER BY device_id,project_id,payload->>'bindingId',payload->>'instanceId',payload->>'assetKind',payload->>'assetId',COALESCE(started_at,created_at) DESC,id DESC`);
            for(const job of jobs.rows){
                let valid=false;
                try{const {selection}=hostedGrantPayload(job.payload,job.project_id!);
                    await validateMigrationJob(job,db);
                    const replaced=await db.query(`SELECT 1 FROM project_models pm JOIN bridge_jobs origin ON origin.id=$1 WHERE pm.project_id=$2 AND pm.model_id=$3 AND pm.added_at>COALESCE(origin.started_at,origin.created_at)
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
                            OR se.action='user.update' AND lower(se.resource_id)=lower(origin.email) AND (se.after_state->>'enabled'='false' OR se.before_state->>'isMainAdmin'='true' AND se.after_state->>'isMainAdmin'='false'))`,[job.id,job.project_id,selection.model.id]);
                    valid=!replaced.rows.length&&!!await readPinnedModel(db,selection.model.id,selection.modelPin);}catch{/* Неподтверждённая история требует нового явного подключения. */}
                if(valid&&(await db.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2',[job.project_id,(job.payload.embedding as {model:{id:string}}).model.id])).rows.length)await insertHostedRagGrant(db,job);
            }
            await db.query("INSERT INTO bridge_hosted_grant_migrations(name) VALUES('trusted-succeeded-connections-v1')");
        }
        await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
}
