/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const MODEL_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS model_catalog (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, descriptor JSONB NOT NULL CHECK(jsonb_typeof(descriptor)='object'),
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        ); CREATE UNIQUE INDEX IF NOT EXISTS model_catalog_name ON model_catalog(lower(name));
        CREATE TABLE IF NOT EXISTS project_models (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
            added_by TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(project_id,model_id)
        ); CREATE INDEX IF NOT EXISTS project_models_model ON project_models(model_id);
ALTER TABLE project_models ADD COLUMN IF NOT EXISTS assignment_epoch UUID NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS model_creation_requests (
            actor TEXT NOT NULL,request_key UUID NOT NULL,request_hash TEXT NOT NULL,
            model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,PRIMARY KEY(actor,request_key));
ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS model_catalog_versions (
            model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT, revision INTEGER NOT NULL CHECK(revision>0),
            name TEXT NOT NULL,descriptor JSONB NOT NULL CHECK(jsonb_typeof(descriptor)='object'),model_pin TEXT NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'),
            created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(model_id,revision));
        CREATE INDEX IF NOT EXISTS model_catalog_version_pin ON model_catalog_versions(model_id,model_pin);
CREATE TABLE IF NOT EXISTS model_remote_connections (
        model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
        revision BIGINT NOT NULL CHECK(revision>0), base_url TEXT NOT NULL, request_dimensions BOOLEAN NOT NULL,
        credential_kind TEXT NOT NULL CHECK(credential_kind IN ('none','stored','environment')),
        credential JSONB, credential_env TEXT, semantic_sha TEXT, verified_at TIMESTAMPTZ,
        failure_message TEXT, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(model_id,revision), CHECK(semantic_sha IS NULL OR semantic_sha ~ '^[a-f0-9]{64}$'),
        CHECK((credential_kind='stored' AND credential IS NOT NULL AND credential_env IS NULL)
            OR (credential_kind='environment' AND credential IS NULL AND credential_env IS NOT NULL)
            OR (credential_kind='none' AND credential IS NULL AND credential_env IS NULL))
    ); CREATE INDEX IF NOT EXISTS model_remote_semantic ON model_remote_connections(model_id,semantic_sha,revision DESC)
`;
