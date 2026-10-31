/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const ASSET_SOURCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS asset_source_blobs (
            sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),bytes bigint NOT NULL CHECK(bytes>0),created_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS asset_source_blob_refs (
                repository text NOT NULL,asset_id text NOT NULL,asset_version text NOT NULL,descriptor_sha256 text NOT NULL,
                blob_sha256 text NOT NULL REFERENCES asset_source_blobs(sha256),
                PRIMARY KEY(repository,asset_id,asset_version,descriptor_sha256,blob_sha256));
CREATE TABLE IF NOT EXISTS asset_source_jobs (
            id uuid PRIMARY KEY,actor text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,
            replacement_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,source jsonb NOT NULL,selected_ids jsonb NOT NULL,items jsonb NOT NULL DEFAULT '[]'::jsonb,
            state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','NEEDS_INPUT','PARTIAL','FAILED','SUCCEEDED','CANCELLED')),
            message text NOT NULL,cancel_requested boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(actor,request_key));
            ALTER TABLE asset_source_jobs ADD COLUMN IF NOT EXISTS replacement_hashes jsonb NOT NULL DEFAULT '{}'::jsonb;
            ALTER TABLE asset_source_jobs ADD COLUMN IF NOT EXISTS replacement_origins jsonb NOT NULL DEFAULT '{}'::jsonb;
            CREATE TABLE IF NOT EXISTS asset_source_receipts (
                repository text NOT NULL,external_id text NOT NULL,asset_kind text NOT NULL,asset_version text NOT NULL,
                descriptor_sha256 text NOT NULL,source_commit text NOT NULL,native_id text NOT NULL,native_version integer NOT NULL,
                native_hash text NOT NULL,descriptor jsonb NOT NULL,blobs jsonb NOT NULL,imported_by text NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(repository,external_id),UNIQUE(asset_kind,native_id));
            CREATE TABLE IF NOT EXISTS asset_source_versions (
                repository text NOT NULL,external_id text NOT NULL,asset_kind text NOT NULL,asset_version text NOT NULL,
                descriptor_sha256 text NOT NULL,source_commit text NOT NULL,native_id text NOT NULL,native_version integer NOT NULL,
                native_hash text NOT NULL,native_manifest text,descriptor jsonb NOT NULL,blobs jsonb NOT NULL,imported_by text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(repository,external_id,asset_version));
            ALTER TABLE asset_source_versions DROP CONSTRAINT IF EXISTS asset_source_versions_asset_kind_native_id_native_version_key;
ALTER TABLE asset_source_receipts ALTER COLUMN source_commit DROP NOT NULL;
            ALTER TABLE asset_source_versions ALTER COLUMN source_commit DROP NOT NULL;
            ALTER TABLE asset_source_receipts ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'repository';
            ALTER TABLE asset_source_versions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'repository';
            ALTER TABLE asset_source_receipts ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE asset_source_receipts ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
            ALTER TABLE asset_source_receipts DROP CONSTRAINT IF EXISTS asset_source_receipts_asset_kind_native_id_key;
            CREATE UNIQUE INDEX IF NOT EXISTS asset_source_native_owner ON asset_source_receipts(asset_kind,native_id) WHERE active;
CREATE TABLE IF NOT EXISTS asset_source_snapshots (
            commit text PRIMARY KEY,pin jsonb NOT NULL,index jsonb NOT NULL,assets jsonb NOT NULL,checked_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS asset_source_refresh (id boolean PRIMARY KEY DEFAULT true CHECK(id),attempted_at timestamptz,message text);
CREATE TABLE IF NOT EXISTS legacy_retirement_previews(id UUID PRIMARY KEY,actor TEXT NOT NULL,digest TEXT NOT NULL,payload JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
            CREATE TABLE IF NOT EXISTS legacy_retirement_operations(id UUID PRIMARY KEY REFERENCES legacy_retirement_previews(id),actor TEXT NOT NULL,request_key UUID NOT NULL,state TEXT NOT NULL,result JSONB,UNIQUE(actor,request_key));
            CREATE TABLE IF NOT EXISTS legacy_retired_project_assets(migration_id UUID NOT NULL REFERENCES legacy_retirement_operations(id),project_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_kind TEXT NOT NULL,
                original_record JSONB NOT NULL,record_sha256 TEXT NOT NULL,retired_by TEXT NOT NULL,retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(migration_id,project_id,asset_id,asset_kind));
CREATE TABLE IF NOT EXISTS asset_management_impacts (
            id uuid PRIMARY KEY,actor text NOT NULL,digest text NOT NULL,payload jsonb NOT NULL,expires_at timestamptz NOT NULL);
            CREATE TABLE IF NOT EXISTS asset_management_operations (
                id uuid PRIMARY KEY REFERENCES asset_management_impacts(id),actor text NOT NULL,mode text NOT NULL,state text NOT NULL,message text NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now())
`;
