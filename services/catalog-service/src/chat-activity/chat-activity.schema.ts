/** Expiring session tombstones reject late heartbeats; receipts survive feature toggles and process restarts. */
export const CHAT_ACTIVITY_SCHEMA_SQL = `
CREATE TABLE chat_presence_sessions (
 email text NOT NULL,session_id uuid NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
 online_until timestamptz,retain_until timestamptz NOT NULL,
 PRIMARY KEY(email,session_id),CHECK(online_until IS NULL OR online_until<=retain_until)
);
CREATE INDEX chat_presence_expiry ON chat_presence_sessions(retain_until);
CREATE TABLE project_chat_typing_sessions (
 email text NOT NULL,session_id uuid NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
 project_id text,room_id uuid,typing_until timestamptz,retain_until timestamptz NOT NULL,
 PRIMARY KEY(email,session_id),
 FOREIGN KEY(project_id,room_id) REFERENCES project_chat_rooms(project_id,id) ON DELETE CASCADE,
 CHECK((project_id IS NULL)=(room_id IS NULL)),
 CHECK(typing_until IS NULL OR project_id IS NOT NULL AND typing_until<=retain_until)
);
CREATE INDEX project_chat_typing_expiry ON project_chat_typing_sessions(retain_until);
CREATE INDEX project_chat_typing_room ON project_chat_typing_sessions(project_id,room_id,typing_until);
CREATE TABLE project_chat_read_receipts (
 project_id text NOT NULL,room_id uuid NOT NULL,message_id uuid NOT NULL,reader_email text NOT NULL,
 viewed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,room_id,message_id,reader_email),
 FOREIGN KEY(project_id,room_id,message_id) REFERENCES project_chat_messages(project_id,room_id,id) ON DELETE CASCADE
);
`;
