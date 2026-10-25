import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {unlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {parsePostgresArguments, postgresPaths, readQaJson, saveQaJson, readQaFile} from '../qa/postgres-contract.mjs';
import {planQaPostgres, createQaPostgres, inspectQaPostgres, closeQaPostgres, loadQaPostgres} from '../qa/postgres-runtime.mjs';
import {admitManagedPostgres} from '../qa/postgres-admission.mjs';
import {observePostgresScram} from '../qa/postgres-process.mjs';

/** All runtime observations are explicit local fakes; these guard tests never execute PostgreSQL. */
async function fixture(t, {sql = true, corruptPid = false, signal} = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-qa-pg-')));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({name: 'neurocenter-workspace'}));
    const binDirectory = path.join(root, 'bin'); await fs.mkdir(binDirectory);
    for (const name of ['initdb', 'pg_ctl', 'postgres']) await fs.writeFile(path.join(binDirectory, name), '# explicit inert ' + name, {mode: 0o700});
    let owner, stopped = false, signalled = 0, identity, outsider = false;
    const dependencies = {
        command: async binary => ({stdout: path.basename(binary) + ' (PostgreSQL) 16.15\n', code: 0}),
        initialize: async (value, paths) => {
            owner = value;
            const receipt = await readQaJson(paths.receipt);
            assert.equal(receipt.status, 'initializing', 'Initial receipt precedes any bootstrap process.');
            assert.equal((await fs.stat(paths.password)).mode & 0o777, 0o600);
            await fs.mkdir(paths.data, {mode: 0o700});
            await fs.writeFile(path.join(paths.data, 'postgresql.conf'), '# inert private fixture\n');
            for (const name of ['pg_hba.conf', 'pg_ident.conf', 'postgresql.auto.conf']) await fs.writeFile(path.join(paths.data, name), '# inert ' + name + '\n');
            return {ok: true, exitCode: 0, leaderReaped: true, cleanup: {noLiveDescendants: true, signals: []}};
        },
        launch: async value => {
            owner = value;
            identity = {pid: 424242, birth: 'Sun Oct 25 20:00:00 2026', executable: value.binaries.postgres.path,
                cwd: value.dataDirectory, command: value.binaries.postgres.path + ' -D ' + value.dataDirectory};
            const started = Date.parse(identity.birth + ' UTC') / 1000;
            await fs.writeFile(path.join(value.dataDirectory, 'postmaster.pid'), [identity.pid, value.dataDirectory, started,
                corruptPid ? value.port + 1 : value.port, '', '127.0.0.1', '', 'ready', ''].join('\n'), {mode: 0o600});
            return identity.pid;
        },
        observeProcess: async () => stopped ? {state: 'absent'} : {state: 'observed', identity: outsider ? {...identity, birth: 'Mon Oct 26 20:00:00 2026'} : identity},
        listener: async () => stopped ? {state: 'absent', pids: []} : {state: 'observed', pids: [identity?.pid ?? 424242]},
        probeSql: async () => ({matches: sql}),
        sendSignal: (pid, sent) => { assert.equal(pid, identity.pid); assert.equal(sent, 'SIGINT'); signalled++; stopped = true; unlinkSync(path.join(owner.dataDirectory, 'postmaster.pid')); },
    };
    const options = parsePostgresArguments(['create', '--bin-dir', binDirectory], {});
    return {root, binDirectory, options, dependencies, create: extra => createQaPostgres(root, options, {...dependencies, signal, ...extra}),
        get signalled() { return signalled; }, get owner() { return owner; }, replacePid() { outsider = true; }};
}

test('PostgreSQL CLI admits only fixed actions, absolute binaries, UUIDs and bounded leases', () => {
    const id = randomUUID();
    assert.deepEqual(parsePostgresArguments(['inspect', '--run', id], {NEUROCENTER_QA_POSTGRES: '0'}), {action: 'inspect', runId: id});
    assert.equal(parsePostgresArguments(['close', '--run', id], {NEUROCENTER_QA_POSTGRES: '0'}).action, 'close');
    assert.equal(parsePostgresArguments(['--help'], {NEUROCENTER_QA_POSTGRES: '0'}).help, true);
    for (const args of [['start'], ['close', '--run', '../main'], ['create', '--bin-dir', 'relative'],
        ['create', '--bin-dir', '/tmp/a', '--lease-seconds', '0'], ['plan', '--bin-dir', '/tmp/a', '--lease-seconds', '14401'],
        ['create', '--bin-dir', '/tmp/a', '--bin-dir', '/tmp/b'], ['inspect', '--run', id, '--bin-dir', '/tmp/a']])
        assert.throws(() => parsePostgresArguments(args, {}), {code: 'QA_INVALID_ARGUMENT'});
});

test('Plan validates explicit 16.15 binaries without creating run directories or loading a driver', async t => {
    const f = await fixture(t), plan = await planQaPostgres(f.root, f.options, f.dependencies);
    assert.equal(plan.version, '16.15'); assert.equal(plan.runtimeDownloaded, false);
    assert.deepEqual(Object.keys(plan.binaries), ['initdb', 'pg_ctl', 'postgres']);
    await assert.rejects(fs.stat(path.join(f.root, '.run')), {code: 'ENOENT'});
    await assert.rejects(planQaPostgres(f.root, f.options, {command: async () => ({stdout: 'postgres (PostgreSQL) 16.16\n'})}), {code: 'QA_VERSION_MISMATCH'});
    await assert.rejects(fs.stat(path.join(f.root, '.run')), {code: 'ENOENT'});
});

test('Disabled create and native admission fail before reading metadata or writing files', async t => {
    const f = await fixture(t);
    await assert.rejects(f.create({environment: {NEUROCENTER_QA_POSTGRES: '0'}}), {code: 'QA_DISABLED'});
    await assert.rejects(admitManagedPostgres('/missing/connection.json', {root: f.root, environment: {NEUROCENTER_QA_POSTGRES: '0'}}), {code: 'QA_DISABLED'});
    await assert.rejects(fs.stat(path.join(f.root, '.run')), {code: 'ENOENT'});
});

test('Managed create preserves private credentials and a complete independent ownership proof', async t => {
    const f = await fixture(t), result = await f.create();
    assert.equal(result.ready, true); assert.equal(result.ownership, 'owned'); assert.equal(f.signalled, 0);
    const loaded = await loadQaPostgres(f.root, result.runId), visible = JSON.stringify(result);
    assert.equal(visible.includes(loaded.owner.nonce), false);
    assert.equal(visible.includes(new URL(loaded.connection.adminUrl).password), false);
    for (const file of [loaded.paths.owner, loaded.paths.connection, loaded.paths.receipt, loaded.paths.password]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(loaded.paths.directory)).mode & 0o777, 0o700);
    const admitted = await admitManagedPostgres(result.connectionFile, {root: f.root, ...f.dependencies, environment: {}});
    assert.equal(admitted.owner.runId, result.runId); assert.equal(admitted.proof.sql, true);
    const closed = await closeQaPostgres(f.root, result.runId, f.dependencies);
    assert.equal(closed.stopped, true); assert.equal(closed.dataRetained, true); assert.equal(f.signalled, 1);
    await fs.stat(loaded.paths.data);
    assert.equal((await closeQaPostgres(f.root, result.runId, f.dependencies)).stopped, true); assert.equal(f.signalled, 1);
});

