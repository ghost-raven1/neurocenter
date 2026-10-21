/** Research receipts preserve full personal history and bind every step to its exact request attempt. */
export const CHAT_RESEARCH_SCHEMA_SQL=`
ALTER TABLE model_chat_turns ADD COLUMN research_request jsonb;
ALTER TABLE model_chat_turns ADD CONSTRAINT model_chat_research_request_check CHECK(research_request IS NULL OR COALESCE((
 jsonb_typeof(research_request)='object' AND research_request-ARRAY['project','external']='{}'::jsonb
 AND jsonb_typeof(research_request->'project')='boolean' AND (research_request->>'project'='true' OR research_request?'external')
 AND (NOT research_request?'external' OR (jsonb_typeof(research_request->'external')='object'
 AND (research_request->'external')-ARRAY['assetId','version','manifest']='{}'::jsonb
 AND jsonb_typeof(research_request->'external'->'assetId')='string' AND length(research_request->'external'->>'assetId') BETWEEN 1 AND 256
 AND jsonb_typeof(research_request->'external'->'version')='number' AND (research_request->'external'->>'version')~'^[1-9][0-9]{0,14}$'
 AND (research_request->'external'->>'manifest')~'^[a-f0-9]{64}$'))),false));
ALTER TABLE model_chat_turns DROP CONSTRAINT model_chat_turns_processing_stage_check;
ALTER TABLE model_chat_turns ADD CONSTRAINT model_chat_turns_processing_stage_check CHECK(processing_stage IN ('compacting','responding','researching'));
ALTER TABLE model_chat_agent_responses DROP CONSTRAINT model_chat_agent_responses_processing_stage_check;
ALTER TABLE model_chat_agent_responses ADD CONSTRAINT model_chat_agent_responses_processing_stage_check CHECK(processing_stage IN ('compacting','responding','researching'));
ALTER TABLE model_usage_calls DROP CONSTRAINT model_usage_calls_purpose_check;
ALTER TABLE model_usage_calls ADD CONSTRAINT model_usage_calls_purpose_check CHECK(purpose IN ('chat','agent','compaction','project-search','device-embedding','reindex','learning','direct','verification','research'));
CREATE TABLE model_chat_research_steps(
 id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES model_chat_conversations(id) ON DELETE CASCADE,
 turn_id uuid NOT NULL REFERENCES model_chat_turns(id) ON DELETE CASCADE,
 response_id uuid REFERENCES model_chat_agent_responses(id) ON DELETE CASCADE,request_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 100),sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 6),
 kind text NOT NULL CHECK(kind IN ('planner','project_search','project_read','external_search','external_fetch')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed','cancelled')),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND octet_length(input::text)<=8192 AND input-ARRAY['query','sourceId','path','startLine','endLine','tool','arguments','modelId','modelPin']='{}'::jsonb),
 output text NOT NULL DEFAULT '' CHECK(octet_length(output)<=65536),
 sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=32 AND octet_length(sources::text)<=65536),
 error text CHECK(octet_length(error)<=2048),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE NULLS NOT DISTINCT(turn_id,response_id,attempt,sequence),
 CHECK((status='pending' AND finished_at IS NULL) OR(status<>'pending' AND finished_at IS NOT NULL)),CHECK(status<>'done' OR error IS NULL)
);
CREATE INDEX model_chat_research_history ON model_chat_research_steps(conversation_id,turn_id,attempt,sequence);
CREATE UNIQUE INDEX model_chat_research_single_pending ON model_chat_research_steps(turn_id,response_id,attempt) NULLS NOT DISTINCT WHERE status='pending';
CREATE FUNCTION model_chat_research_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $research_request$
BEGIN IF NEW.research_request IS DISTINCT FROM OLD.research_request THEN RAISE EXCEPTION 'Research request is immutable'; END IF;RETURN NEW;END
$research_request$;
CREATE TRIGGER model_chat_research_request_immutable BEFORE UPDATE OF research_request ON model_chat_turns FOR EACH ROW EXECUTE FUNCTION model_chat_research_request_immutable();
CREATE FUNCTION model_chat_research_step_binding() RETURNS trigger LANGUAGE plpgsql AS $research_step$
DECLARE parent model_chat_turns%ROWTYPE;recipient model_chat_agent_responses%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id,NEW.conversation_id,NEW.turn_id,NEW.response_id,NEW.request_id,NEW.attempt,NEW.sequence,NEW.kind,NEW.input,NEW.created_at) IS DISTINCT FROM
 (OLD.id,OLD.conversation_id,OLD.turn_id,OLD.response_id,OLD.request_id,OLD.attempt,OLD.sequence,OLD.kind,OLD.input,OLD.created_at) THEN RAISE EXCEPTION 'Research step identity is immutable';END IF;
 SELECT * INTO parent FROM model_chat_turns WHERE id=NEW.turn_id FOR UPDATE;
 IF parent.id IS NULL OR parent.conversation_id<>NEW.conversation_id OR parent.research_request IS NULL OR array_position(parent.request_ids,NEW.request_id) IS DISTINCT FROM NEW.attempt THEN RAISE EXCEPTION 'Research step parent mismatch';END IF;
 IF NEW.response_id IS NOT NULL THEN
  SELECT * INTO recipient FROM model_chat_agent_responses WHERE id=NEW.response_id FOR UPDATE;
  IF recipient.id IS NULL OR recipient.turn_id<>NEW.turn_id OR recipient.conversation_id<>NEW.conversation_id THEN RAISE EXCEPTION 'Research recipient mismatch';END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.status NOT IN ('cancelled') THEN
  IF parent.status<>'pending' OR parent.request_id<>NEW.request_id OR parent.lease_until<=now() OR parent.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Research request no longer pending';END IF;
  IF NEW.response_id IS NOT NULL AND (recipient.status<>'pending' OR recipient.request_id<>NEW.request_id) THEN RAISE EXCEPTION 'Research recipient no longer pending';END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'pending' AND (NEW.status,NEW.output,NEW.sources,NEW.error,NEW.finished_at) IS DISTINCT FROM (OLD.status,OLD.output,OLD.sources,OLD.error,OLD.finished_at) THEN RAISE EXCEPTION 'Research receipt is immutable';END IF;
 RETURN NEW;
END
$research_step$;
CREATE TRIGGER model_chat_research_step_binding BEFORE INSERT OR UPDATE ON model_chat_research_steps FOR EACH ROW EXECUTE FUNCTION model_chat_research_step_binding();

CREATE FUNCTION model_chat_research_stop_pending() RETURNS trigger LANGUAGE plpgsql AS $research_stop$
BEGIN
 IF NEW.status<>'pending' OR NEW.request_id<>OLD.request_id THEN
  IF TG_TABLE_NAME='model_chat_turns' THEN
   UPDATE model_chat_research_steps SET status='cancelled',error='Исследование остановлено.',finished_at=now(),updated_at=now() WHERE turn_id=NEW.id AND request_id=OLD.request_id AND status='pending';
  ELSE
   UPDATE model_chat_research_steps SET status='cancelled',error='Исследование остановлено.',finished_at=now(),updated_at=now() WHERE response_id=NEW.id AND request_id=OLD.request_id AND status='pending';
  END IF;
 END IF;RETURN NEW;
END
$research_stop$;
CREATE TRIGGER model_chat_research_stop_pending AFTER UPDATE OF status,request_id ON model_chat_turns FOR EACH ROW EXECUTE FUNCTION model_chat_research_stop_pending();
CREATE TRIGGER model_chat_research_stop_pending AFTER UPDATE OF status,request_id ON model_chat_agent_responses FOR EACH ROW EXECUTE FUNCTION model_chat_research_stop_pending();
`;
