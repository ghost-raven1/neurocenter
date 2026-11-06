import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { FEATURE_FLAGS_COLUMNS, FEATURE_FLAGS_DEFAULTS } from './feature-flags-schema';

/**
 * Замороженная история миграции v1 — не изменять побайтово: её checksum
 * зафиксирован в ledger'ах (feature_flags_schema_migrations) существующих БД,
 * история неизменяема (AD-D1). Новые изменения — только новыми нумерованными
 * миграциями; чужие таблицы (security_events) в них не включать.
 */
const FROZEN_V1_SCHEMA_SQL = `
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

export const FEATURE_FLAGS_MIGRATIONS = [
    { version: 1, name: 'versioned-feature-flags', sql: FROZEN_V1_SCHEMA_SQL },
] as const;
/** Лок-граница AD-D1: feature-flags использует собственный миграционный лок, лок каталога не делится. */
const lock = "SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:feature-flags:migrations',0))";
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
export const featureFlagsMigrationManifest = () =>
    FEATURE_FLAGS_MIGRATIONS.map(({ version, name, sql }) => ({ version, name, checksum: checksum(sql) }));
interface IMigrationRow {
    version: number;
    name: string;
    checksum: string;
}
export interface IFeatureFlagsMigrationState {
    ok: true;
    ready: boolean;
    applied: number[];
    pending: number[];
}

/** Лок-граница AD-D1: у feature-flags собственный миграционный лок, журнал security_events принадлежит каталогу. */
async function history(client: PoolClient): Promise<IMigrationRow[]> {
    if (!(await client.query("SELECT to_regclass('feature_flags_schema_migrations') AS relation")).rows[0]?.relation)
        return [];
    const rows = (
        await client.query<IMigrationRow>(
            'SELECT version,name,checksum FROM feature_flags_schema_migrations ORDER BY version',
        )
    ).rows;
    const expected = featureFlagsMigrationManifest();
    if (
        rows.some(
            (row, index) =>
                !expected[index] ||
                Object.keys(expected[index]).some(
                    (key) => row[key as keyof IMigrationRow] !== expected[index][key as keyof IMigrationRow],
                ),
        )
    ) {
        throw new Error('История миграций переключателей не совпадает с этой сборкой.');
    }
    return rows;
}

/** A checksum is recorded only after adopting a structurally compatible existing schema. */
export async function assertFeatureFlagsSchema(client: PoolClient): Promise<void> {
    for (const [table, columns] of Object.entries(FEATURE_FLAGS_COLUMNS)) {
        const actual = (
            await client.query<{ name: string; type: string; required: boolean; default_value: string | null }>(
                `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
             pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a
             LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
             WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped`,
                [table],
            )
        ).rows;
        for (const [name, [type, required]] of Object.entries(columns)) {
            const column = actual.find((item) => item.name === name);
            if (!column || column.type !== type || column.required !== required)
                throw new Error('Схема переключателей не соответствует миграции: ' + table + '.' + name);
            const expectedDefault = FEATURE_FLAGS_DEFAULTS[table][name];
            if (expectedDefault !== undefined && column.default_value !== expectedDefault)
                throw new Error('Некорректный default переключателей: ' + table + '.' + name);
        }
        const key = table === 'feature_flags' ? 'flag_key' : 'version';
        const primary = (
            await client.query<{ definition: string }>(
                "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='p'",
                [table],
            )
        ).rows[0];
        if (primary?.definition !== 'PRIMARY KEY (' + key + ')')
            throw new Error('Некорректный первичный ключ: ' + table);
    }
    const checks = (
        await client.query<{ definition: string }>(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='feature_flags'::regclass AND contype='c' AND convalidated",
        )
    ).rows.map((row) => row.definition);
    if (
        !checks.includes("CHECK ((jsonb_typeof(overrides) = 'object'::text))") ||
        !checks.includes('CHECK ((revision > 0))')
    )
        throw new Error('Отсутствуют ограничения переключателей.');
}

const state = (rows: IMigrationRow[]): IFeatureFlagsMigrationState => ({
    ok: true,
    ready: rows.length === FEATURE_FLAGS_MIGRATIONS.length,
    applied: rows.map((row) => row.version),
    pending: FEATURE_FLAGS_MIGRATIONS.slice(rows.length).map((row) => row.version),
});

/** No CREATE, ALTER, INSERT or default seeding is allowed in the preflight path. */
export async function checkFeatureFlagsMigrations(
    pool: Pool,
    requireReady = false,
): Promise<IFeatureFlagsMigrationState> {
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query('BEGIN READ ONLY');
        await client.query(lock);
        const result = state(await history(client));
        if (result.ready) await assertFeatureFlagsSchema(client);
        if (requireReady && !result.ready) throw new Error('Миграции переключателей ещё не применены.');
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {
            discard = true;
        });
        throw error;
    } finally {
        if (discard) client.release(true);
        else client.release();
    }
}

/** Schema creation, physical checks and immutable history commit atomically. */
export async function migrateFeatureFlags(pool: Pool): Promise<IFeatureFlagsMigrationState> {
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query('BEGIN');
        await client.query(lock);
        await client.query(`CREATE TABLE IF NOT EXISTS feature_flags_schema_migrations (
            version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const rows = await history(client);
        for (const migration of FEATURE_FLAGS_MIGRATIONS.slice(rows.length)) {
            await client.query(migration.sql);
            await assertFeatureFlagsSchema(client);
            await client.query('INSERT INTO feature_flags_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [
                migration.version,
                migration.name,
                checksum(migration.sql),
            ]);
        }
        await assertFeatureFlagsSchema(client);
        const result = state(await history(client));
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {
            discard = true;
        });
        throw error;
    } finally {
        if (discard) client.release(true);
        else client.release();
    }
}
