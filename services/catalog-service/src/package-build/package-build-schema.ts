/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const PACKAGE_BUILD_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS tool_build_jobs (
            id uuid PRIMARY KEY,actor text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,config jsonb NOT NULL,
            state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),percent integer NOT NULL DEFAULT 0,
            message text NOT NULL,result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(actor,request_key));
            DROP INDEX IF EXISTS tool_build_one_active;
            CREATE UNIQUE INDEX IF NOT EXISTS tool_build_one_running ON tool_build_jobs ((true)) WHERE state='RUNNING';
`;
