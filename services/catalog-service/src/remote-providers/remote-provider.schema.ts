/** Legacy shared ciphertext stays in place; personal deletion retains only a tombstone and masked receipts. */
export const REMOTE_PROVIDER_SCHEMA_SQL = `
ALTER TABLE model_remote_connections ADD COLUMN auth_mode text CHECK(auth_mode IN('none','optional','required'));
CREATE TABLE remote_provider_user_credentials(
 model_id text NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
 provider_id text NOT NULL CHECK(provider_id ~ '^[a-f0-9]{64}$'),
 owner_email text NOT NULL CHECK(owner_email=lower(owner_email)),
 revision integer NOT NULL CHECK(revision>0),
 credential jsonb CHECK(credential IS NULL OR jsonb_typeof(credential)='object' AND octet_length(credential::text)<=16384),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(model_id,provider_id,owner_email)
);
CREATE TABLE remote_provider_user_requests(
 owner_email text NOT NULL CHECK(owner_email=lower(owner_email)),
 request_key uuid NOT NULL,
 model_id text NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=8192),
 PRIMARY KEY(owner_email,request_key)
);
`;