test('PID birth reuse is unknown while the old pidfile exists and never signals the replacement', async t => {
    const f = await fixture(t), created = await f.create(); f.replacePid();
    assert.equal((await inspectQaPostgres(f.root, created.runId, f.dependencies)).ownership, 'unknown');
    await assert.rejects(closeQaPostgres(f.root, created.runId, f.dependencies), {code: 'QA_OWNERSHIP_UNKNOWN'});
    assert.equal(f.signalled, 0); assert.ok(await fs.stat(f.owner.dataDirectory));
});

test('Expired lease prevents native admission but never prevents proven owned shutdown', async t => {
    const f = await fixture(t), created = await f.create(), loaded = await loadQaPostgres(f.root, created.runId);
    loaded.owner.startedAt = new Date(Date.now() - 10000).toISOString(); loaded.owner.leaseSeconds = 1;
    loaded.owner.expiresAt = new Date(Date.parse(loaded.owner.startedAt) + 1000).toISOString(); await saveQaJson(loaded.paths.owner, loaded.owner);
    await assert.rejects(admitManagedPostgres(created.connectionFile, {root: f.root, ...f.dependencies, environment: {}}), {code: 'QA_LEASE_EXPIRED'});
    assert.equal((await closeQaPostgres(f.root, created.runId, f.dependencies)).stopped, true); assert.equal(f.signalled, 1);
});

