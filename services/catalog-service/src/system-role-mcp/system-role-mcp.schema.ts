/** Explicit discoveries and calls share durable at-most-once dispatch markers across server and device transports. */
export const SYSTEM_ROLE_MCP_SCHEMA_SQL = `
CREATE TABLE system_role_mcp_sessions (
 id uuid PRIMARY KEY,owner_email text NOT NULL REFERENCES platform_users(email) ON DELETE CASCADE,actor_role text NOT NULL,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,run_id uuid REFERENCES system_role_runs(id) ON DELETE CASCADE,lease_token uuid,
 target_hash text NOT NULL CHECK(target_hash~'^[a-f0-9]{64}$'),target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=16384),
 package jsonb NOT NULL CHECK(jsonb_typeof(package)='object' AND octet_length(package::text)<=25165824),
 install_set jsonb CHECK(install_set IS NULL OR jsonb_typeof(install_set)='object' AND octet_length(install_set::text)<=25165824),
 job_id text UNIQUE,worker_lease uuid,worker_lease_until timestamptz,claimed_at timestamptz,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),deadline_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((run_id IS NULL)=(lease_token IS NULL)),CHECK((target->>'runtime'='device')=(job_id IS NOT NULL)),
 CHECK((job_id IS NULL)=(worker_lease IS NULL)),UNIQUE(run_id,lease_token,target_hash)
);
CREATE INDEX system_role_mcp_open_sessions ON system_role_mcp_sessions(deadline_at) WHERE state='open';
CREATE TABLE system_role_mcp_calls (
 id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES system_role_mcp_sessions(id) ON DELETE CASCADE,run_id uuid REFERENCES system_role_runs(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('list','call')),dispatch_proof text NOT NULL CHECK(dispatch_proof~'^[a-f0-9]{64}$'),tool_key text CHECK(tool_key IS NULL OR tool_key~'^[a-f0-9]{64}$'),name text,schema_digest text CHECK(schema_digest IS NULL OR schema_digest~'^[a-f0-9]{64}$'),
 arguments jsonb CHECK(arguments IS NULL OR jsonb_typeof(arguments)='object' AND octet_length(arguments::text)<=16384),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','dispatched','succeeded','failed','unknown','cancelled')),
 result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object' AND octet_length(result::text)<=524288),
 late_result jsonb CHECK(late_result IS NULL OR jsonb_typeof(late_result)='object' AND octet_length(late_result::text)<=524288),
 deadline_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),dispatched_at timestamptz,completed_at timestamptz,
 CHECK((kind='list' AND tool_key IS NULL AND name IS NULL AND schema_digest IS NULL AND arguments IS NULL AND run_id IS NULL)
 OR(kind='call' AND tool_key IS NOT NULL AND name IS NOT NULL AND schema_digest IS NOT NULL AND arguments IS NOT NULL AND run_id IS NOT NULL))
);
CREATE INDEX system_role_mcp_next_call ON system_role_mcp_calls(session_id,created_at,id) WHERE state='queued';
CREATE INDEX system_role_mcp_run_calls ON system_role_mcp_calls(run_id,created_at,id);
CREATE TABLE system_role_mcp_discoveries (
 id uuid PRIMARY KEY,owner_email text NOT NULL REFERENCES platform_users(email) ON DELETE CASCADE,actor_role text NOT NULL,project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=16384),
 session_id uuid NOT NULL UNIQUE REFERENCES system_role_mcp_sessions(id) ON DELETE CASCADE,call_id uuid NOT NULL UNIQUE REFERENCES system_role_mcp_calls(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,UNIQUE(owner_email,id)
);
CREATE FUNCTION system_role_mcp_session_guard() RETURNS trigger LANGUAGE plpgsql AS $session$
BEGIN
 IF (NEW.id,NEW.owner_email,NEW.actor_role,NEW.project_id,NEW.run_id,NEW.lease_token,NEW.target_hash,NEW.target,NEW.package,NEW.install_set,NEW.job_id,NEW.worker_lease,NEW.deadline_at,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.owner_email,OLD.actor_role,OLD.project_id,OLD.run_id,OLD.lease_token,OLD.target_hash,OLD.target,OLD.package,OLD.install_set,OLD.job_id,OLD.worker_lease,OLD.deadline_at,OLD.created_at)
 OR OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
 OR OLD.state='closed' AND NEW.state<>'closed' THEN RAISE EXCEPTION 'MCP session source is immutable'; END IF;
 RETURN NEW;END $session$;
CREATE TRIGGER system_role_mcp_session_guard BEFORE UPDATE ON system_role_mcp_sessions FOR EACH ROW EXECUTE FUNCTION system_role_mcp_session_guard();
CREATE FUNCTION system_role_mcp_call_guard() RETURNS trigger LANGUAGE plpgsql AS $call$
BEGIN
 IF (NEW.id,NEW.session_id,NEW.run_id,NEW.kind,NEW.dispatch_proof,NEW.tool_key,NEW.name,NEW.schema_digest,NEW.arguments,NEW.deadline_at,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.session_id,OLD.run_id,OLD.kind,OLD.dispatch_proof,OLD.tool_key,OLD.name,OLD.schema_digest,OLD.arguments,OLD.deadline_at,OLD.created_at)
 OR OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result OR OLD.late_result IS NOT NULL AND NEW.late_result IS DISTINCT FROM OLD.late_result
 OR OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at
 OR OLD.state IN ('succeeded','failed','unknown','cancelled') AND NEW.state<>OLD.state
 OR OLD.state='queued' AND NEW.state NOT IN ('queued','dispatched','failed','cancelled')
 OR OLD.state='dispatched' AND NEW.state NOT IN ('dispatched','succeeded','failed','unknown','cancelled')
 THEN RAISE EXCEPTION 'MCP call source or dispatch outcome is immutable'; END IF;
 RETURN NEW;END $call$;
CREATE TRIGGER system_role_mcp_call_guard BEFORE UPDATE ON system_role_mcp_calls FOR EACH ROW EXECUTE FUNCTION system_role_mcp_call_guard();
CREATE FUNCTION system_role_mcp_discovery_guard() RETURNS trigger LANGUAGE plpgsql AS $discovery$
BEGIN RAISE EXCEPTION 'MCP discovery receipt is immutable'; END $discovery$;
CREATE TRIGGER system_role_mcp_discovery_guard BEFORE UPDATE ON system_role_mcp_discoveries FOR EACH ROW EXECUTE FUNCTION system_role_mcp_discovery_guard();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON system_role_mcp_sessions FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON system_role_mcp_discoveries FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
ALTER TABLE system_role_runs DROP CONSTRAINT system_role_runs_calls_started_check;
ALTER TABLE system_role_runs ADD CONSTRAINT system_role_runs_calls_started_check CHECK(calls_started>=0 AND calls_started<=CASE
 WHEN jsonb_typeof(request->'mcp')='array' AND jsonb_array_length(request->'mcp')>0 THEN CASE WHEN agent_id='agent-coordinator' THEN 11 ELSE 8 END
 ELSE CASE WHEN agent_id='agent-coordinator' THEN 5 ELSE 2 END END);
`;
