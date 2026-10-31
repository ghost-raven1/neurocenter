import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface CatalogMigration {
    version: number;
    name: string;
    sql: string;
}
export interface MigrationRow {
    version: number;
    name: string;
    checksum: string;
}
export const migrationChecksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

/** Validate all history before feature DDL; only the old missing baseline is adoptable. */
export function validateMigrationHistory(migrations: readonly CatalogMigration[], rows: readonly MigrationRow[]): void {
    const first = migrations[0]?.version;
    if (
        migrations.some(
            (item, index) =>
                !Number.isSafeInteger(item.version) || item.version < 0 || item.version !== (first ?? 0) + index,
        ) ||
        (migrations.length > 0 && first !== 0 && first !== 1)
    ) {
        throw new Error('Миграции каталога должны иметь последовательные номера, начиная с 0 или 1.');
    }
    const adopted = first === 0 && rows[0]?.version === 1;
    if (adopted && rows[rows.length - 1].version > 5)
        throw new Error('История миграций не содержит обязательный baseline.');
    const expected = migrations.slice(adopted ? 1 : 0);
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index],
            migration = expected[index];
        if (
            !migration ||
            row.version !== migration.version ||
            row.name !== migration.name ||
            row.checksum !== migrationChecksum(migration.sql)
        ) {
            throw new Error(
                'История миграций не совпадает с этой сборкой. Запуск остановлен; автоматический откат схемы запрещён.',
            );
        }
    }
}

/** Read-only preflight neither creates a ledger nor treats pending migrations as readiness. */
export async function catalogMigrationHistory(
    pool: Pick<Pool, 'query'>,
    migrations: readonly CatalogMigration[],
): Promise<{ applied: number[]; pending: number[] }> {
    const exists = (await pool.query("SELECT to_regclass('catalog_schema_migrations') AS name")).rows[0]?.name;
    const rows: MigrationRow[] = exists
        ? (
              await pool.query<MigrationRow>(
                  'SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version',
              )
          ).rows
        : [];
    validateMigrationHistory(migrations, rows);
    const applied = rows.map((row) => row.version);
    return {
        applied,
        pending: migrations.filter((item) => !applied.includes(item.version)).map((item) => item.version),
    };
}

/** One transaction fences baseline adoption, historical migrations and final verification. */
export async function migrateCatalog(pool: Pool, migrations: readonly CatalogMigration[]): Promise<void> {
    validateMigrationHistory(migrations, []);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:catalog:migrations',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS catalog_schema_migrations (
            version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
        const { rows } = await client.query<MigrationRow>(
            'SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version',
        );
        validateMigrationHistory(migrations, rows);
        const applied = new Set(rows.map((row) => row.version));
        for (const migration of migrations) {
            if (applied.has(migration.version)) continue;
            await client.query(migration.sql);
            await client.query('INSERT INTO catalog_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [
                migration.version,
                migration.name,
                migrationChecksum(migration.sql),
            ]);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}
