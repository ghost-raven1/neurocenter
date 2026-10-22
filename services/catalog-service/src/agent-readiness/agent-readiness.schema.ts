/** Diagnostic attempts are durable and owner-scoped; a restart never replays paid inference. */
export const AGENT_READINESS_SCHEMA_SQL = `
CREATE TABLE agent_readiness_trials (
 id uuid PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES agent_catalog(id),owner_email text NOT NULL,
 request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=2048),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=131072),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),lease_token uuid NOT NULL,lease_until timestamptz,
 message text NOT NULL CHECK(octet_length(message)<=2048),created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(owner_email,request_id),
 CHECK((status IN ('queued','running') AND finished_at IS NULL AND lease_until IS NOT NULL)
 OR(status NOT IN ('queued','running') AND finished_at IS NOT NULL AND lease_until IS NULL))
);
CREATE INDEX agent_readiness_owner_history ON agent_readiness_trials(owner_email,project_id,agent_id,created_at DESC,id);
CREATE UNIQUE INDEX agent_readiness_single_pending ON agent_readiness_trials(owner_email,project_id,agent_id) WHERE status IN ('queued','running');
CREATE FUNCTION agent_readiness_trial_immutable() RETURNS trigger LANGUAGE plpgsql AS $trial$
BEGIN
 IF (NEW.id,NEW.project_id,NEW.agent_id,NEW.owner_email,NEW.request_id,NEW.request_hash,NEW.request,NEW.snapshot,NEW.lease_token,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.agent_id,OLD.owner_email,OLD.request_id,OLD.request_hash,OLD.request,OLD.snapshot,OLD.lease_token,OLD.created_at)
 THEN RAISE EXCEPTION 'Agent trial source is immutable';END IF;
 IF OLD.status NOT IN ('queued','running') THEN RAISE EXCEPTION 'Agent trial receipt is immutable';END IF;
 IF NEW.revision<>OLD.revision+1 OR OLD.status='running' AND NEW.status='queued' THEN RAISE EXCEPTION 'Agent trial transition is invalid';END IF;
 RETURN NEW;
END $trial$;
CREATE TRIGGER agent_readiness_trial_immutable BEFORE UPDATE ON agent_readiness_trials FOR EACH ROW EXECUTE FUNCTION agent_readiness_trial_immutable();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON agent_readiness_trials FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
`;
