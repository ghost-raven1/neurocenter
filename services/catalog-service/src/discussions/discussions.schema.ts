/** Migration 22: target-bound discussions, desired-state likes and private upload intents. */
export const DISCUSSIONS_SCHEMA_SQL = `
CREATE TABLE discussion_comments (
 id uuid PRIMARY KEY,target_type text NOT NULL CHECK(target_type IN ('catalog','help')),target_id text NOT NULL CHECK(length(target_id) BETWEEN 1 AND 600),
 parent_id uuid,body text NOT NULL CHECK(octet_length(body)<=16000),
 author_email text NOT NULL,author_name text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 request_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
 UNIQUE(author_email,request_key),UNIQUE(id,target_type,target_id),
 FOREIGN KEY(parent_id,target_type,target_id) REFERENCES discussion_comments(id,target_type,target_id) ON DELETE RESTRICT,
 CHECK(deleted_at IS NULL AND length(body)>0 OR deleted_at IS NOT NULL AND body='')
);
CREATE INDEX discussion_comment_target ON discussion_comments(target_type,target_id,created_at,id);
CREATE TABLE catalog_reactions (
 target_id text NOT NULL CHECK(length(target_id) BETWEEN 1 AND 600),actor_email text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(target_id,actor_email)
);
CREATE TABLE discussion_attachments (
 id uuid PRIMARY KEY,target_type text NOT NULL CHECK(target_type IN ('catalog','help')),target_id text NOT NULL CHECK(length(target_id) BETWEEN 1 AND 600),
 owner_email text NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240),media_type text NOT NULL,
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 storage_id text NOT NULL CHECK(storage_id~'^[a-f0-9]{64}$'),bucket text NOT NULL,object_key text NOT NULL UNIQUE,version_id text,
 state text NOT NULL CHECK(state IN ('UPLOADING','READY','DELETED','PURGED')),comment_id uuid,
 request_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_email,request_key),
 FOREIGN KEY(comment_id,target_type,target_id) REFERENCES discussion_comments(id,target_type,target_id) ON DELETE RESTRICT,
 CHECK(comment_id IS NULL OR state='READY')
);
CREATE INDEX discussion_attachment_comment ON discussion_attachments(comment_id);
CREATE INDEX discussion_attachment_cleanup ON discussion_attachments(state,created_at) WHERE comment_id IS NULL;
`;
