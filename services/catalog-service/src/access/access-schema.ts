/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const ACCESS_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS security_events (
        event_id UUID PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
        resource_id TEXT NOT NULL, before_state JSONB, after_state JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    ); CREATE INDEX IF NOT EXISTS security_events_created ON security_events(created_at DESC);
CREATE TABLE IF NOT EXISTS platform_users (
            email TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '',
            is_main_admin BOOLEAN NOT NULL DEFAULT false, enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
CREATE TABLE IF NOT EXISTS platform_bootstrap (
            key TEXT PRIMARY KEY, principal TEXT NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT now())
`;
