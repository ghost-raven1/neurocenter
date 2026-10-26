import fs from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import path from 'node:path';
import {createRequire} from 'node:module';
import {postgresBinaries, postgresVersion, readQaFile, sha256, QaPostgresError} from './postgres-contract.mjs';
import {runBuildProcess} from '../workspace/isolated-build-process.mjs';

const processEnvironment = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC'};
export const postgresProbeDriverVersion = '8.16.3';
const configurationNames = ['postgresql.conf', 'pg_hba.conf', 'pg_ident.conf', 'postgresql.auto.conf'];
const unavailableCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    '08000', '08001', '08003', '08006', '53300', '57P01', '57P02', '57P03']);
const unavailableMessages = new Set(['Connection terminated unexpectedly', 'Connection terminated',
    'Connection terminated due to connection timeout', 'timeout expired', 'Query read timeout']);

/** Only known transient transport/startup failures are unavailable; auth/protocol and unknown errors fail closed. */
export function postgresSqlErrorState(error) {
    return unavailableCodes.has(error?.code) || error?.code === undefined && unavailableMessages.has(error?.message) ? 'unavailable' : 'mismatch';
}

/** Freeze every fixed configuration input, including ALTER SYSTEM and authentication rules. */
export async function postgresConfigurationHashes(dataDirectory) {
    const hashes = {};
    for (const name of configurationNames) {
        try { hashes[name] = sha256(await readQaFile(path.join(dataDirectory, name))); }
        catch (error) { if (name !== 'postgresql.auto.conf' || error.code !== 'ENOENT') throw error; hashes[name] = null; }
    }
    return hashes;
}

/** Read-only pg 8.16.3 protocol observations; a successful connect must also complete negotiated SCRAM. */
export function observePostgresScram(client, driverVersion) {
    if (driverVersion !== postgresProbeDriverVersion || typeof client?.connection?.on !== 'function') return {proven: () => false};
    let offered = false, selected = false, finalized = false, otherAuthentication = false;
    client.connection.on('authenticationSASL', message => {
        offered = Array.isArray(message?.mechanisms) && message.mechanisms.includes('SCRAM-SHA-256');
        selected = false; finalized = false;
    });
    client.connection.on('authenticationSASLContinue', () => { selected = offered && client.saslSession?.mechanism === 'SCRAM-SHA-256'; });
    client.connection.on('authenticationSASLFinal', () => { finalized = selected && client.saslSession?.mechanism === 'SCRAM-SHA-256'; });
    for (const event of ['authenticationCleartextPassword', 'authenticationMD5Password'])
        client.connection.on(event, () => { otherAuthentication = true; });
    return {proven: () => offered && selected && finalized && !otherAuthentication};
}

/** Only short-lived setup/version commands use this bounded child; the server is launched separately. */
export async function qaCommand(binary, args, {cwd, signal, timeoutMs = 10000, logFile} = {}) {
    if (signal?.aborted) throw new QaPostgresError('QA_CANCELLED');
    return await new Promise((resolve, reject) => {
        let child, timer, stdout = '', stderr = '', completed = false, reason;
        const finish = (error, value) => { if (completed) return; completed = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
        const kill = code => { reason ??= code; try { child?.kill('SIGKILL'); } catch {} };
        const cancel = () => kill('QA_CANCELLED');
        try {
            child = spawn(binary, args, {cwd, env: processEnvironment, stdio: ['ignore', 'pipe', 'pipe'], shell: false});
            for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
                if (key === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
                if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 ** 2) kill('QA_COMMAND_OUTPUT_LIMIT');
            });
            child.once('error', () => finish(new QaPostgresError('QA_COMMAND_FAILED')));
            child.once('close', async (code, endedBy) => {
                if (logFile) try { await fs.writeFile(logFile, stdout + stderr, {flag: 'wx', mode: 0o600}); }
                catch { finish(new QaPostgresError('QA_RECEIPT_FAILED')); return; }
                finish(reason ? new QaPostgresError(reason) : code !== 0 || endedBy ? new QaPostgresError('QA_COMMAND_FAILED') : null, {stdout, code});
            });
            timer = setTimeout(() => kill('QA_COMMAND_TIMEOUT'), timeoutMs);
            signal?.addEventListener('abort', cancel, {once: true});
            if (signal?.aborted) cancel();
        } catch { finish(new QaPostgresError('QA_COMMAND_FAILED')); }
    });
}

