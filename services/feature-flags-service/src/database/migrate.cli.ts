import { Pool } from 'pg';
import { checkFeatureFlagsMigrations, featureFlagsMigrationManifest, migrateFeatureFlags } from './migrations';

/** manifest is intentionally offline and does not load production secrets. */
async function main(): Promise<void> {
    const [mode, option, ...extra] = process.argv.slice(2);
    if (
        !['manifest', 'check', 'migrate'].includes(mode) ||
        extra.length ||
        (option && !(mode === 'check' && option === '--ready'))
    ) {
        throw new Error('Команды: manifest | check [--ready] | migrate');
    }
    if (mode === 'manifest') {
        console.log(JSON.stringify(featureFlagsMigrationManifest()));
        return;
    }
    require('../../../shared/runtime.cjs');
    const pool = new Pool({
        connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 60000,
        application_name: 'neurocenter:flags-migrations',
    });
    try {
        console.log(
            JSON.stringify(
                mode === 'migrate'
                    ? await migrateFeatureFlags(pool)
                    : await checkFeatureFlagsMigrations(pool, option === '--ready'),
            ),
        );
    } finally {
        await pool.end();
    }
}
void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Миграции переключателей не завершены.');
    process.exitCode = 1;
});
