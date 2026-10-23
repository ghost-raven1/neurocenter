/** Nullable history stays unknown; new observations record actual transport starts separately from attempts. */
export const MODEL_USAGE_DETAILS_SCHEMA_SQL = `
ALTER TABLE model_usage_calls
 ADD COLUMN dispatch_count integer CHECK(dispatch_count>=0),
 ADD COLUMN dispatched_at timestamptz,
 ADD COLUMN rate_wait_ms bigint CHECK(rate_wait_ms>=0),
 ADD COLUMN provider_latency_ms bigint CHECK(provider_latency_ms>=0),
 ADD COLUMN failure_code text CHECK(failure_code IN ('cancelled','rate_wait_timeout','rate_store_unavailable','permission_denied','feature_disabled','provider_error','internal_error'));
CREATE INDEX model_usage_calls_endpoint_time ON model_usage_calls(endpoint,started_at DESC,id DESC);
`;
