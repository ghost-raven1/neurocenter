/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const MODEL_JOB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_embedding_settings (
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            revision BIGINT NOT NULL CHECK(revision>0),model_id TEXT,model_pin TEXT,dimension INTEGER,
            updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK((model_id IS NULL AND model_pin IS NULL AND dimension IS NULL)
                OR (model_id IS NOT NULL AND model_pin IS NOT NULL AND dimension IS NOT NULL AND model_pin ~ '^[a-f0-9]{64}$' AND dimension>0)));
ALTER TABLE project_embedding_settings ADD COLUMN IF NOT EXISTS active_generation TEXT;
                ALTER TABLE project_embedding_settings ADD COLUMN IF NOT EXISTS active_snapshot TEXT;
                ALTER TABLE project_embedding_settings ADD COLUMN IF NOT EXISTS data_revision BIGINT NOT NULL DEFAULT 0;
                UPDATE project_embedding_settings SET active_generation='initial-'||md5(project_id) WHERE active_generation IS NULL;
                ALTER TABLE project_embedding_settings ALTER COLUMN active_generation SET NOT NULL;
CREATE TABLE IF NOT EXISTS project_rag_sync_intents(
            id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,request_key TEXT NOT NULL,
            payload_hash TEXT NOT NULL,payload JSONB NOT NULL,context JSONB NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','uncertain','succeeded','failed')),result JSONB,error JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(project_id,request_key));
            CREATE UNIQUE INDEX IF NOT EXISTS project_rag_pending_write ON project_rag_sync_intents(project_id) WHERE state IN ('pending','uncertain');
CREATE TABLE IF NOT EXISTS project_reindex_plans(
            id UUID PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,request_key TEXT NOT NULL,
            actor TEXT NOT NULL,active_role TEXT NOT NULL,state TEXT NOT NULL,digest TEXT NOT NULL,approved BOOLEAN NOT NULL DEFAULT false,
            data JSONB NOT NULL,progress INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(project_id,request_key));
            ALTER TABLE project_reindex_plans ADD COLUMN IF NOT EXISTS connection_job_id UUID;
            ALTER TABLE project_reindex_plans ADD COLUMN IF NOT EXISTS connection_error TEXT;
            ALTER TABLE project_reindex_plans ADD COLUMN IF NOT EXISTS connection_request_key UUID;
            UPDATE project_reindex_plans SET connection_request_key=id WHERE connection_request_key IS NULL;
CREATE TABLE IF NOT EXISTS model_hosting_jobs (
            id text PRIMARY KEY, model_id text NOT NULL, action text NOT NULL, actor text NOT NULL,
            state text NOT NULL, stage text NOT NULL, message text NOT NULL, progress integer,
            started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
            operation_id text NOT NULL UNIQUE);
            CREATE INDEX IF NOT EXISTS model_hosting_jobs_model ON model_hosting_jobs(model_id,started_at DESC);
CREATE TABLE IF NOT EXISTS operation_action_requests(
            actor TEXT NOT NULL,request_key UUID NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,
            target JSONB NOT NULL,result JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(actor,request_key))
`;
