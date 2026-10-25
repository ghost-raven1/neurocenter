/** Migration 39 owns revisions/tombstones independently of the chat writer and never copies message text. */
export const CHAT_SEARCH_SCHEMA_SQL=`
CREATE TABLE chat_search_revisions (
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,message_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),tombstone boolean NOT NULL DEFAULT false,
 PRIMARY KEY(project_id,message_id)
);
INSERT INTO chat_search_revisions(project_id,message_id) SELECT project_id,id FROM project_chat_messages;
CREATE TABLE chat_search_vectors (
 project_id text NOT NULL,message_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 model_id text NOT NULL,model_pin text NOT NULL CHECK(model_pin~'^[a-f0-9]{64}$'),dimension integer NOT NULL CHECK(dimension BETWEEN 1 AND 16000),
 chunk_index integer NOT NULL CHECK(chunk_index>=0),embedding double precision[] NOT NULL,indexed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,message_id,model_id,model_pin,chunk_index),
 FOREIGN KEY(project_id,message_id) REFERENCES project_chat_messages(project_id,id) ON DELETE CASCADE,
 CHECK(cardinality(embedding)=dimension AND array_ndims(embedding)=1 AND array_lower(embedding,1)=1)
);
CREATE INDEX chat_search_vector_profile ON chat_search_vectors(project_id,model_id,model_pin,message_id,chunk_index);
CREATE FUNCTION neurocenter_chat_search_revision() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.content,NEW.status,NEW.generation,NEW.room_id) IS NOT DISTINCT FROM ROW(OLD.content,OLD.status,OLD.generation,OLD.room_id) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN RETURN OLD; END IF;
  INSERT INTO chat_search_revisions(project_id,message_id,revision,tombstone) VALUES(OLD.project_id,OLD.id,1,true)
   ON CONFLICT(project_id,message_id) DO UPDATE SET revision=chat_search_revisions.revision+1,tombstone=true;
  RETURN OLD;
 END IF;
 INSERT INTO chat_search_revisions(project_id,message_id) VALUES(NEW.project_id,NEW.id)
  ON CONFLICT(project_id,message_id) DO UPDATE SET revision=chat_search_revisions.revision+1,tombstone=false;
 DELETE FROM chat_search_vectors WHERE project_id=NEW.project_id AND message_id=NEW.id;
 RETURN NEW;
END $body$;
CREATE TRIGGER chat_search_revision AFTER INSERT OR UPDATE OR DELETE ON project_chat_messages FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_search_revision();
CREATE TABLE chat_search_jobs (
 id uuid PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,actor text NOT NULL,active_role text NOT NULL,
 request_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('index','search')),state text NOT NULL CHECK(state IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
 model_id text NOT NULL,model_pin text NOT NULL CHECK(model_pin~'^[a-f0-9]{64}$'),dimension integer NOT NULL CHECK(dimension BETWEEN 1 AND 16000),
 deadline timestamptz NOT NULL,result jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=32768),error text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(project_id,actor,request_key)
);
CREATE UNIQUE INDEX chat_search_actor_running ON chat_search_jobs(project_id,actor) WHERE state='RUNNING';
`;
