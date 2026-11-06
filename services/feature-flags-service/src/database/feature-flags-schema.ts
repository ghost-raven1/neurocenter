/** Общий журнал событий не описывается здесь: единый источник DDL — каталог (AD-D1); ff валидирует только свои таблицы. */
export const FEATURE_FLAGS_COLUMNS = {
    feature_flags: {
        flag_key: ['text', true],
        overrides: ['jsonb', true],
        revision: ['bigint', true],
        updated_at: ['timestamp with time zone', true],
        updated_by: ['text', true],
    },
    feature_flags_schema_migrations: {
        version: ['integer', true],
        name: ['text', true],
        checksum: ['text', true],
        applied_at: ['timestamp with time zone', true],
    },
} as const;

export const FEATURE_FLAGS_DEFAULTS: Record<string, Record<string, string>> = {
    feature_flags: {
        overrides: "'{}'::jsonb",
        revision: '1',
        updated_at: 'now()',
        updated_by: "'system:defaults'::text",
    },
    feature_flags_schema_migrations: { applied_at: 'now()' },
};
