/**
 * FR-309: an agent shares context elements (state/result/decision) with other agents,
 * a user (private dialogue) or the team (public room). Every element carries per-item
 * provenance (which agent + what + version, NFR-4); sharing is gated on the agent's
 * access to the target room and a private dialogue never leaks into a public room.
 */
export const PROJECT_CHAT_SHARED_SCHEMA_SQL = `
CREATE TABLE project_chat_shared_items (
  project_id text NOT NULL,room_id uuid NOT NULL,item_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('state','result','decision')),
  content text NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 8388608),
  ref_message_id uuid,source_room_id uuid NOT NULL,
  source_agent_id text NOT NULL CHECK(length(source_agent_id) BETWEEN 1 AND 200),source_agent_name text,
  source_generation uuid NOT NULL,content_sha text NOT NULL CHECK(content_sha ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,room_id,item_id),
  FOREIGN KEY(project_id,room_id) REFERENCES project_chat_rooms(project_id,id) ON DELETE CASCADE
);
CREATE INDEX project_chat_shared_items_room ON project_chat_shared_items(project_id,room_id,created_at DESC);
CREATE FUNCTION neurocenter_project_chat_shared_item_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF ROW(NEW.project_id,NEW.room_id,NEW.item_id,NEW.kind,NEW.content,NEW.ref_message_id,NEW.source_room_id,NEW.source_agent_id,NEW.source_agent_name,NEW.source_generation,NEW.content_sha,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.project_id,OLD.room_id,OLD.item_id,OLD.kind,OLD.content,OLD.ref_message_id,OLD.source_room_id,OLD.source_agent_id,OLD.source_agent_name,OLD.source_generation,OLD.content_sha,OLD.created_at)
 THEN RAISE EXCEPTION 'Project chat shared context item is immutable'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER project_chat_shared_item_immutable BEFORE UPDATE ON project_chat_shared_items FOR EACH ROW EXECUTE FUNCTION neurocenter_project_chat_shared_item_immutable();
`;