/** The caller selects the installation; exact bytes and PostgreSQL patch versions are recorded before launch. */
export async function inspectPostgresBinaries(binDirectory, {command = qaCommand} = {}) {
    if (await fs.realpath(binDirectory) !== binDirectory || !(await fs.lstat(binDirectory)).isDirectory()) throw new QaPostgresError('QA_UNSAFE_PATH');
    const binaries = {};
    for (const name of postgresBinaries) {
        const filename = path.join(binDirectory, name), bytes = await readQaFile(filename, {maximumBytes: 128 * 1024 ** 2});
        if (!((await fs.stat(filename)).mode & 0o111)) throw new QaPostgresError('QA_BINARY_INVALID');
        const {stdout} = await command(filename, ['--version']);
        if (!new RegExp('^' + name + ' \\(PostgreSQL\\) ' + postgresVersion.replace('.', '\\.') + '(?:\\s|$)').test(stdout))
            throw new QaPostgresError('QA_VERSION_MISMATCH', 'Select one PostgreSQL 16.15 installation.');
        binaries[name] = {path: filename, sha256: sha256(bytes)};
    }
    return binaries;
}

export async function assertPostgresBinaries(owner) {
    for (const name of postgresBinaries) {
        const expected = owner.binaries?.[name];
        if (expected?.path !== path.join(owner.binDirectory, name) || sha256(await readQaFile(expected.path, {maximumBytes: 128 * 1024 ** 2})) !== expected.sha256)
            throw new QaPostgresError('QA_BINARY_CHANGED');
    }
}

/** initdb is finite and owns its bootstrap descendants, unlike the intentionally persistent server. */
export async function initializePostgres(owner, paths, {signal} = {}) {
    const result = await runBuildProcess({node: owner.binaries.initdb.path, args: ['-D', paths.data, '--username=qa_owner', '--pwfile=' + paths.password,
        '--auth-local=reject', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'], cwd: paths.directory,
        env: processEnvironment, signal, timeoutMs: 30000, logFile: paths.initLog});
    if (!result.ok) {
        const error = new QaPostgresError(result.failure?.code === 'CANCELLED' ? 'QA_CANCELLED' : 'QA_POSTGRES_INIT_FAILED');
        error.initialization = {ok: false, exitCode: result.exitCode, leaderReaped: result.leaderReaped,
            cleanup: {noLiveDescendants: result.cleanup.noLiveDescendants, signals: result.cleanup.signals}};
        throw error;
    }
    return {ok: true, exitCode: result.exitCode, leaderReaped: result.leaderReaped,
        cleanup: {noLiveDescendants: result.cleanup.noLiveDescendants, signals: result.cleanup.signals}};
}

function inspect(binary, args) {
    const result = spawnSync(binary, args, {env: processEnvironment, encoding: 'utf8', timeout: 1500, maxBuffer: 65536});
    if (result.error || result.signal || ![0, 1].includes(result.status)) return null;
    return {code: result.status, text: result.stdout.trim()};
}

/** Match current birth, executable, command and cwd; a PID number alone never authorizes a signal. */
export async function observePostgresProcess(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return {state: 'unknown'};
    const birth = inspect('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=']);
    if (!birth) return {state: 'unknown'};
    if (birth.code === 1 && !birth.text) return {state: 'absent'};
    const command = inspect('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
    let executable, cwd;
    try {
        if (process.platform === 'linux') { executable = await fs.realpath('/proc/' + pid + '/exe'); cwd = await fs.realpath('/proc/' + pid + '/cwd'); }
        else {
            executable = inspect('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='])?.text;
            const directory = inspect('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
            cwd = directory?.text.split('\n').find(line => line.startsWith('n'))?.slice(1);
        }
        executable = await fs.realpath(executable); cwd = await fs.realpath(cwd);
    } catch { return {state: 'unknown'}; }
    const again = inspect('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=']);
    if (!command || !birth.text || birth.text !== again?.text) return {state: 'unknown'};
    return {state: 'observed', identity: {pid, birth: birth.text, executable, cwd, command: command.text}};
}