test('Changed binary bytes or configuration never authorize a shutdown signal', async t => {
    for (const target of ['binary', 'config']) {
        const f = await fixture(t), created = await f.create();
        const filename = target === 'binary' ? path.join(f.binDirectory, 'postgres') : path.join(f.owner.dataDirectory, 'postgresql.conf');
        await fs.appendFile(filename, '\nchanged');
        await assert.rejects(closeQaPostgres(f.root, created.runId, f.dependencies), {code: 'QA_OWNERSHIP_UNKNOWN'});
        assert.equal(f.signalled, 0);
    }
});

test('Unknown startup retains its primary failure and never signals an inconsistent pidfile', async t => {
    const f = await fixture(t, {corruptPid: true}), result = await f.create({startupTimeoutMs: 25});
    assert.equal(result.ready, false); assert.equal(result.status, 'unknown'); assert.equal(result.failure.code, 'QA_POSTGRES_START_UNKNOWN');
    const loaded = await loadQaPostgres(f.root, result.runId);
    assert.ok(loaded.receipt.recoveryErrors.some(error => error.code === 'QA_OWNERSHIP_UNKNOWN'));
    assert.equal(f.signalled, 0); await fs.stat(loaded.paths.data);
});

test('An explicit SQL identity mismatch leaves ownership unknown and cannot authorize a stop', async t => {
    const f = await fixture(t, {sql: false}), result = await f.create({startupTimeoutMs: 25});
    assert.equal(result.ready, false); assert.equal(result.failure.code, 'QA_POSTGRES_START_UNKNOWN');
    const loaded = await loadQaPostgres(f.root, result.runId);
    assert.equal(loaded.receipt.stoppedAt, null); assert.equal(f.signalled, 0);
    const observed = await inspectQaPostgres(f.root, result.runId, f.dependencies);
    assert.equal(observed.ownership, 'unknown'); assert.equal(observed.proof.sqlState, 'mismatch');
    await assert.rejects(closeQaPostgres(f.root, result.runId, f.dependencies), {code: 'QA_OWNERSHIP_UNKNOWN'});
});

test('Authentication and ALTER SYSTEM configuration mutations reject admission and every shutdown signal', async t => {
    for (const name of ['pg_hba.conf', 'pg_ident.conf', 'postgresql.auto.conf']) {
        const f = await fixture(t), created = await f.create();
        await fs.appendFile(path.join(f.owner.dataDirectory, name), '\n# changed active input\n');
        await assert.rejects(admitManagedPostgres(created.connectionFile, {root: f.root, ...f.dependencies, environment: {}}));
        await assert.rejects(closeQaPostgres(f.root, created.runId, f.dependencies), {code: 'QA_OWNERSHIP_UNKNOWN'});
        assert.equal(f.signalled, 0);
    }
});

