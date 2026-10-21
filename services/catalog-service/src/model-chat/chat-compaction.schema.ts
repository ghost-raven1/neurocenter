/** Checkpoints retain an immutable projection; original successful conversation records stay intact. */
export const CHAT_COMPACTION_SCHEMA_SQL = `
ALTER TABLE model_chat_turns ADD COLUMN processing_stage text NOT NULL DEFAULT 'responding' CHECK(processing_stage IN ('compacting','responding'));
CREATE TABLE model_chat_compactions (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES model_chat_conversations(id) ON DELETE CASCADE,
 previous_id uuid REFERENCES model_chat_compactions(id) ON DELETE CASCADE,
 through_turn_id uuid NOT NULL REFERENCES model_chat_turns(id) ON DELETE CASCADE,
 through_position bigint NOT NULL, through_role text NOT NULL CHECK(through_role IN ('user','assistant')),
 through_offset integer NOT NULL CHECK(through_offset>=0), through_complete boolean NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 model_pin text NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'), summary text NOT NULL CHECK(octet_length(summary) BETWEEN 1 AND 65536),
 usage jsonb NOT NULL CHECK(jsonb_typeof(usage)='object'), algorithm_version integer NOT NULL DEFAULT 1 CHECK(algorithm_version=1),
 created_for_turn uuid NOT NULL REFERENCES model_chat_turns(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,source_sha256,model_pin,algorithm_version)
);
CREATE INDEX model_chat_compaction_latest ON model_chat_compactions(conversation_id,created_at DESC,id);
CREATE FUNCTION neurocenter_chat_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM model_chat_conversations WHERE id=OLD.conversation_id) THEN RAISE EXCEPTION 'Completed chat history is immutable'; END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.conversation_id,NEW.position,NEW.request_id,NEW.request_ids,NEW.prompt,NEW.input_text,NEW.attachment_ids,NEW.answer,NEW.status,NEW.removed_at)
  IS DISTINCT FROM ROW(OLD.conversation_id,OLD.position,OLD.request_id,OLD.request_ids,OLD.prompt,OLD.input_text,OLD.attachment_ids,OLD.answer,OLD.status,OLD.removed_at)
 THEN RAISE EXCEPTION 'Completed chat history is immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER model_chat_completed_history BEFORE UPDATE OR DELETE ON model_chat_turns FOR EACH ROW WHEN(OLD.status='done') EXECUTE FUNCTION neurocenter_chat_history_immutable();
CREATE FUNCTION neurocenter_chat_checkpoint_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM model_chat_conversations WHERE id=OLD.conversation_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Chat context checkpoint is immutable';
END $body$;
CREATE TRIGGER model_chat_checkpoint_immutable BEFORE UPDATE OR DELETE ON model_chat_compactions FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_checkpoint_immutable();
`;
