/** Migration 8 preserves request scope and history even when a project or target is removed. */
export const CATALOG_REQUEST_SCHEMA_SQL=`
CREATE TABLE catalog_requests (
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('add','update','issue')),
 asset_type text NOT NULL CHECK(asset_type IN ('plugin','mcp','skill','model')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),description text NOT NULL CHECK(length(description) BETWEEN 1 AND 10000),
 source_url text,project_id text,project_name text,created_by text NOT NULL,
 status text NOT NULL CHECK(status IN ('submitted','in_progress','needs_info','rejected','completed','cancelled')),
 revision integer NOT NULL CHECK(revision>0),target jsonb CHECK(target IS NULL OR jsonb_typeof(target)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((project_id IS NULL)=(project_name IS NULL)));
CREATE INDEX catalog_requests_author ON catalog_requests(created_by,updated_at DESC,id);
CREATE INDEX catalog_requests_project ON catalog_requests(project_id,status,updated_at DESC,id);
CREATE TABLE catalog_request_events (
 id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES catalog_requests(id),action text NOT NULL,actor text NOT NULL,
 comment text NOT NULL,from_status text,to_status text NOT NULL,revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id,revision));
CREATE TABLE catalog_request_mutations (
 actor text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor,request_key));
`;
