/** Accepted text context is private turn history; its source corpus stays with the RAG owner. */
export const PROJECT_TEXT_CONTEXT_SCHEMA_SQL=`
CREATE TABLE model_chat_text_contexts(
 turn_id uuid PRIMARY KEY REFERENCES model_chat_turns(id) ON DELETE CASCADE,
 project_id text NOT NULL,
 selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='object' AND octet_length(selection::text)<=16384),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT now()
);
`;
