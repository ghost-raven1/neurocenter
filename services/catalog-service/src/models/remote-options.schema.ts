/** Generation defaults and transport timeout stay in private, versioned server connections. */
export const REMOTE_OPTIONS_SCHEMA_SQL = `
ALTER TABLE model_remote_connections ADD COLUMN options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(options)='object');
ALTER TABLE model_remote_connections ADD COLUMN timeout_ms integer NOT NULL DEFAULT 90000 CHECK(timeout_ms BETWEEN 1000 AND 300000);
`;
