/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const SOURCE_UPLOAD_SCHEMA_SQL=`
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS source_upload_auth_epoch uuid NOT NULL DEFAULT gen_random_uuid();
  CREATE OR REPLACE FUNCTION rotate_source_upload_auth_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
   IF OLD.is_main_admin IS DISTINCT FROM NEW.is_main_admin OR OLD.enabled IS DISTINCT FROM NEW.enabled THEN NEW.source_upload_auth_epoch=gen_random_uuid(); END IF;
   RETURN NEW; END$$;
  DROP TRIGGER IF EXISTS source_upload_access_epoch ON platform_users;
  CREATE TRIGGER source_upload_access_epoch BEFORE UPDATE OF is_main_admin,enabled ON platform_users FOR EACH ROW EXECUTE FUNCTION rotate_source_upload_auth_epoch();
  CREATE TABLE IF NOT EXISTS tool_source_uploads(
  id uuid PRIMARY KEY,actor text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,name text NOT NULL,
  sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=268435456),
  format text NOT NULL CHECK(format IN ('zip','tar.gz','file')),state text NOT NULL CHECK(state IN ('WAITING','UPLOADING','READY','CANCELLED')),
  auth_epoch text NOT NULL,lease_token uuid,metadata jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  UNIQUE(actor,request_key));
  ALTER TABLE tool_source_uploads ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;
  ALTER TABLE tool_source_uploads ADD COLUMN IF NOT EXISTS cleanup_checked_at timestamptz;
  CREATE INDEX IF NOT EXISTS tool_source_upload_expiry ON tool_source_uploads(expires_at);
`;