test('Unstarted postmaster with unproven initdb descendant cleanup stays unknown and never closes', async t => {
    const f = await fixture(t);
    const result = await f.create({initialize: async () => {
        const error = new Error('Controlled bootstrap cleanup failure');
        error.initialization = {ok: false, exitCode: 1, leaderReaped: true, cleanup: {noLiveDescendants: false, signals: ['SIGTERM']}};
        throw error;
    }, listener: async () => ({state: 'absent', pids: []})});
    assert.equal(result.status, 'unknown');
    const dependencies = {...f.dependencies, listener: async () => ({state: 'absent', pids: []})};
    assert.equal((await inspectQaPostgres(f.root, result.runId, dependencies)).ownership, 'unknown');
    await assert.rejects(closeQaPostgres(f.root, result.runId, dependencies), {code: 'QA_OWNERSHIP_UNKNOWN'});
    const loaded = await loadQaPostgres(f.root, result.runId);
    assert.equal(loaded.receipt.initialization.cleanup.noLiveDescendants, false); assert.equal(loaded.receipt.stoppedAt, null);
});

test('A lease expiring while SQL proof awaits cannot produce ready or admit a new native run', async t => {
    const f = await fixture(t), created = await f.create(), loaded = await loadQaPostgres(f.root, created.runId);
    loaded.owner.startedAt = new Date().toISOString(); loaded.owner.leaseSeconds = 1;
    loaded.owner.expiresAt = new Date(Date.parse(loaded.owner.startedAt) + 1000).toISOString();
    await saveQaJson(loaded.paths.owner, loaded.owner);
    const actualNow = Date.now; let now = Date.parse(loaded.owner.startedAt);
    Date.now = () => now;
    const dependencies = {...f.dependencies, probeSql: async () => { now = Date.parse(loaded.owner.expiresAt) + 1; return {matches: true}; }};
    try {
        const observed = await inspectQaPostgres(f.root, created.runId, dependencies);
        assert.equal(observed.ready, false); assert.equal(observed.proof.leaseValid, false);
        now = Date.parse(loaded.owner.startedAt);
        await assert.rejects(admitManagedPostgres(created.connectionFile, {root: f.root, ...dependencies, environment: {}}), {code: 'QA_LEASE_EXPIRED'});
    } finally { Date.now = actualNow; }
});

test('Redirected data directories and public private-metadata files are rejected without signalling', async t => {
    const f = await fixture(t), created = await f.create(), loaded = await loadQaPostgres(f.root, created.runId);
    await fs.chmod(loaded.paths.connection, 0o644);
    await assert.rejects(closeQaPostgres(f.root, created.runId, f.dependencies), {code: 'QA_UNSAFE_PATH'});
    await fs.chmod(loaded.paths.connection, 0o600);
    const elsewhere = path.join(f.root, 'elsewhere'); await fs.rename(loaded.paths.data, elsewhere); await fs.symlink(elsewhere, loaded.paths.data);
    await assert.rejects(closeQaPostgres(f.root, created.runId, f.dependencies), {code: 'QA_OWNERSHIP_UNKNOWN'});
    assert.equal(f.signalled, 0);
});

test('Connection admission cannot escape the fixed checkout UUID namespace', async t => {
    const f = await fixture(t);
    for (const file of ['/tmp/connection.json', path.join(f.root, '.run/qa-postgres', randomUUID(), 'owner.json'),
        path.join(f.root, '.run/qa-postgres', randomUUID(), '../connection.json')])
        await assert.rejects(admitManagedPostgres(file, {root: f.root, environment: {}}), error => ['QA_UNSAFE_PATH', 'QA_INVALID_ARGUMENT'].includes(error.code));
});

