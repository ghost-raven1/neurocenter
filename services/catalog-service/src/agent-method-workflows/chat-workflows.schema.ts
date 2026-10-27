/** Server-only chat attribution leaves the native workflow protocol and existing message kinds unchanged. */
export const METHOD_CHAT_WORKFLOWS_SCHEMA_SQL=`
CREATE TABLE project_chat_method_workflows (
 job_id text PRIMARY KEY REFERENCES bridge_jobs(id),
 project_id text NOT NULL,room_id uuid NOT NULL,source_message_id uuid NOT NULL,
 owner_email text NOT NULL,owner_role text NOT NULL,
 publication_state text NOT NULL DEFAULT 'pending' CHECK(publication_state IN ('pending','published','withheld')),
 public_result jsonb CHECK(public_result IS NULL OR jsonb_typeof(public_result)='object' AND octet_length(public_result::text)<=524288),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT method_chat_source FOREIGN KEY(project_id,room_id,source_message_id) REFERENCES project_chat_messages(project_id,room_id,id) ON DELETE CASCADE,
 CONSTRAINT method_chat_publication CHECK(publication_state='published' OR public_result IS NULL)
);
CREATE INDEX project_chat_method_source ON project_chat_method_workflows(project_id,room_id,source_message_id,created_at,job_id);
CREATE FUNCTION neurocenter_method_chat_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF ROW(NEW.job_id,NEW.project_id,NEW.room_id,NEW.source_message_id,NEW.owner_email,NEW.owner_role,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.job_id,OLD.project_id,OLD.room_id,OLD.source_message_id,OLD.owner_email,OLD.owner_role,OLD.created_at)
 OR OLD.publication_state<>'pending' AND ROW(NEW.publication_state,NEW.public_result) IS DISTINCT FROM ROW(OLD.publication_state,OLD.public_result)
 THEN RAISE EXCEPTION 'Method chat attribution and published receipt are immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER method_chat_origin_immutable BEFORE UPDATE ON project_chat_method_workflows FOR EACH ROW EXECUTE FUNCTION neurocenter_method_chat_origin_immutable();
`;
