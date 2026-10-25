/** Migration40 adds immutable metadata only; original conversations/rooms have no cascading link. */
export const CHAT_SYSTEM_ROLE_SCHEMA_SQL = `
CREATE TABLE chat_system_role_origins (
 dialog_id uuid PRIMARY KEY,owner_email text NOT NULL,origin_kind text NOT NULL CHECK(origin_kind IN ('model-chat','project-chat')),
 origin_id uuid NOT NULL,project_id text,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(origin_kind<>'project-chat' OR project_id IS NOT NULL),
 FOREIGN KEY(dialog_id,owner_email) REFERENCES system_role_dialogs(id,owner_email) ON DELETE CASCADE,
 UNIQUE NULLS NOT DISTINCT(owner_email,origin_kind,origin_id,project_id)
);
CREATE FUNCTION chat_system_role_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $origin$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Chat system role origin is immutable'; END IF;
 RETURN NEW;
END $origin$;
CREATE TRIGGER chat_system_role_origin_guard BEFORE UPDATE ON chat_system_role_origins FOR EACH ROW EXECUTE FUNCTION chat_system_role_origin_guard();
`;
