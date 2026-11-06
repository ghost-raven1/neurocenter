import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ownedTestPostgresAdmin } from './owned-postgres.fixture.mjs';

const adminConnection = ownedTestPostgresAdmin(process.env.TEST_ADMIN_PG_URL).href;

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
require('ts-node').register({
    transpileOnly: true,
    project: fileURLToPath(new URL('../../services/catalog-service/tsconfig.json', import.meta.url)),
});
const { Pool } = require('pg');
const { migrateCatalog } = require('./src/database/migrations.ts');
const { CATALOG_MIGRATIONS } = require('./src/database/catalog-migrations.ts');
const { ensureCatalogSchema } = require('./src/database/catalog-schema.ts');
const {
    migrateFeatureFlags,
    checkFeatureFlagsMigrations,
    featureFlagsMigrationManifest,
} = require('../../services/feature-flags-service/src/database/migrations.ts');

/** Regression-гейт: checksum замороженной v1-миграции в ledger'ах существующих БД (AD-D1). */
const FROZEN_V1_CHECKSUM = '7324275e1a3ca4dd3299f9288b48b8dd8a7a1cdca2ec82d4647a2f062751014d';
const FF_LOCK_KEY = 'neurocenter:feature-flags:migrations';
const CATALOG_LOCK_KEY = 'neurocenter:catalog:migrations';
const prefix = 'nc_schema_locks_ddl_' + process.pid;
const admin = new Pool({ connectionString: adminConnection });
const pools = [admin];
const databases = [];
const scratch = async (name) => {
    await admin.query('CREATE DATABASE ' + name);
    databases.push(name);
    const url = new URL(adminConnection);
    url.pathname = '/' + name;
    const pool = new Pool({ connectionString: url.href, max: 4 });
    pools.push(pool);
    return { pool, url: url.href };
};
const cases = [];
const check = async (name, action) => {
    await action();
    cases.push({ name, passed: true });
};
try {
    const db1 = await scratch(prefix + '_invariant_' + process.pid);
    await check('fresh: security_events каталога — ровно контракт DDL, PK и индекс', async () => {
        await ensureCatalogSchema(db1.pool);
        const migrated = await migrateFeatureFlags(db1.pool);
        assert.equal(migrated.ready, true);
        const columns = (
            await db1.pool.query(
                `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required
                 FROM pg_attribute a WHERE a.attrelid='security_events'::regclass AND a.attnum>0 AND NOT a.attisdropped
                 ORDER BY a.attnum`,
            )
        ).rows;
        assert.deepEqual(columns, [
            { name: 'event_id', type: 'uuid', required: true },
            { name: 'actor', type: 'text', required: true },
            { name: 'action', type: 'text', required: true },
            { name: 'resource_id', type: 'text', required: true },
            { name: 'before_state', type: 'jsonb', required: false },
            { name: 'after_state', type: 'jsonb', required: false },
            { name: 'created_at', type: 'timestamp with time zone', required: true },
        ]);
        const primary = (
            await db1.pool.query(
                "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='security_events'::regclass AND contype='p'",
            )
        ).rows[0];
        assert.equal(primary?.definition, 'PRIMARY KEY (event_id)');
        const index = (
            await db1.pool.query(
                `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS is_unique,pg_get_indexdef(i.indexrelid) AS definition
                 FROM pg_index i WHERE i.indexrelid=to_regclass('security_events_created') AND i.indrelid='security_events'::regclass`,
            )
        ).rows[0];
        assert.ok(index, 'Индекс security_events_created отсутствует');
        assert.equal(index.valid, true);
        assert.equal(index.ready, true);
        assert.equal(index.is_unique, false);
        assert.ok(index.definition.endsWith(' USING btree (created_at DESC)'), index.definition);
        assert.equal(
            (await db1.pool.query("SELECT to_regclass('feature_flags') AS name")).rows[0].name,
            'feature_flags',
        );
        assert.equal(
            (await db1.pool.query("SELECT to_regclass('feature_flags_schema_migrations') AS name")).rows[0].name,
            'feature_flags_schema_migrations',
        );
    });
    await check('существующая история v1 (замороженный checksum): migrate — no-op, ready', async () => {
        const before = (await db1.pool.query('SELECT * FROM feature_flags_schema_migrations ORDER BY version')).rows;
        assert.equal(before.length, 1);
        assert.equal(before[0].version, 1);
        assert.equal(before[0].checksum, FROZEN_V1_CHECKSUM);
        assert.deepEqual(await migrateFeatureFlags(db1.pool), { ok: true, ready: true, applied: [1], pending: [] });
        assert.deepEqual(
            (await db1.pool.query('SELECT * FROM feature_flags_schema_migrations ORDER BY version')).rows,
            before,
        );
        assert.deepEqual(await checkFeatureFlagsMigrations(db1.pool, true), {
            ok: true,
            ready: true,
            applied: [1],
            pending: [],
        });
        assert.equal(featureFlagsMigrationManifest()[0].checksum, FROZEN_V1_CHECKSUM);
    });
    const db2 = await scratch(prefix + '_locks_' + process.pid);
    await check('ключи миграционных локов feature-flags и каталога различаются', async () => {
        const row = (
            await db2.pool.query('SELECT hashtextextended($1,0) AS ff,hashtextextended($2,0) AS catalog', [
                FF_LOCK_KEY,
                CATALOG_LOCK_KEY,
            ])
        ).rows[0];
        assert.notEqual(row.ff, row.catalog);
    });
    for (const [holderKey, name, migrate] of [
        [
            FF_LOCK_KEY,
            'удерживаемый ff-лок не блокирует миграцию каталога',
            async (pool) => migrateCatalog(pool, CATALOG_MIGRATIONS),
        ],
        [
            CATALOG_LOCK_KEY,
            'удерживаемый лок каталога не блокирует миграцию feature-flags',
            async (pool) => migrateFeatureFlags(pool),
        ],
    ])
        await check(name, async () => {
            const holder = await db2.pool.connect();
            try {
                await holder.query('BEGIN');
                await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [holderKey]);
                const racing = new Pool({ connectionString: db2.url, max: 1, lock_timeout: 2000 });
                pools.push(racing);
                // Миграция другого сервиса идёт из сессии с lock_timeout: при возврате общего лока
                // конфликт проявляется как lock_timeout, а не как бесконечное ожидание.
                await migrate(racing);
                await racing.end();
            } finally {
                await holder.query('ROLLBACK').catch(() => undefined);
                holder.release();
            }
        });
    const result = {
        checkedAt: new Date().toISOString(),
        isolatedDatabases: databases,
        cases,
        passed: cases.length,
    };
    console.log(JSON.stringify(result));
} catch (error) {
    // Сбой фиксируем до завершения finally, чтобы очистка scratch-БД выполнялась, а не обрывалась exit'ом.
    process.exitCode = 1;
    console.error(
        JSON.stringify({
            checkedAt: new Date().toISOString(),
            isolatedDatabases: databases,
            cases,
            failed: String(error?.message ?? error),
        }),
    );
} finally {
    for (const pool of pools.slice(1)) await pool.end().catch(() => undefined);
    for (const name of databases) await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)').catch(() => undefined);
    await admin.end().catch(() => undefined);
}
