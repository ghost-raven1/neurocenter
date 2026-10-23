/** Migration-owned journal; its primary key prevents hidden paid retries after restart. */
export const PACKAGE_AGENT_SCHEMA_SQL=`
CREATE TABLE tool_build_agent_steps (
 build_id uuid NOT NULL REFERENCES tool_build_jobs(id) ON DELETE CASCADE,
 execution_nonce uuid NOT NULL,
 attempt smallint NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 stage text NOT NULL CHECK(stage IN ('propose','review')),
 state text NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','FAILED')),
 model_id text NOT NULL,
 model_pin text NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 recipe jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(recipe)='object' AND octet_length(recipe::text)<=2048),
 diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(diagnostics)='object' AND octet_length(diagnostics::text)<=2048),
 error_code text CHECK(error_code IS NULL OR error_code IN ('inference-failed','invalid-response')),
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 PRIMARY KEY(build_id,attempt,stage)
);
`;

/** Common runtime evidence is retained on the same build, separately from model planning. */
export const PACKAGE_BUILD_RUNTIME_SCHEMA_SQL=`
CREATE TABLE tool_build_runtime_checks (
 build_id uuid NOT NULL REFERENCES tool_build_jobs(id) ON DELETE CASCADE,
 attempt smallint NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 execution_nonce uuid NOT NULL,
 report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND report @> '{"schemaVersion":1}'::jsonb AND octet_length(report::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(build_id,attempt)
);
`;
