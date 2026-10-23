import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { ownedTestPostgresAdmin } from './owned-postgres.fixture.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const flag = process.argv.indexOf('--owned-postgres-config');
assert.ok(flag > 1 && typeof process.argv[flag + 1] === 'string', 'Pass --owned-postgres-config with a fresh, explicitly owned connection.json.');
const selected = process.argv[flag + 1];
assert.ok(path.isAbsolute(selected), 'The owned PostgreSQL configuration path must be absolute.');
export const output = path.dirname(path.dirname(selected));
assert.equal(path.dirname(path.dirname(output)), path.join(root, '.run'));
assert.match(path.basename(path.dirname(output)), /^project-team-chat(?:-\d{8})?$/);
assert.match(path.basename(output), /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
assert.equal(selected, path.join(output, 'cluster/connection.json'));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
export const { Pool, Client } = require('pg');

/** Reject implicit or stale endpoints before constructing any PostgreSQL client. */
export async function ownedConnection() {
    assert.equal(await realpath(output), output, 'An owned run directory cannot be a symlink.');
    const metadata = await lstat(selected);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    assert.equal(metadata.mode & 0o777, 0o600);
    const config = JSON.parse(await readFile(selected, 'utf8'));
    const ownerFile = path.join(output, 'cluster/owner.json');
    assert.equal(config.ownerFile, ownerFile);
    const ownerMetadata = await lstat(ownerFile);
    assert.ok(ownerMetadata.isFile() && !ownerMetadata.isSymbolicLink());
    assert.equal(ownerMetadata.mode & 0o777, 0o600);
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    const url = ownedTestPostgresAdmin(config.adminUrl);
    assert.match(owner.nonce, /^[a-f0-9]{32}$/);
    for (const field of ['nonce', 'postgresPid', 'supervisorPid', 'dataDirectory', 'runDirectory', 'port']) assert.equal(config[field], owner[field]);
    assert.equal(owner.runDirectory, path.join(output, 'cluster'));
    assert.equal(owner.dataDirectory, path.join(owner.runDirectory, 'data'));
    assert.equal(await realpath(owner.dataDirectory), owner.dataDirectory);
    assert.equal(url.port, String(owner.port));
    assert.ok(Number.isSafeInteger(owner.postgresPid) && owner.postgresPid > 1);
    assert.ok(Number.isSafeInteger(owner.supervisorPid) && owner.supervisorPid > 1);
    assert.ok(Number.isSafeInteger(owner.leaseSeconds) && owner.leaseSeconds > 0 && owner.leaseSeconds <= 7200);
    const age = Date.now() - Date.parse(owner.startedAt);
    assert.ok(age >= -5000 && age < owner.leaseSeconds * 1000, 'The owned PostgreSQL lease expired.');
    const lines = (await readFile(path.join(owner.dataDirectory, 'postmaster.pid'), 'utf8')).split('\n');
    assert.equal(Number(lines[0]), owner.postgresPid);
    assert.equal(lines[1], owner.dataDirectory);
    assert.equal(Number(lines[3]), owner.port);
    assert.equal(lines[7].trim(), 'ready');
    process.kill(owner.postgresPid, 0); process.kill(owner.supervisorPid, 0);
    return { config, owner, url };
}

/** SQL confirms the selected connection reaches this exact disposable cluster. */
export async function admit() {
    const admitted = await ownedConnection();
    const client = new Client({ connectionString: admitted.url.href, connectionTimeoutMillis: 3000 });
    try {
        await client.connect();
        const row = (await client.query("SELECT current_setting('server_version') AS version,current_setting('data_directory') AS data_directory,current_setting('port')::int AS port,current_setting('listen_addresses') AS listen_addresses,current_setting('unix_socket_directories') AS sockets,current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,host(inet_server_addr()) AS server_addr,current_user AS role")).rows[0];
        assert.match(row.version, /^16\.15/);
        assert.equal(row.data_directory, admitted.owner.dataDirectory);
        assert.equal(row.port, admitted.owner.port);
        assert.equal(row.server_addr, '127.0.0.1');
        assert.equal(row.listen_addresses, '127.0.0.1');
        assert.equal(row.sockets, '');
        assert.equal(row.fsync, 'on'); assert.equal(row.full_page_writes, 'on');
        assert.equal(row.role, 'qa_owner');
        assert.equal((await client.query("SELECT rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname=current_user")).rows[0].scram, true);
        const receipt = { ok: true, checkedAt: new Date().toISOString(), settings: row, ownerNonce: admitted.owner.nonce, mainPostgresContacted: false };
        await writeFile(path.join(output, 'sql-admission.json'), JSON.stringify(receipt, null, 2) + '\n');
        return receipt;
    } finally { await client.end(); }
}
