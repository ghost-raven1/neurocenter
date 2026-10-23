/** Measure migration24 on a fresh owned cluster; --write-contract explicitly saves the source facts. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { admit, ownedConnection, output, root, Pool } from './model-rate-owned.fixture.mjs';

await admit();
const owned = await ownedConnection();
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata'); require('ts-node').register({ transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json') });
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const { migrateCatalog } = load('database/migrations.ts');
const { CATALOG_MIGRATIONS } = load('database/catalog-migrations.ts');
const { CATALOG_SCHEMA_FACTS_SQL } = load('database/schema-catalog.ts');
const { MODEL_RATE_LIMITS_SCHEMA_SQL } = load('model-rate-limits/model-rate-limits.schema.ts');
const { MODEL_USAGE_DETAILS_SCHEMA_SQL } = load('model-usage/model-usage-details.schema.ts');
const ddl = MODEL_RATE_LIMITS_SCHEMA_SQL + '\n' + MODEL_USAGE_DETAILS_SCHEMA_SQL;
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['model-rate-limits/model-rate-limits.schema.ts', 'model-usage/model-usage-details.schema.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(path.join(root, 'services/catalog-service/src', file)))])));
const admin = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 3000 });
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const database = 'nc_model_rate_contract_' + randomUUID().replaceAll('-', '');
const receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, mainPostgresContacted: false, ddlSha256: sha(ddl), wroteContract: false };
const facts = async pool => (await pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
let pool, created = false;
try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true; const url = new URL(owned.url); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 1000, statement_timeout: 5000 });
    const historical = CATALOG_MIGRATIONS.filter(migration => migration.version < 24); assert.equal(historical.at(-1).version, 23);
    await migrateCatalog(pool, historical); const before = await facts(pool);
    await pool.query('BEGIN');
    try { await pool.query(ddl); await pool.query('COMMIT'); } catch (error) { await pool.query('ROLLBACK'); throw error; }
    const after = await facts(pool), byKey = rows => new Map(rows.map(row => [row.kind + ':' + row.id, row]));
    const beforeByKey = byKey(before), afterByKey = byKey(after);
    for (const [key, row] of beforeByKey) assert.deepEqual(afterByKey.get(key), row, 'Migration24 changed previous fact ' + key);
    const contract = after.filter(row => !beforeByKey.has(row.kind + ':' + row.id));
    assert.ok(contract.length > 20, 'Expected physically measured rate tables and usage details.');
    for (const row of contract) assert.match(row.id, /^(model_api_|model_usage_calls[._])/, 'Unexpected migration24 object ' + row.id);
    const contractFile = path.join(root, 'services/catalog-service/src/model-rate-limits/model-rate-limits.schema-contract.ts');
    const source = '/** Migration24 physical facts, measured on isolated PostgreSQL16.15. */\nexport const MODEL_RATE_LIMITS_SCHEMA_CONTRACT = [\n' + contract.map(row => '    ' + JSON.stringify(row) + ',').join('\n') + '\n];\n';
    if (process.argv.includes('--write-contract')) { await writeFile(contractFile, source); receipt.wroteContract = true; }
    await writeFile(path.join(output, 'schema-facts-before.json'), JSON.stringify(before, null, 2) + '\n');
    await writeFile(path.join(output, 'schema-facts-after.json'), JSON.stringify(after, null, 2) + '\n');
    await writeFile(path.join(output, 'model-rate-contract.json'), JSON.stringify(contract, null, 2) + '\n');
    receipt.previousFacts = before.length; receipt.previousFactsPreserved = true; receipt.contractFacts = contract.length; receipt.countByKind = Object.fromEntries([...new Set(contract.map(row => row.kind))].map(kind => [kind, contract.filter(row => row.kind === kind).length])); receipt.contractSha256 = sha(source);
    receipt.ddlSourceHashes = sourceHashes;
    receipt.sourceFreezeMatchesCurrent = (await Promise.all(sourceFiles.map(async file => sha(await readFile(path.join(root, 'services/catalog-service/src', file))) === sourceHashes[file]))).every(Boolean);
} finally {
    await pool?.end(); if (created) { await admin.query('DROP DATABASE "' + database + '"'); receipt.databaseDropped = true; }
    receipt.databaseInventoryPreserved = JSON.stringify((await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(beforeDatabases); await admin.end();
    receipt.completedAt = new Date().toISOString(); receipt.ok = receipt.previousFactsPreserved === true && receipt.contractFacts > 20 && receipt.databaseDropped && receipt.databaseInventoryPreserved && receipt.sourceFreezeMatchesCurrent;
    await writeFile(path.join(output, 'contract-receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1;
}
