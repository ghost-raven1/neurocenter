/** Shared rooms never select or expose private model-chat conversations. */
export const PROJECT_CHAT_SCHEMA_SQL = `
CREATE TABLE project_chat_rooms (
 project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 agent_ids text[] NOT NULL DEFAULT '{}' CHECK(cardinality(agent_ids)<=8),
 model_id text,model_pin text CHECK(model_pin~'^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((model_id IS NULL)=(model_pin IS NULL)),CHECK(cardinality(agent_ids)=0 OR model_id IS NOT NULL)
);
CREATE TABLE project_chat_messages (
 id uuid PRIMARY KEY,project_id text NOT NULL REFERENCES project_chat_rooms(project_id) ON DELETE CASCADE,
 position bigint GENERATED ALWAYS AS IDENTITY,kind text NOT NULL CHECK(kind IN ('user','agent','summary')),
 content text NOT NULL DEFAULT '' CHECK(octet_length(content)<=8388608),
 author_email text,author_name text,author_role text,reply_to_id uuid,source_message_id uuid,
 status text NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
 request_key uuid,request_hash text CHECK(request_hash~'^[a-f0-9]{64}$'),target_agent_ids text[] NOT NULL DEFAULT '{}' CHECK(cardinality(target_agent_ids)<=8),
 snapshot jsonb CHECK(snapshot IS NULL OR jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144),
 generation uuid NOT NULL,lease_until timestamptz,error text,usage jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,id),UNIQUE(project_id,author_email,request_key),
 FOREIGN KEY(project_id,reply_to_id) REFERENCES project_chat_messages(project_id,id),
 FOREIGN KEY(project_id,source_message_id) REFERENCES project_chat_messages(project_id,id),
 CHECK((kind='user' AND author_email IS NOT NULL AND author_name IS NOT NULL AND author_role IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND source_message_id IS NULL AND snapshot IS NULL AND octet_length(content) BETWEEN 1 AND 131072)
 OR (kind IN ('agent','summary') AND author_email IS NULL AND author_name IS NULL AND author_role IS NULL AND request_key IS NULL AND request_hash IS NULL AND source_message_id IS NOT NULL AND (kind='agent')=(snapshot IS NOT NULL))),
 CHECK((status='running')=(lease_until IS NOT NULL)),CHECK(kind<>'agent' OR status<>'done' OR length(content)>0)
);
CREATE INDEX project_chat_history ON project_chat_messages(project_id,position DESC);
CREATE INDEX project_chat_queue ON project_chat_messages(project_id,position) WHERE kind='user' AND status='queued';
CREATE UNIQUE INDEX project_chat_single_running ON project_chat_messages(project_id) WHERE kind='user' AND status='running';
CREATE UNIQUE INDEX project_chat_agent_slot ON project_chat_messages(source_message_id,(snapshot->>'agentId')) WHERE kind='agent';
CREATE UNIQUE INDEX project_chat_summary_slot ON project_chat_messages(source_message_id) WHERE kind='summary';
CREATE TABLE project_chat_retry_requests (
 project_id text NOT NULL REFERENCES project_chat_rooms(project_id) ON DELETE CASCADE,
 actor_email text NOT NULL,request_key uuid NOT NULL,message_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,actor_email,request_key),
 FOREIGN KEY(project_id,message_id) REFERENCES project_chat_messages(project_id,id)
);
CREATE FUNCTION neurocenter_project_chat_message_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF ROW(NEW.id,NEW.project_id,NEW.position,NEW.kind,NEW.author_email,NEW.author_name,NEW.author_role,NEW.reply_to_id,NEW.source_message_id,NEW.request_key,NEW.request_hash,NEW.target_agent_ids,NEW.snapshot,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.position,OLD.kind,OLD.author_email,OLD.author_name,OLD.author_role,OLD.reply_to_id,OLD.source_message_id,OLD.request_key,OLD.request_hash,OLD.target_agent_ids,OLD.snapshot,OLD.created_at)
 OR OLD.kind='user' AND NEW.content IS DISTINCT FROM OLD.content
 OR OLD.kind='agent' AND OLD.status='done' AND ROW(NEW.content,NEW.status,NEW.usage,NEW.generation) IS DISTINCT FROM ROW(OLD.content,OLD.status,OLD.usage,OLD.generation)
 THEN RAISE EXCEPTION 'Project chat message attribution is immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER project_chat_message_immutable BEFORE UPDATE ON project_chat_messages FOR EACH ROW EXECUTE FUNCTION neurocenter_project_chat_message_immutable();
`;
