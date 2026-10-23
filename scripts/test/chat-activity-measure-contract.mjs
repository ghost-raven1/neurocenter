/** Measure migration26 using an explicitly owned, disposable PostgreSQL16 cluster. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {admit, ownedConnection, output, root, Pool} from './project-team-chat-owned.fixture.mjs';

await admit(); const owned = await ownedConnection();
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
require('reflect-metadata'); require('ts-node').register({transpileOnly: true, project: path.join(root, 'services/catalog-service/tsconfig.json')});
const load = file => require(path.join(root, 'services/catalog-service/src', file));
const {migrateCatalog} = load('database/migrations.ts'), {CATALOG_MIGRATIONS} = load('database/catalog-migrations.ts');
const {CATALOG_SCHEMA_FACTS_SQL} = load('database/schema-catalog.ts'), {CHAT_ACTIVITY_SCHEMA_SQL} = load('chat-activity/chat-activity.schema.ts');
const admin = new Pool({connectionString: owned.url.href, max: 1}), database = 'nc_chat_activity_measure_' + randomUUID().replaceAll('-', '');
const receipt = {mainPostgresContacted: false, ownerNonce: owned.owner.nonce, port: owned.owner.port};
let pool, created = false;
try {
    await admin.query('CREATE DATABASE ' + database); created = true;
    const url = new URL(owned.url); url.pathname = '/' + database; pool = new Pool({connectionString: url.href, max: 1});
    await migrateCatalog(pool, CATALOG_MIGRATIONS.filter(item => item.version < 26));
    const before = (await pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows;
    await pool.query(CHAT_ACTIVITY_SCHEMA_SQL);
    const after = (await pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows, keys = new Map(before.map(row => [row.kind + ':' + row.id, row]));
    for (const row of before) assert.deepEqual(after.find(item => item.kind === row.kind && item.id === row.id), row, 'Historical schema drift: ' + row.id);
    const contract = after.filter(row => !keys.has(row.kind + ':' + row.id)).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    assert.ok(contract.length > 30);
    assert.ok(contract.every(row => /^(chat_presence_|project_chat_typing_|project_chat_read_)/.test(row.id)));
    const source = '/** Migration26 physical facts, measured on isolated PostgreSQL16.15. */\nexport const CHAT_ACTIVITY_SCHEMA_CONTRACT = [\n' + contract.map(row => '    ' + JSON.stringify(row) + ',').join('\n') + '\n];\n';
    if (process.argv.includes('--write-contract')) await writeFile(path.join(root, 'services/catalog-service/src/chat-activity/chat-activity.schema-contract.ts'), source);
    Object.assign(receipt, {historicalFactsPreserved: true, facts: contract.length, wroteContract: process.argv.includes('--write-contract')});
} finally {
    await pool?.end(); if (created) {await admin.query('DROP DATABASE ' + database); receipt.databaseDropped = true;} await admin.end();
    await writeFile(path.join(output, 'chat-activity-contract-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
}
