/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const DEVICE_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS bridge_devices (
            id text PRIMARY KEY,email text NOT NULL,role text NOT NULL,name text NOT NULL,fingerprint text NOT NULL,
            token_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
            revoked boolean NOT NULL DEFAULT false,last_seen timestamptz,report jsonb NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS bridge_pairs (
            code_hash text PRIMARY KEY,user_code text UNIQUE NOT NULL,name text NOT NULL,fingerprint text NOT NULL,
            expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',email text,role text,issued boolean NOT NULL DEFAULT false);
            CREATE TABLE IF NOT EXISTS bridge_jobs (
            id text PRIMARY KEY,device_id text NOT NULL REFERENCES bridge_devices(id),email text NOT NULL,
            role text NOT NULL,project_id text,kind text NOT NULL,payload jsonb NOT NULL,request_key text NOT NULL,
            request_hash text NOT NULL,state text NOT NULL DEFAULT 'queued',percent integer,message text NOT NULL DEFAULT 'Ожидает моста',
            lease text,lease_until timestamptz,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(email,request_key));
            CREATE INDEX IF NOT EXISTS bridge_jobs_device_queue ON bridge_jobs(device_id,state,created_at);
            ALTER TABLE bridge_jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS proposed_token_hash text;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS resume_device_id text;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS resume_token_hash text;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS issued_device_id text;
            ALTER TABLE bridge_devices ADD COLUMN IF NOT EXISTS paused_until timestamptz;;
CREATE TABLE IF NOT EXISTS device_install_plans (
        id uuid PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        asset_kind text NOT NULL, asset_id text NOT NULL, version integer NOT NULL CHECK(version>0),
        manifest text NOT NULL CHECK(manifest ~ '^[a-f0-9]{64}$'), package jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','revoked')),
        revision integer NOT NULL DEFAULT 0, created_by text NOT NULL,
        approved_by text, approved_at timestamptz, revoked_by text, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(project_id,asset_kind,asset_id,version,manifest));
        ALTER TABLE device_install_plans ADD COLUMN IF NOT EXISTS installation_set jsonb;
        CREATE INDEX IF NOT EXISTS device_install_plans_project ON device_install_plans(project_id,created_at);
`;
