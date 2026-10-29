/** Additive migration49; previous accepted text-context SQL and checksums remain immutable. */
export const RUNTIME_LIMITS_SCHEMA_SQL=`
CREATE TABLE runtime_limit_settings(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision integer NOT NULL CHECK(revision>0),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object' AND octet_length(policy::text)<=32768),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE runtime_limit_requests(
 actor text NOT NULL,
 request_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=65536),
 PRIMARY KEY(actor,request_key)
);
ALTER TABLE model_chat_text_contexts DROP CONSTRAINT model_chat_text_contexts_selection_check;
ALTER TABLE model_chat_text_contexts ADD CONSTRAINT model_chat_text_contexts_selection_check CHECK(jsonb_typeof(selection)='object' AND octet_length(selection::text)<=131072);
ALTER TABLE model_chat_text_contexts DROP CONSTRAINT model_chat_text_contexts_evidence_check;
ALTER TABLE model_chat_text_contexts ADD CONSTRAINT model_chat_text_contexts_evidence_check CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=2097152);
`;
