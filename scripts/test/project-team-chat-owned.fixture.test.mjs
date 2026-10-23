import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = new URL('./project-team-chat-owned.fixture.mjs', import.meta.url).href;
const run = args => spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv=['node','owned-fixture',...JSON.parse(process.env.PROJECT_CHAT_GUARD_ARGUMENTS)];const fixture=await import(${JSON.stringify(fixture)});await fixture.admit();`], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PROJECT_CHAT_GUARD_ARGUMENTS: JSON.stringify(args), PGHOST: '127.0.0.1', PGPORT: '5432' },
});

test('Project chat native QA rejects missing, relative and unrelated owned configuration before a pool can exist', () => {
    for (const args of [[], ['--owned-postgres-config', 'connection.json'], ['--owned-postgres-config', '/tmp/not-an-owned-project/connection.json']]) {
        const result = run(args); assert.notEqual(result.status, 0); assert.match(result.stderr, /AssertionError|Pass --owned-postgres-config|owned PostgreSQL|Expected values/); assert.ok(!result.stderr.includes('ECONNREFUSED'));
    }
});

test('Project chat native QA rejects default PostgreSQL5432 and remote endpoints before connecting', async () => {
    const output = path.join(root, '.run/project-team-chat', randomUUID()), cluster = path.join(output, 'cluster');
    await mkdir(cluster, { recursive: true, mode: 0o700 });
    const ownerFile = path.join(cluster, 'owner.json'), configFile = path.join(cluster, 'connection.json');
    const owner = { nonce: randomUUID().replaceAll('-', ''), supervisorPid: process.pid, postgresPid: process.pid,
        dataDirectory: path.join(cluster, 'data'), runDirectory: cluster, port: 5432, startedAt: new Date().toISOString(), leaseSeconds: 60 };
    try {
        await writeFile(ownerFile, JSON.stringify(owner), { mode: 0o600 });
        for (const adminUrl of ['postgresql://qa_owner:fake-fixture-only@127.0.0.1:5432/postgres', 'postgresql://qa_owner:fake-fixture-only@example.test:63333/postgres']) {
            await writeFile(configFile, JSON.stringify({ ...owner, ownerFile, adminUrl }), { mode: 0o600 });
            const result = run(['--owned-postgres-config', configFile]); assert.notEqual(result.status, 0); assert.match(result.stderr, /explicitly owned loopback PostgreSQL/); assert.ok(!result.stderr.includes('ECONNREFUSED'));
        }
    } finally { await rm(output, { recursive: true, force: true }); }
});
