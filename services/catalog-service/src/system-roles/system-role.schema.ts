/** One journal owns both system roles; source, consent, identity and lease generation are immutable. */
export const SYSTEM_ROLE_SCHEMA_SQL = `
ALTER TABLE project_snapshot_verifiers ADD COLUMN container_observation jsonb CHECK(container_observation IS NULL OR jsonb_typeof(container_observation)='object' AND octet_length(container_observation::text)<=16384);
CREATE TABLE system_role_runs (
 id uuid PRIMARY KEY,agent_id text NOT NULL CHECK(agent_id IN ('agent-ai-admin','agent-autoconfigurator','agent-indexer','agent-packager')),
 project_id text REFERENCES projects(id) ON DELETE CASCADE,actor text NOT NULL,actor_role text NOT NULL,
 request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=131072),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=524288),
 model jsonb NOT NULL CHECK(jsonb_typeof(model)='object' AND octet_length(model::text)<=16384),
 runner_instance uuid NOT NULL,lease_token uuid NOT NULL,lease_until timestamptz,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','awaiting_review','applying','succeeded','failed','cancelled','interrupted')),
 phase text NOT NULL DEFAULT 'queued' CHECK(phase~'^[a-z_]{1,64}$'),revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 calls_started integer NOT NULL DEFAULT 0 CHECK(calls_started BETWEEN 0 AND 2),
 facts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(facts)='array' AND jsonb_array_length(facts)<=4 AND octet_length(facts::text)<=65536),
 result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object' AND octet_length(result::text)<=32768),
 steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array' AND jsonb_array_length(steps)<=32 AND octet_length(steps::text)<=16384),
 applied jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(applied)='array' AND jsonb_array_length(applied)<=4 AND octet_length(applied::text)<=8192),
 message text NOT NULL CHECK(octet_length(message)<=2048),created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(actor,request_id),
 CHECK((state IN ('queued','running','applying') AND lease_until IS NOT NULL AND finished_at IS NULL)
 OR(state='awaiting_review' AND lease_until IS NULL AND finished_at IS NULL)
 OR(state IN ('succeeded','failed','cancelled','interrupted') AND lease_until IS NULL AND finished_at IS NOT NULL))
);
CREATE INDEX system_role_owner_history ON system_role_runs(actor,agent_id,project_id,created_at DESC,id);
CREATE INDEX system_role_pending_runner ON system_role_runs(runner_instance,created_at,id) WHERE state='queued';
CREATE FUNCTION system_role_run_guard() RETURNS trigger LANGUAGE plpgsql AS $role$
BEGIN
 IF (NEW.id,NEW.agent_id,NEW.project_id,NEW.actor,NEW.actor_role,NEW.request_id,NEW.request_hash,NEW.request,NEW.snapshot,NEW.model,NEW.runner_instance,NEW.lease_token,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.agent_id,OLD.project_id,OLD.actor,OLD.actor_role,OLD.request_id,OLD.request_hash,OLD.request,OLD.snapshot,OLD.model,OLD.runner_instance,OLD.lease_token,OLD.created_at)
 THEN RAISE EXCEPTION 'System role source is immutable';END IF;
 IF NEW.revision<>OLD.revision+1 OR NEW.calls_started<OLD.calls_started OR NEW.calls_started>OLD.calls_started+1
 OR NEW.calls_started<>OLD.calls_started AND NOT(OLD.state='running' AND NEW.state='running' AND NEW.phase='model_step')
 THEN RAISE EXCEPTION 'System role generation or call budget is invalid';END IF;
 IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN RAISE EXCEPTION 'System role proposal is immutable';END IF;
 IF OLD.state IN ('succeeded','failed','interrupted') AND NOT(NEW.state='applying' AND NEW.phase='rolling_back' AND jsonb_array_length(OLD.applied)>0)
 OR OLD.state='cancelled' OR OLD.state='queued' AND NEW.state NOT IN ('running','cancelled','interrupted','failed')
 OR OLD.state='running' AND NEW.state NOT IN ('running','awaiting_review','succeeded','failed','cancelled','interrupted')
 OR OLD.state='awaiting_review' AND NEW.state NOT IN ('awaiting_review','applying','cancelled')
 OR OLD.state='applying' AND NEW.state NOT IN ('applying','succeeded','failed','interrupted')
 THEN RAISE EXCEPTION 'System role transition is invalid';END IF;
 RETURN NEW;
END $role$;
CREATE TRIGGER system_role_run_guard BEFORE UPDATE ON system_role_runs FOR EACH ROW EXECUTE FUNCTION system_role_run_guard();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON system_role_runs FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
`;
