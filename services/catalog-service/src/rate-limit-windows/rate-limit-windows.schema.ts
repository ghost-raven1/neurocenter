/**
 * Shared pairing rate-limit windows (entry 9, AD-6): счётчики device-channel pairing
 * (pair-start / pair-poll / pair-poll-code) — общие для всех реплик gateway.
 * Version-neutral additive SQL; ROOT owns contiguous migration registration and reset classification.
 */
export const RATE_LIMIT_WINDOWS_SCHEMA_SQL = `
CREATE TABLE rate_limit_windows (
 scope text NOT NULL,
 key text NOT NULL,
 window_start timestamptz NOT NULL,
 count integer NOT NULL DEFAULT 1 CHECK(count>0),
 PRIMARY KEY(scope,key,window_start)
);
CREATE INDEX rate_limit_windows_window_start_idx ON rate_limit_windows (window_start);
`;
