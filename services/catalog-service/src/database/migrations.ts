import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface CatalogMigration { version: number; name: string; sql: string }

/** Новые схемы меняются последовательно, под общей блокировкой и с проверкой неизменности истории. */
export async function migrateCatalog(pool: Pool, migrations: readonly CatalogMigration[]): Promise<void> {
    const versions = migrations.map(migration => migration.version);
    if (versions.some((version, index) => !Number.isSafeInteger(version) || version < 1
        || (index > 0 && version !== versions[index - 1] + 1))
        || (versions.length > 0 && versions[0] !== 1)) {
        throw new Error('Миграции каталога должны иметь последовательные номера, начиная с 1.');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:catalog:migrations',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS catalog_schema_migrations (
            version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now())`);
        const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
            'SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version',
        );
        for (let index = 0; index < rows.length; index++) {
            const applied = rows[index];
            const migration = migrations[index];
            if (!migration || applied.version !== migration.version || applied.name !== migration.name
                || applied.checksum !== checksum(migration.sql)) {
                throw new Error('История миграций не совпадает с этой сборкой. Запуск остановлен; автоматический откат схемы запрещён.');
            }
        }
        for (const migration of migrations.slice(rows.length)) {
            await client.query(migration.sql);
            await client.query('INSERT INTO catalog_schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
                [migration.version, migration.name, checksum(migration.sql)]);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally { client.release(); }
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');
