import type { Pool } from 'pg';
import { CATALOG_MIGRATIONS } from './catalog-migrations';
import { catalogMigrationHistory, migrateCatalog } from './migrations';
import { assertCurrentCatalogSchema } from './current-schema-verification';

/** Call at an owning service/CLI boundary, never from inside a borrowed transaction. */
export async function ensureCatalogSchema(pool: Pool): Promise<void> {
    await migrateCatalog(pool, CATALOG_MIGRATIONS);
    await assertCurrentCatalogSchema(pool);
}

/** Serialize read-only readiness with the same lock as migration writers. */
export async function checkCatalogSchema(pool: Pool, requireReady = false) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:catalog:migrations',0))");
        const history = await catalogMigrationHistory(client, CATALOG_MIGRATIONS);
        const existingSchema = (
            await client.query<{ present: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace(current_schema())
                AND relkind IN ('r','p') AND relname<>'catalog_schema_migrations') AS present`)
        ).rows[0].present;
        if (requireReady && history.pending.length) throw new Error('Сначала примените миграции каталога.');
        if (!history.pending.length) await assertCurrentCatalogSchema(client);
        await client.query('COMMIT');
        return { ok: true as const, ready: history.pending.length === 0, existingSchema, ...history };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}
