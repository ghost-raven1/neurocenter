/** Regression for a rate-store SQL lock: abort must settle before the blocking transaction is released. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { admit, ownedConnection, output, root, Pool } from './model-rate-owned.fixture.mjs';

await admit(); const owned = await ownedConnection();
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata'); require('ts-node').register({ transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json') });
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const { ensureCatalogSchema } = load('database/catalog-schema.ts');
const { ModelRateLimitsRepository } = load('model-rate-limits/model-rate-limits.repository.ts');
const sha = value => createHash('sha256').update(value).digest('hex');
const repositoryHash = sha(await readFile(path.join(root, 'services/catalog-service/src/model-rate-limits/model-rate-limits.repository.ts')));
const files = ['model-rate-limits.repository.ts', 'model-rate-limits.client.ts', 'model-rate-limits.wait.ts'];
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src/model-rate-limits', file)))])));
const database = 'nc_model_rate_abort_' + randomUUID().replaceAll('-', ''), admin = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 1000 });
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, repositoryHash, hashes, mainPostgresContacted: false, providerCalls: 0 };
let pool, lock, pending, created = false;
try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true; const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 3, connectionTimeoutMillis: 1000 }); await ensureCatalogSchema(pool);
    await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2::jsonb)', ['model-rate-abort', JSON.stringify({ runtime: 'ollama' })]);
    lock = await pool.connect(); await lock.query('BEGIN'); await lock.query('LOCK TABLE model_api_dispatch_slots IN ACCESS EXCLUSIVE MODE');
    const abort = new AbortController(), repository = new ModelRateLimitsRepository(pool); let settled = false, failure;
    pending = repository.tryAcquire('model-rate-abort', abort.signal).then(() => { settled = true; }, error => { settled = true; failure = error; });
    const deadline = Date.now() + 3000;
    for (;;) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM model_api_dispatch_slots%' LIMIT 1");
        if (waiting.rowCount) { receipt.sqlLockWaitObserved = true; break; }
        assert.ok(Date.now() < deadline, 'Did not observe the intended DELETE lock wait'); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const started = performance.now(); abort.abort(new Error('Owned SQL-lock cancellation'));
    await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 300))]);
    receipt.settledBeforeBlockRelease = settled; receipt.abortElapsedMs = performance.now() - started;
    await lock.query('ROLLBACK'); lock.release(); lock = undefined; await pending;
    receipt.sameAbortReason = failure === abort.signal.reason;
    receipt.committedSlots = Number((await pool.query('SELECT count(*)::int AS count FROM model_api_dispatch_slots')).rows[0].count);
    receipt.ok = receipt.sqlLockWaitObserved && receipt.settledBeforeBlockRelease && receipt.sameAbortReason && receipt.committedSlots === 0;
} finally {
    if (lock) { await lock.query('ROLLBACK'); lock.release(); } await pending; await pool?.end();
    if (created) { await admin.query('DROP DATABASE "' + database + '"'); receipt.databaseDropped = true; }
    receipt.databaseInventoryPreserved = JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(beforeDatabases); await admin.end();
    receipt.sourceFreezeMatchesCurrent = (await Promise.all(files.map(async file => sha(await readFile(path.join(root, 'services/catalog-service/src/model-rate-limits', file))) === hashes[file]))).every(Boolean);
    receipt.ok = receipt.ok === true && receipt.databaseDropped && receipt.databaseInventoryPreserved && receipt.sourceFreezeMatchesCurrent; receipt.completedAt = new Date().toISOString();
    const receiptFile = path.join(output, process.argv.includes('--red-receipt') ? 'sql-abort-red-receipt.json' : 'sql-abort-native-receipt.json');
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1;
}