/** Listener discovery is corroboration; it never selects arbitrary processes for termination. */
export async function postgresListener(port) {
    const result = inspect(process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn']);
    if (!result) return {state: 'unknown', pids: []};
    const pids = new Set(); let pid;
    for (const line of result.text.split('\n')) {
        if (/^p[1-9]\d*$/.test(line)) pid = Number(line.slice(1));
        if (pid && line.startsWith('n')) {
            if (line.slice(1) !== '127.0.0.1:' + port) return {state: 'foreign', pids: []};
            pids.add(pid);
        }
    }
    return {state: pids.size ? 'observed' : 'absent', pids: [...pids]};
}

/** Explicit connection fields prevent caller PG environment and default database fallbacks. */
export async function probePostgresSql(root, owner, connection) {
    const require = createRequire(path.join(root, 'services/catalog-service/package.json')), {Client} = require('pg');
    const driverVersion = require('pg/package.json').version;
    if (driverVersion !== postgresProbeDriverVersion) return {matches: false, sqlState: 'mismatch'};
    const url = new URL(connection.adminUrl);
    const client = new Client({host: '127.0.0.1', port: owner.port, database: 'postgres', user: 'qa_owner',
        password: decodeURIComponent(url.password), ssl: false, options: '', connectionTimeoutMillis: 1500,
        query_timeout: 2000, statement_timeout: 1500, application_name: 'neurocenter-qa-postgres-proof'});
    const authentication = observePostgresScram(client, driverVersion);
    try {
        await client.connect();
        const {rows} = await client.query(`SELECT current_setting('server_version') AS version,
            current_setting('data_directory') AS data_directory,current_setting('port')::int AS port,
            current_setting('config_file') AS config_file,current_setting('hba_file') AS hba_file,current_setting('ident_file') AS ident_file,
            current_setting('listen_addresses') AS listen_addresses,current_setting('unix_socket_directories') AS sockets,
            current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,
            current_setting('neurocenter_qa.nonce',true) AS nonce,host(inet_server_addr()) AS address,current_user AS role,
            (SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname=current_user) AS scram`);
        const row = rows[0];
        const matches = !!row && authentication.proven() && /^16\.15(?:\s|$)/.test(row.version) && row.data_directory === owner.dataDirectory
            && row.config_file === path.join(owner.dataDirectory, 'postgresql.conf') && row.hba_file === path.join(owner.dataDirectory, 'pg_hba.conf')
            && row.ident_file === path.join(owner.dataDirectory, 'pg_ident.conf')
            && row.port === owner.port && row.listen_addresses === '127.0.0.1' && row.sockets === '' && row.fsync === 'on'
            && row.full_page_writes === 'on' && row.nonce === owner.nonce && row.address === '127.0.0.1' && row.role === 'qa_owner' && row.scram === true;
        return {matches, sqlState: matches ? 'matched' : 'mismatch'};
    } finally { await client.end(); }
}

/** Launch the foreground server directly; finite command supervision must not kill its intentional daemon child. */
export async function launchPostgres(owner, logFile) {
    const handle = await fs.open(logFile, 'wx', 0o600);
    try {
        const child = spawn(owner.binaries.postgres.path, ['-D', owner.dataDirectory], {cwd: owner.dataDirectory,
            env: processEnvironment, detached: true, stdio: ['ignore', handle.fd, handle.fd], shell: false});
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new QaPostgresError('QA_POSTGRES_START_FAILED'))); });
        child.unref();
        return child.pid;
    } finally { await handle.close(); }
}
