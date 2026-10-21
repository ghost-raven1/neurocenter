/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const MAINTENANCE_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS maintenance_settings (
            singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
            policy jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS maintenance_runs (
            id uuid PRIMARY KEY, slot text NOT NULL, policy_revision integer NOT NULL,
            started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
            state text NOT NULL CHECK(state IN ('running','failed','succeeded')), error_code text,
            receipt jsonb);
            CREATE UNIQUE INDEX IF NOT EXISTS maintenance_running ON maintenance_runs ((true)) WHERE state='running';
            CREATE UNIQUE INDEX IF NOT EXISTS maintenance_success_slot ON maintenance_runs (slot) WHERE state='succeeded';
            CREATE INDEX IF NOT EXISTS maintenance_runs_started ON maintenance_runs(started_at DESC);
CREATE TABLE IF NOT EXISTS project_backups (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, file_name TEXT NOT NULL, database_name TEXT NOT NULL,
            size_bytes BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
`;
