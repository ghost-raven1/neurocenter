/** Private conversations and bounded documents are committed together with the catalog backup. */
export const CHAT_SCHEMA_SQL = `
CREATE TABLE model_chat_conversations (
 id uuid PRIMARY KEY, owner_email text NOT NULL, model_id text NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
 project_id text REFERENCES projects(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 128),
 model_pin text NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_chat_owner_scope ON model_chat_conversations(owner_email,model_id,project_id,updated_at DESC);
CREATE TABLE model_chat_turns (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES model_chat_conversations(id) ON DELETE CASCADE,
 position bigint GENERATED ALWAYS AS IDENTITY, request_id uuid NOT NULL, request_ids uuid[] NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), prompt text NOT NULL CHECK(octet_length(prompt)<=131072),
 attachment_ids uuid[] NOT NULL CHECK(cardinality(attachment_ids)<=5), input_text text NOT NULL CHECK(octet_length(input_text)<=131072),
 status text NOT NULL CHECK(status IN ('pending','done','failed','cancelled')), answer jsonb, error text,
 lease_until timestamptz, removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,request_id), CHECK(cardinality(request_ids) BETWEEN 1 AND 100),
 CHECK((status='done' AND answer IS NOT NULL AND jsonb_typeof(answer)='object') OR (status<>'done' AND answer IS NULL)),
 CHECK((status='pending' AND lease_until IS NOT NULL) OR (status<>'pending' AND lease_until IS NULL))
);
CREATE UNIQUE INDEX model_chat_single_pending ON model_chat_turns(conversation_id) WHERE status='pending' AND removed_at IS NULL;
CREATE INDEX model_chat_turn_order ON model_chat_turns(conversation_id,position);
CREATE TABLE model_chat_attachments (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES model_chat_conversations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
 media_type text NOT NULL, bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760), content bytea,
 text text NOT NULL CHECK(octet_length(text)<=102400), text_bytes integer NOT NULL CHECK(text_bytes=octet_length(text)),
 pages integer CHECK(pages>0), warning text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 UNIQUE(conversation_id,request_id), CHECK((deleted_at IS NULL AND content IS NOT NULL AND octet_length(content)=bytes) OR (deleted_at IS NOT NULL AND content IS NULL))
);
CREATE INDEX model_chat_attachment_scope ON model_chat_attachments(conversation_id,created_at);
`;
