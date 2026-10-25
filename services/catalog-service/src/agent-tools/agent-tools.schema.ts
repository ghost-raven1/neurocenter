/** Additive migration42: explicit grants and a separate one-dispatch ledger; historical research bytes stay immutable. */
export const AGENT_TOOLS_SCHEMA_SQL=`
CREATE FUNCTION agent_tool_grant_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $valid$
 SELECT CASE WHEN jsonb_typeof(v)='object' THEN COALESCE(
  octet_length(v::text)<=16384 AND v-ARRAY['protocol','rag','publicChats','systemRoles']='{}'::jsonb AND v->>'protocol'='json-actions-v1'
  AND jsonb_typeof(v->'rag')='boolean' AND (NOT v?'systemRoles' OR jsonb_typeof(v->'systemRoles')='boolean')
  AND (v->'rag'='true'::jsonb OR v->'systemRoles'='true'::jsonb OR v?'publicChats')
  AND (NOT v?'publicChats' OR (jsonb_typeof(v->'publicChats')='object' AND (v->'publicChats')-ARRAY['modelId','expectedModelPin','consent','roomId']='{}'::jsonb
   AND jsonb_typeof(v->'publicChats'->'modelId')='string' AND length(v->'publicChats'->>'modelId') BETWEEN 1 AND 256
   AND v->'publicChats'->>'expectedModelPin'~'^[a-f0-9]{64}$' AND v->'publicChats'->'consent'='true'::jsonb
   AND (NOT (v->'publicChats')?'roomId' OR v->'publicChats'->>'roomId'~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'))),false) ELSE false END;
$valid$;
ALTER TABLE model_chat_turns ADD COLUMN agent_tools_request jsonb CONSTRAINT agent_tool_model_grant_shape CHECK(agent_tools_request IS NULL OR agent_tool_grant_valid(agent_tools_request));
ALTER TABLE project_chat_messages ADD COLUMN agent_tools_request jsonb CONSTRAINT agent_tool_project_grant_shape CHECK(agent_tools_request IS NULL OR agent_tool_grant_valid(agent_tools_request));
CREATE FUNCTION agent_tool_grant_immutable() RETURNS trigger LANGUAGE plpgsql AS $grant$
BEGIN
 IF NEW.agent_tools_request IS DISTINCT FROM OLD.agent_tools_request THEN RAISE EXCEPTION 'Accepted agent tool grant is immutable'; END IF;
 RETURN NEW;
END;$grant$;
CREATE TRIGGER agent_tool_model_grant BEFORE UPDATE OF agent_tools_request ON model_chat_turns FOR EACH ROW EXECUTE FUNCTION agent_tool_grant_immutable();
CREATE TRIGGER agent_tool_project_grant BEFORE UPDATE OF agent_tools_request ON project_chat_messages FOR EACH ROW EXECUTE FUNCTION agent_tool_grant_immutable();
CREATE TABLE agent_tool_steps (
 id uuid PRIMARY KEY,owner_kind text NOT NULL CHECK(owner_kind IN ('model-chat','project-chat')),
 origin_id uuid NOT NULL,turn_id uuid NOT NULL,recipient_id uuid NOT NULL,generation uuid NOT NULL,
 owner_email text NOT NULL CHECK(length(owner_email) BETWEEN 1 AND 320),actor_role text NOT NULL CHECK(length(actor_role) BETWEEN 1 AND 128),
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,agent_id text,model_id text NOT NULL,model_pin text NOT NULL CHECK(model_pin~'^[a-f0-9]{64}$'),
 grant_snapshot jsonb NOT NULL CHECK(agent_tool_grant_valid(grant_snapshot)),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 6),
 action text NOT NULL CHECK(action IN ('planner','rag_search','rag_read','public_chat_search','request_system_role')),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND octet_length(input::text)<=16384),input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','dispatched','succeeded','failed','unknown','cancelled')),
 output jsonb CHECK(output IS NULL OR octet_length(output::text)<=32768),reference jsonb CHECK(reference IS NULL OR (jsonb_typeof(reference)='object' AND octet_length(reference::text)<=4096)),
 error text CHECK(octet_length(error)<=1000),deadline_at timestamptz NOT NULL,dispatched_at timestamptz,finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_kind,turn_id,recipient_id,generation,sequence),
 CHECK(deadline_at>created_at AND deadline_at<=created_at+interval '2 minutes'),
 CHECK((state='queued' AND dispatched_at IS NULL AND finished_at IS NULL AND output IS NULL)
  OR (state='dispatched' AND dispatched_at IS NOT NULL AND finished_at IS NULL AND output IS NULL)
  OR (state='succeeded' AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL AND output IS NOT NULL)
  OR (state IN ('failed','unknown','cancelled') AND finished_at IS NOT NULL AND output IS NULL))
);
CREATE INDEX agent_tool_owner_history ON agent_tool_steps(owner_email,project_id,turn_id,created_at DESC,id);
CREATE INDEX agent_tool_expiry ON agent_tool_steps(deadline_at) WHERE state IN ('queued','dispatched');
CREATE FUNCTION agent_tool_step_guard() RETURNS trigger LANGUAGE plpgsql AS $step$
DECLARE valid boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'queued' OR NEW.dispatched_at IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.output IS NOT NULL OR NEW.reference IS NOT NULL THEN RAISE EXCEPTION 'Agent tool must begin queued'; END IF;
  IF NEW.owner_kind='model-chat' THEN
   SELECT EXISTS(SELECT 1 FROM model_chat_conversations c JOIN model_chat_turns t ON t.conversation_id=c.id
    WHERE c.id=NEW.origin_id AND c.owner_email=NEW.owner_email AND c.project_id=NEW.project_id AND t.id=NEW.turn_id
     AND t.request_id=NEW.generation AND t.status='pending' AND t.removed_at IS NULL AND t.lease_until>clock_timestamp() AND t.agent_tools_request=NEW.grant_snapshot
     AND ((NEW.recipient_id=t.id AND c.mode='model' AND NEW.agent_id IS NULL AND c.model_id=NEW.model_id AND c.model_pin=NEW.model_pin)
      OR EXISTS(SELECT 1 FROM model_chat_agent_responses r WHERE r.id=NEW.recipient_id AND r.turn_id=t.id AND r.request_id=NEW.generation AND r.status='pending'
       AND r.agent_id=NEW.agent_id AND r.snapshot->>'modelId'=NEW.model_id AND r.snapshot->>'modelPin'=NEW.model_pin))) INTO valid;
  ELSE
   SELECT EXISTS(SELECT 1 FROM project_chat_messages s JOIN project_chat_messages r ON r.project_id=s.project_id AND r.room_id=s.room_id AND r.source_message_id=s.id
    WHERE s.project_id=NEW.project_id AND s.room_id=NEW.origin_id AND s.id=NEW.turn_id AND s.author_email=NEW.owner_email AND s.author_role=NEW.actor_role
     AND r.id=NEW.recipient_id AND s.generation=NEW.generation AND r.generation=NEW.generation AND s.agent_tools_request=NEW.grant_snapshot
     AND s.status='running' AND r.status='running' AND s.lease_until>clock_timestamp() AND r.lease_until>clock_timestamp()
     AND r.snapshot->>'agentId'=NEW.agent_id AND r.snapshot->>'modelId'=NEW.model_id AND r.snapshot->>'modelPin'=NEW.model_pin) INTO valid;
  END IF;
  IF NOT valid THEN RAISE EXCEPTION 'Agent tool owner or accepted grant changed'; END IF;
 ELSE
  IF (NEW.id,NEW.owner_kind,NEW.origin_id,NEW.turn_id,NEW.recipient_id,NEW.generation,NEW.owner_email,NEW.actor_role,NEW.project_id,NEW.agent_id,NEW.model_id,NEW.model_pin,NEW.grant_snapshot,NEW.sequence,NEW.action,NEW.input,NEW.input_hash,NEW.deadline_at,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.owner_kind,OLD.origin_id,OLD.turn_id,OLD.recipient_id,OLD.generation,OLD.owner_email,OLD.actor_role,OLD.project_id,OLD.agent_id,OLD.model_id,OLD.model_pin,OLD.grant_snapshot,OLD.sequence,OLD.action,OLD.input,OLD.input_hash,OLD.deadline_at,OLD.created_at)
  THEN RAISE EXCEPTION 'Agent tool identity is immutable'; END IF;
  IF OLD.state NOT IN ('queued','dispatched') THEN RAISE EXCEPTION 'Agent tool receipt is terminal'; END IF;
  IF OLD.state='queued' AND NEW.state NOT IN ('dispatched','failed','cancelled') OR OLD.state='dispatched' AND NEW.state NOT IN ('dispatched','succeeded','failed','unknown') THEN RAISE EXCEPTION 'Invalid agent tool state transition'; END IF;
  IF OLD.state='dispatched' AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN RAISE EXCEPTION 'Agent tool dispatch is immutable'; END IF;
  IF OLD.reference IS NOT NULL AND NEW.reference IS DISTINCT FROM OLD.reference THEN RAISE EXCEPTION 'Agent tool reference is immutable'; END IF;
 END IF;
 RETURN NEW;
END;$step$;
CREATE TRIGGER agent_tool_step_guard BEFORE INSERT OR UPDATE ON agent_tool_steps FOR EACH ROW EXECUTE FUNCTION agent_tool_step_guard();
`;
