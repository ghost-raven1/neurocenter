/** Run existing migration/usage database suites only on the explicitly admitted disposable cluster. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { safeEnvironment } from '../coverage/profiles.mjs';
import { admit, ownedConnection, output, root, Pool } from './model-rate-owned.fixture.mjs';

await admit(); const owned = await ownedConnection();
const pool = new Pool({ connectionString: owned.url.href, max: 1, connectionTimeoutMillis: 1000 });
const before = (await pool.query('SELECT datname FROM pg_database ORDER BY datname')).rows;
const files = ['test/catalog-full-migrations.test.ts', 'test/model-usage-db.test.ts', 'src/model-usage/model-usage-report.ts', 'src/model-usage/model-usage.query.ts', 'src/model-usage/model-usage.service.ts', 'src/model-usage/model-usage.repository.ts', 'src/database/catalog-migrations.ts', 'src/database/current-schema-verification.ts'];
const sha = value => createHash('sha256').update(value).digest('hex'), packageRoot = path.join(root, 'services/catalog-service');
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(packageRoot, file)))])));
const receipt = { startedAt: new Date().toISOString(), ownerNonce: owned.owner.nonce, mainPostgresContacted: false, hashes };
const attempt = randomUUID(), jsonFile = path.join(output, 'legacy-native-tests-' + attempt + '.json'), logFile = path.join(output, 'legacy-native-tests-' + attempt + '.log');
Object.assign(receipt, { testReport: jsonFile, log: logFile });
const args = [path.join(packageRoot, 'node_modules/vitest/vitest.mjs'), 'run', 'test/catalog-full-migrations.test.ts', 'test/model-usage-db.test.ts', '--maxWorkers=1', '--fileParallelism=false', '--testTimeout=30000', '--hookTimeout=60000', '--reporter=json', '--outputFile=' + jsonFile];
try {
    const env = { ...safeEnvironment(process.env, process.execPath), CATALOG_TEST_PG_URL: owned.url.href, MODEL_USAGE_TEST_PG_URL: owned.url.href };
    assert.equal(env.CATALOG_PG_URL, undefined); assert.equal(env.PGPORT, undefined);
    const stream = createWriteStream(logFile, { flags: 'wx', mode: 0o600 });
    const code = await new Promise((resolve, reject) => { const child = spawn(process.execPath, args, { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false }); child.once('error', reject); child.once('exit', (code, signal) => { receipt.signal = signal; stream.end(() => resolve(code)); }); });
    const result = JSON.parse(await readFile(jsonFile, 'utf8'));
    receipt.exitCode = code; receipt.passed = result.numPassedTests; receipt.failed = result.numFailedTests; receipt.skipped = result.numPendingTests; receipt.total = result.numTotalTests;
    receipt.executedFiles = result.testResults.map(row => ({ file: path.relative(packageRoot, row.name), status: row.status, passed: row.assertionResults.filter(test => test.status === 'passed').length, failed: row.assertionResults.filter(test => test.status === 'failed').length, skipped: row.assertionResults.filter(test => ['pending', 'skipped', 'todo'].includes(test.status)).length }));
    receipt.ok = code === 0 && result.success === true && receipt.passed > 0 && receipt.failed === 0 && receipt.skipped === 0 && receipt.executedFiles.length === 2;
} finally {
    receipt.databaseInventoryPreserved = JSON.stringify((await pool.query('SELECT datname FROM pg_database ORDER BY datname')).rows) === JSON.stringify(before); await pool.end();
    receipt.sourceFreezeMatchesCurrent = (await Promise.all(files.map(async file => sha(await readFile(path.join(packageRoot, file))) === hashes[file]))).every(Boolean);
    receipt.ok = receipt.ok === true && receipt.databaseInventoryPreserved && receipt.sourceFreezeMatchesCurrent; receipt.completedAt = new Date().toISOString();
    const serialized = JSON.stringify(receipt, null, 2) + '\n'; await writeFile(path.join(output, 'legacy-native-' + attempt + '-receipt.json'), serialized); await writeFile(path.join(output, 'legacy-native-receipt.json'), serialized); console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1;
}
