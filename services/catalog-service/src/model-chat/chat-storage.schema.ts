/** Existing bytes enter a resumable transfer queue; live reads never fall back to PostgreSQL blobs. */
export const CHAT_STORAGE_SCHEMA_SQL = `
CREATE TABLE model_chat_objects (
 id uuid PRIMARY KEY, storage_id text NOT NULL CHECK(storage_id ~ '^[a-f0-9]{64}$'),
 bucket text NOT NULL, object_key text NOT NULL, version_id text,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),
 state text NOT NULL CHECK(state IN ('STAGING','LIVE','DELETE','DELETED')),
 lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(storage_id,bucket,object_key), CHECK((state='STAGING' AND lease_until IS NOT NULL) OR (state<>'STAGING' AND lease_until IS NULL))
);
CREATE INDEX model_chat_object_cleanup ON model_chat_objects(state,next_attempt_at);
CREATE TABLE model_chat_attachment_transfers (
 attachment_id uuid PRIMARY KEY REFERENCES model_chat_attachments(id) ON DELETE CASCADE,
 content bytea NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),
 CHECK(octet_length(content)=bytes)
);
INSERT INTO model_chat_attachment_transfers(attachment_id,content,sha256,bytes)
 SELECT id,content,encode(sha256(content),'hex'),bytes FROM model_chat_attachments WHERE deleted_at IS NULL;
ALTER TABLE model_chat_attachments DROP CONSTRAINT model_chat_attachments_check1;
ALTER TABLE model_chat_attachments DROP COLUMN content;
ALTER TABLE model_chat_attachments ADD COLUMN object_id uuid REFERENCES model_chat_objects(id) ON DELETE RESTRICT;
ALTER TABLE model_chat_attachments ADD COLUMN storage_state text NOT NULL DEFAULT 'S3';
UPDATE model_chat_attachments SET storage_state=CASE WHEN deleted_at IS NULL THEN 'TRANSFER' ELSE 'DELETED' END;
ALTER TABLE model_chat_attachments ADD CONSTRAINT model_chat_attachment_storage_state CHECK(
 (deleted_at IS NULL AND storage_state='S3' AND object_id IS NOT NULL)
 OR (deleted_at IS NULL AND storage_state='TRANSFER' AND object_id IS NULL)
 OR (deleted_at IS NOT NULL AND storage_state='DELETED' AND object_id IS NULL));
CREATE UNIQUE INDEX model_chat_attachment_object ON model_chat_attachments(object_id) WHERE object_id IS NOT NULL;
CREATE FUNCTION model_chat_queue_object_delete() RETURNS trigger LANGUAGE plpgsql AS $chat_storage_delete$
BEGIN
 IF OLD.object_id IS NOT NULL THEN
  IF TG_OP='DELETE' THEN
   UPDATE model_chat_objects SET state='DELETE',lease_until=NULL,next_attempt_at=now() WHERE id=OLD.object_id;
  ELSIF NEW.object_id IS DISTINCT FROM OLD.object_id THEN
   UPDATE model_chat_objects SET state='DELETE',lease_until=NULL,next_attempt_at=now() WHERE id=OLD.object_id;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $chat_storage_delete$;
CREATE TRIGGER model_chat_attachment_delete_object BEFORE DELETE OR UPDATE OF object_id ON model_chat_attachments
 FOR EACH ROW EXECUTE FUNCTION model_chat_queue_object_delete();
`;
