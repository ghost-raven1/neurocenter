/** Full images have a separate lifecycle from mutable row synchronization. */
export const SNAPSHOT_SCHEMA_SQL=`
CREATE TABLE project_snapshot_verifiers (
 id uuid PRIMARY KEY,last_seen timestamptz NOT NULL,sdk_version text NOT NULL,image_digest text NOT NULL);
CREATE TABLE project_snapshots (
 id uuid PRIMARY KEY,project_id text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,
 email text NOT NULL,role text NOT NULL,device_id text NOT NULL,binding_id text NOT NULL,
 parent_id uuid,expected_head_id text,expected_head_revision bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('UPLOADING','VERIFYING','VERIFIED','REJECTED','DELETING','DELETED')),
 manifest jsonb,manifest_sha256 text,signature jsonb,total_bytes bigint NOT NULL DEFAULT 0,
 job_id text,upload_completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),verified_at timestamptz,error text,
 verifier_owner uuid,verifier_lease_until timestamptz,
 deleted_at timestamptz,delete_after timestamptz,UNIQUE(email,request_key),
 CHECK(total_bytes>=0),CHECK(manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'));
CREATE INDEX project_snapshots_project ON project_snapshots(project_id,created_at);
CREATE TABLE project_snapshot_blob_refs (
 snapshot_id uuid NOT NULL REFERENCES project_snapshots(id),project_id text NOT NULL,sha256 text NOT NULL,
 bytes bigint NOT NULL,PRIMARY KEY(snapshot_id,sha256));
CREATE INDEX project_snapshot_blob_refs_live ON project_snapshot_blob_refs(project_id,sha256);
CREATE TABLE project_snapshot_blobs (
 project_id text NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 bytes bigint NOT NULL CHECK(bytes>=0 AND bytes<=67108864),storage_id text NOT NULL,version_id text,
 state text NOT NULL DEFAULT 'LIVE' CHECK(state IN ('LIVE','DELETING')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,sha256));
CREATE TABLE project_snapshot_blob_writes (
 project_id text NOT NULL,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),write_id uuid NOT NULL,
 bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=67108864),storage_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,sha256));
CREATE TABLE project_snapshot_profiles (
 id uuid PRIMARY KEY,project_id text NOT NULL,snapshot_id uuid NOT NULL REFERENCES project_snapshots(id),
 revision bigint NOT NULL CHECK(revision>0),skill_pins jsonb NOT NULL,capsule jsonb NOT NULL,
 capsule_sha256 text NOT NULL,signature jsonb NOT NULL,email text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,revision));
CREATE TABLE project_snapshot_commands (
 project_id text NOT NULL,email text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(email,request_key));
CREATE TABLE project_snapshot_cancelled_requests (
 email text NOT NULL,request_key uuid NOT NULL,project_id text NOT NULL,request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(email,request_key));
CREATE TABLE project_snapshot_cancelled_commands (
 email text NOT NULL,request_key uuid NOT NULL,project_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(email,request_key));
CREATE FUNCTION snapshot_job_failed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 IF NEW.kind='publish-project-snapshot' AND NEW.state IN ('failed','cancelled') THEN
  WITH closed AS (UPDATE project_snapshots SET status='REJECTED',error='Передача снимка прервалась или отменена.',verifier_owner=NULL,verifier_lease_until=NULL
   WHERE id::text=NEW.payload->>'snapshotId' AND project_id=NEW.project_id AND device_id=NEW.device_id AND email=NEW.email
   AND binding_id=NEW.payload->>'bindingId' AND status='UPLOADING' RETURNING id)
  INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state)
  SELECT gen_random_uuid(),NEW.email,'snapshot.upload.failed',id::text,'{"status":"UPLOADING"}'::jsonb,jsonb_build_object('status','REJECTED','jobId',NEW.id) FROM closed;
 END IF;
 RETURN NEW;
END $fn$;
DO $trigger$ BEGIN
 IF to_regclass('bridge_jobs') IS NOT NULL THEN
  CREATE TRIGGER snapshot_job_terminal AFTER UPDATE OF state ON bridge_jobs FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION snapshot_job_failed();
 END IF;
END $trigger$;
`;
