/** The projection follows all baseline and historical bridge tables. */
export const REINDEX_OPERATION_SCHEMA_SQL=`
CREATE OR REPLACE FUNCTION project_reindex_operation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE job_state text; job_message text; job_percent integer; projected text;
    BEGIN
        IF NEW.connection_job_id IS NOT NULL THEN
            SELECT state,message,percent INTO job_state,job_message,job_percent FROM bridge_jobs
                WHERE id=NEW.connection_job_id::text AND email=NEW.actor AND project_id=NEW.project_id;
        END IF;
        projected=CASE
            WHEN NEW.state='cancelled' THEN 'CANCELLED'
            WHEN NEW.state='stale' THEN 'CONFLICT'
            WHEN NEW.state='failed' THEN 'FAILED'
            WHEN NEW.state='applied' THEN CASE
                WHEN NEW.data->'connection' IS NULL THEN 'SUCCEEDED'
                WHEN NEW.connection_error IS NOT NULL OR job_state='failed' THEN 'FAILED'
                WHEN job_state='cancelled' THEN 'CANCELLED'
                WHEN job_state='succeeded' THEN 'SUCCEEDED'
                WHEN job_state='running' OR job_state='reconciling' THEN 'RUNNING'
                ELSE 'QUEUED' END
            WHEN NEW.state IN ('preparing','needs_input') THEN 'QUEUED'
            ELSE 'RUNNING' END;
        INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,
            bytes_done,bytes_total,started_at,finished_at,error,log,retries)
        VALUES('rag-reindex-'||NEW.id,'SYNC',NEW.project_id,'rag-reindex',NEW.id,NEW.actor,projected,
            CASE WHEN NEW.state='applied' AND NEW.data->'connection' IS NOT NULL THEN COALESCE(job_percent,0) ELSE NEW.progress END,
            0,0,NEW.created_at,CASE WHEN projected IN ('SUCCEEDED','FAILED','CANCELLED','CONFLICT') THEN NEW.updated_at ELSE NULL END,
            CASE WHEN projected IN ('FAILED','CONFLICT') THEN COALESCE(NEW.connection_error,job_message,NEW.message) ELSE NULL END,
            jsonb_build_array(jsonb_build_object('at',NEW.updated_at,'level',CASE WHEN projected='FAILED' THEN 'ERROR' ELSE 'INFO' END,
                'message',CASE WHEN NEW.state='applied' THEN COALESCE(NEW.connection_error,job_message,NEW.message) ELSE NEW.message END)),0)
        ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,percent=EXCLUDED.percent,
            finished_at=EXCLUDED.finished_at,error=EXCLUDED.error,log=EXCLUDED.log
        WHERE operations.resource_type='rag-reindex' AND operations.resource_id=NEW.id::text
            AND operations.project_id=NEW.project_id AND operations.actor=NEW.actor;
        RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS project_reindex_operation ON project_reindex_plans;
    CREATE TRIGGER project_reindex_operation AFTER INSERT OR UPDATE ON project_reindex_plans
        FOR EACH ROW EXECUTE FUNCTION project_reindex_operation();
    CREATE OR REPLACE FUNCTION project_reindex_local_operation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        UPDATE project_reindex_plans SET updated_at=now() WHERE connection_job_id::text=NEW.id
            AND actor=NEW.email AND project_id=NEW.project_id AND state='applied';
        RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS project_reindex_local_operation ON bridge_jobs;
    CREATE TRIGGER project_reindex_local_operation AFTER UPDATE OF state,percent,message ON bridge_jobs
        FOR EACH ROW EXECUTE FUNCTION project_reindex_local_operation();
    UPDATE project_reindex_plans SET updated_at=updated_at;
`;
