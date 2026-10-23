/** Dispatch history survives policy changes; a larger window can account for earlier calls. */
export const MODEL_RATE_LIMITS_SCHEMA_SQL = `
CREATE TABLE model_api_rate_limits (
 model_id text PRIMARY KEY REFERENCES model_catalog(id) ON DELETE CASCADE,
 revision bigint NOT NULL CHECK(revision>0),
 requests integer NOT NULL CHECK(requests BETWEEN 1 AND 1000),
 window_ms integer NOT NULL CHECK(window_ms BETWEEN 1000 AND 86400000),
 enabled boolean NOT NULL,updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_api_dispatch_slots (
 id uuid PRIMARY KEY,model_id text NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE,
 dispatched_at timestamptz NOT NULL
);
CREATE INDEX model_api_dispatch_slots_model_time ON model_api_dispatch_slots(model_id,dispatched_at DESC);
`;
