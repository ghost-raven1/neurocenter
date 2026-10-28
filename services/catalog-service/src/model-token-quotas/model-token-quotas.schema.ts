/** Version-neutral additive SQL; ROOT owns contiguous migration registration and reset classification. */
export const MODEL_TOKEN_QUOTAS_SCHEMA_SQL = `
CREATE TABLE model_user_token_quotas (
 model_id text NOT NULL,user_email text NOT NULL,revision bigint NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
 enabled boolean NOT NULL,token_limit bigint NOT NULL CHECK(token_limit>0 AND token_limit<=9007199254740991),
 period_ms bigint NOT NULL DEFAULT 86400000 CHECK(period_ms>0 AND period_ms<=31536000000),
 accounting_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_by text NOT NULL,
 PRIMARY KEY(model_id,user_email),CHECK(user_email=lower(user_email))
);
CREATE TABLE model_user_token_quota_requests (
 writer_email text NOT NULL,request_key uuid NOT NULL,model_id text NOT NULL,user_email text NOT NULL,
 request_fingerprint text NOT NULL CHECK(request_fingerprint~'^[a-f0-9]{64}$'),receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(writer_email,request_key)
);
ALTER TABLE model_usage_calls
 ADD COLUMN quota_state text CHECK(quota_state IN ('reserved','dispatched','settled','unknown','released')),
 ADD COLUMN quota_reserved_tokens bigint CHECK(quota_reserved_tokens>=0),
 ADD COLUMN quota_debit_tokens bigint CHECK(quota_debit_tokens>=0),
 ADD COLUMN quota_admitted_at timestamptz,
 ADD COLUMN quota_metadata jsonb,
 ADD COLUMN quota_settlement_digest text CHECK(quota_settlement_digest~'^[a-f0-9]{64}$');
ALTER TABLE model_usage_calls ADD CONSTRAINT model_usage_quota_shape CHECK (
 (quota_state IS NULL AND quota_reserved_tokens IS NULL AND quota_debit_tokens IS NULL AND quota_admitted_at IS NULL AND quota_metadata IS NULL AND quota_settlement_digest IS NULL)
 OR (quota_state IS NOT NULL AND quota_reserved_tokens IS NOT NULL AND quota_debit_tokens IS NOT NULL AND quota_admitted_at IS NOT NULL AND quota_metadata IS NOT NULL AND jsonb_typeof(quota_metadata)='object'
 AND ((quota_state IN ('reserved','dispatched') AND quota_debit_tokens=0 AND quota_settlement_digest IS NULL)
 OR (quota_state IN ('settled','unknown','released') AND quota_reserved_tokens=0))));
CREATE INDEX model_usage_calls_quota_pair ON model_usage_calls(actor_email,model_id,quota_admitted_at DESC);
CREATE INDEX model_usage_calls_quota_unsettled ON model_usage_calls(actor_email,model_id) WHERE quota_state IN ('reserved','dispatched','unknown');
`;
