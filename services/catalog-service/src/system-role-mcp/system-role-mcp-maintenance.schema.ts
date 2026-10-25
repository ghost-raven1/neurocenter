/** A closed server session remains a physical device fence until its worker confirms local cleanup. */
export const SYSTEM_ROLE_MCP_MAINTENANCE_SCHEMA_SQL = `
ALTER TABLE system_role_mcp_sessions ADD COLUMN worker_closed_at timestamptz;
ALTER TABLE system_role_mcp_sessions ADD COLUMN worker_claim_request_id uuid;
ALTER TABLE system_role_mcp_sessions ADD COLUMN worker_claim_token_hash text;
ALTER TABLE system_role_mcp_sessions ADD CONSTRAINT system_role_mcp_worker_claim_check
 CHECK((worker_claim_request_id IS NULL)=(worker_claim_token_hash IS NULL) AND (worker_claim_request_id IS NULL
 OR (target->>'runtime'='device' AND claimed_at IS NOT NULL AND worker_claim_token_hash~'^[a-f0-9]{64}$')));
ALTER TABLE system_role_mcp_sessions ADD CONSTRAINT system_role_mcp_worker_closed_check
 CHECK(worker_closed_at IS NULL OR (target->>'runtime'='device' AND claimed_at IS NOT NULL AND state='closed'));
CREATE INDEX system_role_mcp_device_cleanup_pending ON system_role_mcp_sessions((target->>'deviceId'))
 WHERE target->>'runtime'='device' AND claimed_at IS NOT NULL AND worker_closed_at IS NULL;
CREATE UNIQUE INDEX system_role_mcp_device_claim_request ON system_role_mcp_sessions((target->>'deviceId'),worker_claim_request_id)
 WHERE worker_claim_request_id IS NOT NULL;
CREATE TABLE system_role_mcp_retired_claims (
 device_id text NOT NULL REFERENCES bridge_devices(id) ON DELETE CASCADE,
 token_hash text NOT NULL CHECK(token_hash~'^[a-f0-9]{64}$'),request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(device_id,token_hash,request_id)
);
CREATE FUNCTION system_role_mcp_retired_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $retired$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM bridge_devices WHERE id=OLD.device_id) THEN
  RAISE EXCEPTION 'MCP retired claim receipt is immutable';
 END IF;
 RETURN OLD;
END $retired$;
CREATE TRIGGER system_role_mcp_retired_claim_guard BEFORE UPDATE OR DELETE ON system_role_mcp_retired_claims
 FOR EACH ROW EXECUTE FUNCTION system_role_mcp_retired_claim_guard();
CREATE FUNCTION system_role_mcp_worker_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $cleanup$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.target->>'runtime'='device' AND OLD.claimed_at IS NOT NULL AND OLD.worker_closed_at IS NULL THEN
   RAISE EXCEPTION 'MCP device cleanup is not acknowledged' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
 END IF;
 IF OLD.worker_closed_at IS NOT NULL AND NEW.worker_closed_at IS DISTINCT FROM OLD.worker_closed_at THEN
  RAISE EXCEPTION 'MCP worker cleanup receipt is immutable';
 END IF;
 IF OLD.claimed_at IS NOT NULL AND (NEW.worker_claim_request_id,NEW.worker_claim_token_hash)
 IS DISTINCT FROM (OLD.worker_claim_request_id,OLD.worker_claim_token_hash) THEN
  RAISE EXCEPTION 'MCP worker claim receipt is immutable';
 END IF;
 RETURN NEW;
END $cleanup$;
CREATE TRIGGER system_role_mcp_worker_cleanup_guard BEFORE UPDATE OR DELETE ON system_role_mcp_sessions
 FOR EACH ROW EXECUTE FUNCTION system_role_mcp_worker_cleanup_guard();
`;
