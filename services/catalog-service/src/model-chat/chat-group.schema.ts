/** A group is still private to its owner; each explicit round retains immutable persona/model snapshots. */
export const CHAT_GROUP_SCHEMA_SQL = `
ALTER TABLE model_chat_conversations ADD COLUMN mode text NOT NULL DEFAULT 'model' CHECK(mode IN ('model','group'));
ALTER TABLE model_chat_conversations ADD COLUMN agent_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE model_chat_conversations ADD CONSTRAINT model_chat_group_participants CHECK(cardinality(agent_ids)<=8 AND (mode='group' AND project_id IS NOT NULL OR mode='model' AND cardinality(agent_ids)=0));
ALTER TABLE model_chat_turns ADD COLUMN target_agent_ids text[] NOT NULL DEFAULT '{}' CHECK(cardinality(target_agent_ids)<=8);
CREATE TABLE model_chat_agent_responses (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES model_chat_conversations(id) ON DELETE CASCADE,
 turn_id uuid NOT NULL REFERENCES model_chat_turns(id) ON DELETE CASCADE, agent_id text NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144),
 request_id uuid NOT NULL, status text NOT NULL CHECK(status IN ('pending','done','failed','cancelled')),
 processing_stage text NOT NULL DEFAULT 'responding' CHECK(processing_stage IN ('compacting','responding')),
 answer jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(turn_id,agent_id),
 CHECK((status='done' AND answer IS NOT NULL AND jsonb_typeof(answer)='object') OR (status<>'done' AND answer IS NULL))
);
CREATE INDEX model_chat_agent_response_round ON model_chat_agent_responses(conversation_id,turn_id,created_at,id);
CREATE FUNCTION neurocenter_chat_agent_response_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status='done' AND EXISTS(SELECT 1 FROM model_chat_conversations WHERE id=OLD.conversation_id) THEN RAISE EXCEPTION 'Completed agent response is immutable'; END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.id,NEW.conversation_id,NEW.turn_id,NEW.agent_id,NEW.snapshot,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.conversation_id,OLD.turn_id,OLD.agent_id,OLD.snapshot,OLD.created_at)
 OR OLD.status='done' AND ROW(NEW.request_id,NEW.status,NEW.answer,NEW.error) IS DISTINCT FROM ROW(OLD.request_id,OLD.status,OLD.answer,OLD.error)
 THEN RAISE EXCEPTION 'Agent response snapshot is immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER model_chat_agent_response_immutable BEFORE UPDATE OR DELETE ON model_chat_agent_responses FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_agent_response_immutable();
CREATE FUNCTION neurocenter_chat_round_targets_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF OLD.target_agent_ids IS DISTINCT FROM NEW.target_agent_ids THEN RAISE EXCEPTION 'Chat round targets are immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER model_chat_round_targets_immutable BEFORE UPDATE OF target_agent_ids ON model_chat_turns FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_round_targets_immutable();
`;
