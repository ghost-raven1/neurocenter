/** Immutable schema 1; later changes belong in a new numbered migration. */
export const FEATURE_FLAGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS security_events (
    event_id UUID PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
    resource_id TEXT NOT NULL, before_state JSONB, after_state JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_created ON security_events(created_at DESC);
CREATE TABLE IF NOT EXISTS feature_flags (
    flag_key TEXT PRIMARY KEY, overrides JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(overrides)='object'),
    revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT NOT NULL DEFAULT 'system:defaults'
);`;

export const FEATURE_FLAGS_COLUMNS = {
    security_events: {
        event_id: ['uuid', true], actor: ['text', true], action: ['text', true], resource_id: ['text', true],
        before_state: ['jsonb', false], after_state: ['jsonb', false], created_at: ['timestamp with time zone', true],
    },
    feature_flags: {
        flag_key: ['text', true], overrides: ['jsonb', true], revision: ['bigint', true],
        updated_at: ['timestamp with time zone', true], updated_by: ['text', true],
    },
    feature_flags_schema_migrations: {
        version: ['integer', true], name: ['text', true], checksum: ['text', true], applied_at: ['timestamp with time zone', true],
    },
} as const;

export const FEATURE_FLAGS_DEFAULTS: Record<string, Record<string, string>> = {
    security_events: {created_at: 'now()'},
    feature_flags: {overrides: "'{}'::jsonb", revision: '1', updated_at: 'now()', updated_by: "'system:defaults'::text"},
    feature_flags_schema_migrations: {applied_at: 'now()'},
};
