/** Migration 50 keeps the provider mutation intent separate from checked upload and model history. */
export const GGUF_RUNTIME_SCHEMA_SQL=`
CREATE TABLE model_gguf_runtime_intents(
 model_id text PRIMARY KEY REFERENCES model_catalog(id),upload_id uuid NOT NULL UNIQUE REFERENCES model_gguf_uploads(id),
 alias text NOT NULL UNIQUE,file_sha256 text NOT NULL CHECK(file_sha256~'^[a-f0-9]{64}$'),bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=9007199254740991),
 state text NOT NULL CHECK(state IN ('RESERVED','CREATE_SENT','CREATED')),manifest_sha256 text CHECK(manifest_sha256~'^[a-f0-9]{64}$'),
 limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object'),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state<>'CREATED' OR manifest_sha256 IS NOT NULL));
`;
