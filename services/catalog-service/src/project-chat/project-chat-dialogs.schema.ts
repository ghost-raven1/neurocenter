/** Migration 25 preserves legacy public history while fencing every named dialogue by its room. */
export const PROJECT_CHAT_DIALOGS_SCHEMA_SQL = `
ALTER TABLE model_usage_calls ADD COLUMN private_project_chat_room_id uuid;
ALTER TABLE project_chat_rooms
 ADD COLUMN id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 ADD COLUMN title text NOT NULL DEFAULT 'Общий чат' CHECK(length(btrim(title)) BETWEEN 1 AND 120),
 ADD COLUMN visibility text NOT NULL DEFAULT 'PUBLIC' CHECK(visibility IN ('PUBLIC','PRIVATE')),
 ADD COLUMN creator_email text,
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN create_request_key uuid,
 ADD COLUMN create_request_hash text CHECK(create_request_hash~'^[a-f0-9]{64}$'),
 ADD CONSTRAINT project_chat_room_origin CHECK((id='00000000-0000-0000-0000-000000000000' AND visibility='PUBLIC' AND creator_email IS NULL AND create_request_key IS NULL AND create_request_hash IS NULL)
 OR (id<>'00000000-0000-0000-0000-000000000000' AND creator_email IS NOT NULL AND create_request_key IS NOT NULL AND create_request_hash IS NOT NULL)),
 ADD CONSTRAINT project_chat_room_creation UNIQUE(project_id,creator_email,create_request_key);
ALTER TABLE project_chat_messages ADD COLUMN room_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE project_chat_retry_requests ADD COLUMN room_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE project_chat_messages DROP CONSTRAINT project_chat_messages_project_id_fkey;
ALTER TABLE project_chat_retry_requests DROP CONSTRAINT project_chat_retry_requests_project_id_fkey;
ALTER TABLE project_chat_rooms DROP CONSTRAINT project_chat_rooms_pkey,ADD PRIMARY KEY(project_id,id);
ALTER TABLE project_chat_messages
 ADD CONSTRAINT project_chat_message_room FOREIGN KEY(project_id,room_id) REFERENCES project_chat_rooms(project_id,id) ON DELETE CASCADE,
 ADD CONSTRAINT project_chat_message_room_id UNIQUE(project_id,room_id,id),
 DROP CONSTRAINT project_chat_messages_project_id_author_email_request_key_key,
 ADD CONSTRAINT project_chat_message_request UNIQUE(project_id,room_id,author_email,request_key),
 DROP CONSTRAINT project_chat_messages_project_id_reply_to_id_fkey,
 DROP CONSTRAINT project_chat_messages_project_id_source_message_id_fkey,
 ADD CONSTRAINT project_chat_message_reply FOREIGN KEY(project_id,room_id,reply_to_id) REFERENCES project_chat_messages(project_id,room_id,id),
 ADD CONSTRAINT project_chat_message_source FOREIGN KEY(project_id,room_id,source_message_id) REFERENCES project_chat_messages(project_id,room_id,id);
ALTER TABLE project_chat_retry_requests
 DROP CONSTRAINT project_chat_retry_requests_pkey,
 DROP CONSTRAINT project_chat_retry_requests_project_id_message_id_fkey,
 ADD PRIMARY KEY(project_id,room_id,actor_email,request_key),
 ADD CONSTRAINT project_chat_retry_room FOREIGN KEY(project_id,room_id) REFERENCES project_chat_rooms(project_id,id) ON DELETE CASCADE,
 ADD CONSTRAINT project_chat_retry_message FOREIGN KEY(project_id,room_id,message_id) REFERENCES project_chat_messages(project_id,room_id,id);
CREATE TABLE project_chat_room_members (
 project_id text NOT NULL,room_id uuid NOT NULL,email text NOT NULL REFERENCES platform_users(email) ON DELETE CASCADE,
 PRIMARY KEY(project_id,room_id,email),
 FOREIGN KEY(project_id,room_id) REFERENCES project_chat_rooms(project_id,id) ON DELETE CASCADE
);
DROP INDEX project_chat_history;
CREATE INDEX project_chat_history ON project_chat_messages(project_id,room_id,position DESC);
CREATE INDEX project_chat_dialogs_list ON project_chat_rooms(project_id,updated_at DESC,id);
CREATE OR REPLACE FUNCTION neurocenter_project_chat_message_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF ROW(NEW.id,NEW.project_id,NEW.room_id,NEW.position,NEW.kind,NEW.author_email,NEW.author_name,NEW.author_role,NEW.reply_to_id,NEW.source_message_id,NEW.request_key,NEW.request_hash,NEW.target_agent_ids,NEW.snapshot,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.room_id,OLD.position,OLD.kind,OLD.author_email,OLD.author_name,OLD.author_role,OLD.reply_to_id,OLD.source_message_id,OLD.request_key,OLD.request_hash,OLD.target_agent_ids,OLD.snapshot,OLD.created_at)
 OR OLD.kind='user' AND NEW.content IS DISTINCT FROM OLD.content
 OR OLD.kind='agent' AND OLD.status='done' AND ROW(NEW.content,NEW.status,NEW.usage,NEW.generation) IS DISTINCT FROM ROW(OLD.content,OLD.status,OLD.usage,OLD.generation)
 THEN RAISE EXCEPTION 'Project chat message attribution is immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE FUNCTION neurocenter_project_chat_room_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF ROW(NEW.project_id,NEW.id,NEW.visibility,NEW.creator_email,NEW.created_at,NEW.create_request_key,NEW.create_request_hash)
 IS DISTINCT FROM ROW(OLD.project_id,OLD.id,OLD.visibility,OLD.creator_email,OLD.created_at,OLD.create_request_key,OLD.create_request_hash)
 THEN RAISE EXCEPTION 'Project chat room audience and attribution are immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER project_chat_room_immutable BEFORE UPDATE ON project_chat_rooms FOR EACH ROW EXECUTE FUNCTION neurocenter_project_chat_room_immutable();
`;
