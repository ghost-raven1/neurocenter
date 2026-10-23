/** OAuth stays on the device. Prompt/result rows are never selected by the public device queue. */
export const DEVICE_CODEX_SCHEMA_SQL = `
CREATE TABLE model_device_connections (
 model_id TEXT PRIMARY KEY REFERENCES model_catalog(id),device_id TEXT NOT NULL REFERENCES bridge_devices(id),owner_email TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),source JSONB NOT NULL,expected_candidate JSONB NOT NULL,connector_package JSONB NOT NULL,
 semantic_sha TEXT NOT NULL CHECK(semantic_sha ~ '^[a-f0-9]{64}$'),options JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),revoked_at TIMESTAMPTZ);
CREATE TABLE device_model_calls (
 id UUID PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES bridge_jobs(id),model_id TEXT NOT NULL REFERENCES model_catalog(id),
 device_id TEXT NOT NULL REFERENCES bridge_devices(id),owner_email TEXT NOT NULL,actor_role TEXT NOT NULL,project_id TEXT,
 model_pin TEXT NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'),runtime_model TEXT NOT NULL,connection_revision INTEGER NOT NULL CHECK(connection_revision>0),
 request JSONB NOT NULL,required_features JSONB NOT NULL,deadline_at TIMESTAMPTZ NOT NULL,
 dispatched_at TIMESTAMPTZ,cancelled_at TIMESTAMPTZ,result JSONB,response_digest TEXT CHECK(response_digest ~ '^[a-f0-9]{64}$'),
 completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX device_model_calls_device ON device_model_calls(device_id,created_at);
`;
