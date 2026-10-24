/** Migration31 adds provenance only for new answers; historical completed rows retain NULL. */
export const PROJECT_CHAT_LEARNING_SCHEMA_SQL = `
ALTER TABLE project_chat_messages ADD COLUMN learning jsonb;
ALTER TABLE project_chat_messages ADD CONSTRAINT project_chat_message_learning_check CHECK (
 learning IS NULL OR coalesce(
  kind='agent' AND status='done' AND jsonb_typeof(learning)='object' AND octet_length(learning::text)<=262144
  AND learning->>'projectId'=project_id AND learning->>'agentId'=snapshot->>'agentId'
  AND learning->>'status' IN ('applied','empty','disabled') AND jsonb_typeof(learning->'entries')='array',false)
);
CREATE OR REPLACE FUNCTION neurocenter_project_chat_message_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF ROW(NEW.id,NEW.project_id,NEW.room_id,NEW.position,NEW.kind,NEW.author_email,NEW.author_name,NEW.author_role,NEW.reply_to_id,NEW.source_message_id,NEW.request_key,NEW.request_hash,NEW.target_agent_ids,NEW.snapshot,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.room_id,OLD.position,OLD.kind,OLD.author_email,OLD.author_name,OLD.author_role,OLD.reply_to_id,OLD.source_message_id,OLD.request_key,OLD.request_hash,OLD.target_agent_ids,OLD.snapshot,OLD.created_at)
 OR OLD.kind='user' AND NEW.content IS DISTINCT FROM OLD.content
 OR OLD.kind='agent' AND OLD.status='done' AND ROW(NEW.content,NEW.status,NEW.usage,NEW.learning,NEW.generation) IS DISTINCT FROM ROW(OLD.content,OLD.status,OLD.usage,OLD.learning,OLD.generation)
 THEN RAISE EXCEPTION 'Project chat message attribution is immutable'; END IF;
 RETURN NEW;
END $body$;
`;
