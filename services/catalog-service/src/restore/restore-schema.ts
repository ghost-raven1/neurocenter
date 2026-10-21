/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const RESTORE_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS web_restore_runner (
   singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),runner_id uuid NOT NULL,config_digest text NOT NULL,target_prefix text NOT NULL,
   checkpoints jsonb NOT NULL,seen_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS web_restore_jobs (
   id uuid PRIMARY KEY,actor text NOT NULL,request_key uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('preview','restore')),
   input jsonb NOT NULL,input_hash text NOT NULL,preview_id uuid REFERENCES web_restore_jobs(id),
   state text NOT NULL CHECK(state IN ('queued','running','ready','succeeded','failed','interrupted','cancelled')),
   preview jsonb,receipt jsonb,error_code text,message text NOT NULL,runner_id uuid,lease_id uuid,lease_until timestamptz,
   created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor,request_key));
   CREATE UNIQUE INDEX IF NOT EXISTS web_restore_preview_once ON web_restore_jobs(preview_id) WHERE kind='restore';
   CREATE UNIQUE INDEX IF NOT EXISTS web_restore_running ON web_restore_jobs((true)) WHERE state='running';
   CREATE INDEX IF NOT EXISTS web_restore_actor_created ON web_restore_jobs(actor,created_at DESC);
   CREATE TABLE IF NOT EXISTS web_restore_cancelled_requests(actor text NOT NULL,request_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor,request_key))
`;
