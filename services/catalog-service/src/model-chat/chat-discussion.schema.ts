/** Migration34 adds bounded receipts without rewriting any historical chat or agent response. */
export const CHAT_DISCUSSION_SCHEMA_SQL = `
CREATE TABLE model_chat_discussions (
 turn_id uuid PRIMARY KEY REFERENCES model_chat_turns(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,actor_role text NOT NULL,model jsonb NOT NULL CHECK(jsonb_typeof(model)='object'),
 roster jsonb NOT NULL CHECK(jsonb_typeof(roster)='array' AND jsonb_array_length(roster) BETWEEN 1 AND 8 AND octet_length(roster::text)<=2097152),
 calls_started integer NOT NULL DEFAULT 0 CHECK(calls_started BETWEEN 0 AND 5),
 deadline_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_chat_discussion_steps (
 id uuid PRIMARY KEY,turn_id uuid NOT NULL REFERENCES model_chat_discussions(turn_id) ON DELETE CASCADE,
 request_id uuid NOT NULL,sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 5),
 step_key text NOT NULL CHECK(length(step_key) BETWEEN 1 AND 200),
 phase text NOT NULL CHECK(phase IN ('context','planning','response','critique','synthesis')),
 model_id text NOT NULL,model_pin text NOT NULL CHECK(model_pin~'^[a-f0-9]{64}$'),
 snapshot jsonb CHECK(snapshot IS NULL OR jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144),
 input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed','cancelled')),
 finish_reason text CHECK(finish_reason IS NULL OR finish_reason IN ('stop','length')),
 output text CHECK(output IS NULL OR octet_length(output)<=16384),error text CHECK(error IS NULL OR octet_length(error)<=1024),
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(turn_id,sequence),UNIQUE(turn_id,step_key),
 CHECK((phase IN ('response','critique'))=(snapshot IS NOT NULL)),
 CHECK((status='pending')=(finished_at IS NULL)),
 CHECK((status='done' AND phase<>'context')=(finish_reason IS NOT NULL)),
 CHECK(status='done' AND (output IS NOT NULL OR phase='context') OR status<>'done' AND output IS NULL)
);
CREATE FUNCTION neurocenter_chat_discussion_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF ROW(NEW.turn_id,NEW.request_id,NEW.actor_role,NEW.model,NEW.roster,NEW.deadline_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.turn_id,OLD.request_id,OLD.actor_role,OLD.model,OLD.roster,OLD.deadline_at,OLD.created_at)
 OR NEW.calls_started<OLD.calls_started OR NEW.calls_started>OLD.calls_started+1
 THEN RAISE EXCEPTION 'Discussion identity and budget are immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER model_chat_discussion_immutable BEFORE UPDATE ON model_chat_discussions FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_discussion_immutable();
CREATE FUNCTION neurocenter_chat_discussion_step_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'pending' AND EXISTS(SELECT 1 FROM model_chat_discussions WHERE turn_id=OLD.turn_id) THEN RAISE EXCEPTION 'Completed discussion step is immutable'; END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.id,NEW.turn_id,NEW.request_id,NEW.sequence,NEW.step_key,NEW.phase,NEW.model_id,NEW.model_pin,NEW.snapshot,NEW.input_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.turn_id,OLD.request_id,OLD.sequence,OLD.step_key,OLD.phase,OLD.model_id,OLD.model_pin,OLD.snapshot,OLD.input_hash,OLD.created_at)
 OR OLD.status<>'pending' AND ROW(NEW.status,NEW.output,NEW.error,NEW.finish_reason,NEW.finished_at) IS DISTINCT FROM ROW(OLD.status,OLD.output,OLD.error,OLD.finish_reason,OLD.finished_at)
 THEN RAISE EXCEPTION 'Discussion step receipt is immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER model_chat_discussion_step_immutable BEFORE UPDATE OR DELETE ON model_chat_discussion_steps FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_discussion_step_immutable();
`;