test('Private file reader rejects parent-directory redirection and hardlinked credentials', async t => {
    const f = await fixture(t), actual = path.join(f.root, 'actual'); await fs.mkdir(actual);
    await fs.writeFile(path.join(actual, 'secret'), 'private', {mode: 0o600});
    const alias = path.join(f.root, 'alias'); await fs.symlink(actual, alias);
    await assert.rejects(readQaFile(path.join(alias, 'secret'), {privateMode: true}), {code: 'QA_UNSAFE_PATH'});
    await fs.link(path.join(actual, 'secret'), path.join(actual, 'second'));
    await assert.rejects(readQaFile(path.join(actual, 'secret'), {privateMode: true}), {code: 'QA_UNSAFE_PATH'});
    assert.throws(() => postgresPaths(f.root, '../main'), {code: 'QA_INVALID_ARGUMENT'});
});

test('SCRAM observation requires the negotiated mechanism and ordered final exchange on the supported driver', () => {
    const client = {connection: new EventEmitter(), saslSession: null}, authentication = observePostgresScram(client, '8.16.3');
    client.connection.emit('authenticationSASL', {mechanisms: ['SCRAM-SHA-256']});
    assert.equal(authentication.proven(), false);
    client.saslSession = {mechanism: 'SCRAM-SHA-256'};
    client.connection.emit('authenticationSASLContinue', {}); assert.equal(authentication.proven(), false);
    client.connection.emit('authenticationSASLFinal', {}); assert.equal(authentication.proven(), true);
    client.connection.emit('authenticationMD5Password', {}); assert.equal(authentication.proven(), false);
});

test('Trust authentication, missing private API, unsupported driver and unnegotiated finals cannot prove SCRAM', () => {
    const trust = {connection: new EventEmitter(), saslSession: null}, observed = observePostgresScram(trust, '8.16.3');
    trust.connection.emit('authenticationOk', {}); assert.equal(observed.proven(), false);
    trust.connection.emit('authenticationSASLFinal', {}); assert.equal(observed.proven(), false);
    assert.equal(observePostgresScram({}, '8.16.3').proven(), false);
    assert.equal(observePostgresScram({connection: new EventEmitter()}, '8.16.4').proven(), false);
});

test('Explicit authentication, authorization and protocol rejection never authorize a shutdown signal', async t => {
    for (const error of [Object.assign(new Error('private password rejection'), {code: '28P01'}),
        Object.assign(new Error('private role rejection'), {code: '28000'}), Object.assign(new Error('private privilege rejection'), {code: '42501'}),
        Object.assign(new Error('private protocol rejection'), {code: '08P01'}),
        new Error('SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match'), new Error('Unknown authenticationOk message type 99')]) {
        const f = await fixture(t), created = await f.create();
        const dependencies = {...f.dependencies, probeSql: async () => { throw error; }};
        const observed = await inspectQaPostgres(f.root, created.runId, dependencies);
        assert.equal(observed.ownership, 'unknown', error.code || error.message); assert.equal(observed.proof.sqlState, 'mismatch');
        assert.equal(observed.ready, false);
        await assert.rejects(admitManagedPostgres(created.connectionFile, {root: f.root, ...dependencies, environment: {}}), {code: 'QA_SQL_MISMATCH'});
        await assert.rejects(closeQaPostgres(f.root, created.runId, dependencies), {code: 'QA_OWNERSHIP_UNKNOWN'});
        assert.equal(f.signalled, 0);
    }
});

test('Transient connection refusal and PostgreSQL startup unavailability stay distinct from identity mismatch', async t => {
    for (const error of [Object.assign(new Error('refused'), {code: 'ECONNREFUSED'}), Object.assign(new Error('starting'), {code: '57P03'}),
        new Error('Connection terminated unexpectedly')]) {
        const f = await fixture(t), created = await f.create();
        const dependencies = {...f.dependencies, probeSql: async () => { throw error; }};
        const observed = await inspectQaPostgres(f.root, created.runId, dependencies);
        assert.equal(observed.ownership, 'owned'); assert.equal(observed.ready, false); assert.equal(observed.proof.sqlState, 'unavailable');
        assert.equal((await closeQaPostgres(f.root, created.runId, dependencies)).stopped, true); assert.equal(f.signalled, 1);
    }
});
