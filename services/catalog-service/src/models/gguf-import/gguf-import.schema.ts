/** Additive migration 48; accepted files are retained independently of expiring drafts. */
export const GGUF_IMPORT_SCHEMA_SQL = `
CREATE TABLE model_gguf_uploads(
 id uuid PRIMARY KEY,actor text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,file_name text NOT NULL,
 bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=9007199254740991),expected_sha256 text CHECK(expected_sha256~'^[a-f0-9]{64}$'),sha256 text CHECK(sha256~'^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('WAITING','UPLOADING','READY','CANCELLED','ACCEPTED')),auth_epoch text NOT NULL,lease_token uuid,
 metadata jsonb,limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object'),model_id text REFERENCES model_catalog(id),accept_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,cleaned_at timestamptz,
 UNIQUE(actor,request_key),UNIQUE(model_id),
 CHECK(state NOT IN ('READY','ACCEPTED') OR sha256 IS NOT NULL AND metadata IS NOT NULL),
 CHECK(state<>'ACCEPTED' OR model_id IS NOT NULL AND accept_hash IS NOT NULL));
CREATE INDEX model_gguf_uploads_expiry ON model_gguf_uploads(expires_at) WHERE state<>'ACCEPTED';
`;
