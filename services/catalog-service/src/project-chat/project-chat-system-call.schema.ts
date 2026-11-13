/**
 * FR-310: durable record of an explicit project-agent call of a system role.
 * The row is stored in the project-chat finalization transaction together with the
 * audit (NFR-4); state moves exactly once, invoked -> delivered|failed, when the
 * terminal role-run outcome is delivered to the caller's room. Everything else is
 * immutable (trigger); a rejected call has no run and stays rejected forever.
 */
export const PROJECT_CHAT_SYSTEM_CALL_SCHEMA_SQL = `
CREATE TABLE project_chat_system_calls (
  project_id text NOT NULL,room_id uuid NOT NULL,call_id uuid NOT NULL,
  actor_email text NOT NULL,actor_role text NOT NULL,
  source_message_id uuid NOT NULL,response_id uuid NOT NULL,response_generation uuid NOT NULL,
  agent_id text NOT NULL CHECK(length(agent_id) BETWEEN 1 AND 200),agent_name text,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144),
  role_id text NOT NULL CHECK(length(role_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK(reason IN ('problem','clarification','recovery')),
  question text NOT NULL CHECK(octet_length(question) BETWEEN 1 AND 2048),
  run_id uuid,request_id uuid,
  state text NOT NULL CHECK(state IN ('invoked','rejected','delivered','failed')),
  run_state text,error text,
  created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz,
  PRIMARY KEY(project_id,room_id,call_id),
  FOREIGN KEY(project_id,room_id) REFERENCES project_chat_rooms(project_id,id) ON DELETE CASCADE
);
CREATE INDEX project_chat_system_calls_run ON project_chat_system_calls(run_id);
CREATE INDEX project_chat_system_calls_room ON project_chat_system_calls(project_id,room_id,created_at DESC);
CREATE FUNCTION neurocenter_project_chat_system_call_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF OLD.state='invoked' AND NEW.state IN ('delivered','failed')
 AND OLD.run_state IS NULL AND NEW.run_state IS NOT NULL
 AND OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL
 AND OLD.project_id IS NOT DISTINCT FROM NEW.project_id
 AND OLD.room_id IS NOT DISTINCT FROM NEW.room_id
 AND OLD.call_id IS NOT DISTINCT FROM NEW.call_id
 AND OLD.actor_email IS NOT DISTINCT FROM NEW.actor_email
 AND OLD.actor_role IS NOT DISTINCT FROM NEW.actor_role
 AND OLD.source_message_id IS NOT DISTINCT FROM NEW.source_message_id
 AND OLD.response_id IS NOT DISTINCT FROM NEW.response_id
 AND OLD.response_generation IS NOT DISTINCT FROM NEW.response_generation
 AND OLD.agent_id IS NOT DISTINCT FROM NEW.agent_id
 AND OLD.agent_name IS NOT DISTINCT FROM NEW.agent_name
 AND OLD.snapshot IS NOT DISTINCT FROM NEW.snapshot
 AND OLD.role_id IS NOT DISTINCT FROM NEW.role_id
 AND OLD.reason IS NOT DISTINCT FROM NEW.reason
 AND OLD.question IS NOT DISTINCT FROM NEW.question
 AND OLD.run_id IS NOT DISTINCT FROM NEW.run_id
 AND OLD.request_id IS NOT DISTINCT FROM NEW.request_id
 AND OLD.error IS NOT DISTINCT FROM NEW.error
 AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Project chat system call is immutable except invoked to delivered or failed';
END $body$;
CREATE TRIGGER project_chat_system_call_immutable BEFORE UPDATE ON project_chat_system_calls FOR EACH ROW EXECUTE FUNCTION neurocenter_project_chat_system_call_immutable();
`;
