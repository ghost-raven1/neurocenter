import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:net';
import {randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {postgresVersion, postgresPaths, canonicalQaRoot, privateQaDirectory, readQaFile, readQaJson, saveQaJson,
    sha256, QaPostgresError, assertPostgresFlag, maximumLeaseSeconds} from './postgres-contract.mjs';
import {inspectPostgresBinaries, assertPostgresBinaries, observePostgresProcess, postgresListener,
    probePostgresSql, launchPostgres, initializePostgres, postgresConfigurationHashes, postgresSqlErrorState} from './postgres-process.mjs';

const kind = 'neurocenter-qa-postgres';
const codeOf = (error, fallback) => error instanceof QaPostgresError ? error.code : fallback;
const sameIdentity = (left, right) => !!left && !!right && ['pid', 'birth', 'executable', 'cwd', 'command'].every(key => left[key] === right[key]);

/** Plan reads explicit binaries but neither creates directories nor loads the database driver. */
export async function planQaPostgres(root, options, dependencies = {}) {
    if (!options || !path.isAbsolute(options.binDirectory ?? '') || path.resolve(options.binDirectory) !== options.binDirectory
        || !Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 1 || options.leaseSeconds > maximumLeaseSeconds)
        throw new QaPostgresError('QA_INVALID_ARGUMENT');
    await canonicalQaRoot(root);
    const binaries = await inspectPostgresBinaries(options.binDirectory, dependencies);
    return {kind, version: postgresVersion, action: 'plan', binDirectory: options.binDirectory, binaries,
        leaseSeconds: options.leaseSeconds, root: path.join(root, '.run/qa-postgres'),
        requirements: ['Existing Catalog pg dependency', 'POSIX process inspection', 'Loopback TCP and a private ephemeral port'],
        dataRetainedOnClose: true, runtimeDownloaded: false};
}

async function allocatePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (port === 5432) return allocatePort();
    return port;
}

async function createRunDirectory(root, paths) {
    const run = path.join(root, '.run');
    try { await fs.mkdir(run, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (await fs.realpath(run) !== run || !(await fs.lstat(run)).isDirectory()) throw new QaPostgresError('QA_UNSAFE_PATH');
    const parent = path.dirname(paths.directory);
    try { await privateQaDirectory(parent, {create: true}); } catch (error) { if (error.code !== 'EEXIST') throw error; await privateQaDirectory(parent); }
    await privateQaDirectory(paths.directory, {create: true});
}

/** New metadata is scoped to one fixed UUID directory; it is never an arbitrary connection-file reader. */
export async function loadQaPostgres(root, runId) {
    await canonicalQaRoot(root);
    const paths = postgresPaths(root, runId);
    await privateQaDirectory(path.dirname(paths.directory));
    await privateQaDirectory(paths.directory);
    const [owner, connection, receipt] = await Promise.all([readQaJson(paths.owner), readQaJson(paths.connection), readQaJson(paths.receipt)]);
    if (owner?.schemaVersion !== 1 || owner.kind !== kind || owner.runId !== runId || owner.workspaceRoot !== root
        || owner.runDirectory !== paths.directory || owner.dataDirectory !== paths.data || !/^[a-f0-9]{32}$/.test(owner.nonce)
        || !path.isAbsolute(owner.binDirectory) || !Number.isSafeInteger(owner.port) || owner.port < 1024 || owner.port > 65535 || owner.port === 5432
        || !Number.isSafeInteger(owner.leaseSeconds) || owner.leaseSeconds < 1 || owner.leaseSeconds > maximumLeaseSeconds
        || !Number.isFinite(Date.parse(owner.startedAt)) || Date.parse(owner.expiresAt) !== Date.parse(owner.startedAt) + owner.leaseSeconds * 1000
        || typeof owner.launchAttempted !== 'boolean' || owner.postgresPid !== null && (!Number.isSafeInteger(owner.postgresPid) || owner.postgresPid <= 1)
        || receipt?.schemaVersion !== 1 || receipt.kind !== kind || receipt.runId !== runId || !Array.isArray(receipt.recoveryErrors)
        || !['preparing', 'initializing', 'starting', 'ready', 'closing', 'closed', 'failed', 'unknown'].includes(receipt.status)
        || connection?.schemaVersion !== 1 || connection.kind !== kind || connection.ownerFile !== paths.owner
        || connection.nonce !== owner.nonce || connection.dataDirectory !== paths.data) throw new QaPostgresError('QA_METADATA_INVALID');
    let url;
    try { url = new URL(connection.adminUrl); } catch { throw new QaPostgresError('QA_METADATA_INVALID'); }
    if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || Number(url.port) !== owner.port || url.pathname !== '/postgres'
        || url.username !== 'qa_owner' || !url.password || url.search || url.hash) throw new QaPostgresError('QA_METADATA_INVALID');
    return {paths, owner, connection, receipt, url};
}

async function pidFile(paths) {
    try {
        const lines = (await readQaFile(path.join(paths.data, 'postmaster.pid'))).toString('utf8').split('\n');
        return {pid: Number(lines[0]), directory: lines[1], started: Number(lines[2]), port: Number(lines[3]), status: lines[7]?.trim()};
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Every live proof ties the saved birth and fixed command to current files and the actual listener. */
export async function inspectQaPostgres(root, runId, dependencies = {}) {
    const loaded = await loadQaPostgres(root, runId), {owner, paths} = loaded;
    const observe = dependencies.observeProcess ?? observePostgresProcess, listen = dependencies.listener ?? postgresListener;
    const proof = {files: false, process: false, pidFile: false, listener: false, sql: false, sqlState: 'not-probed',
        leaseValid: Date.now() < Date.parse(owner.expiresAt)};
    let current, pid, listener;
    try {
        if (loaded.receipt.initialization?.cleanup?.noLiveDescendants !== true || loaded.receipt.initialization?.leaderReaped !== true)
            return {...loaded, ownership: 'unknown', ready: false, proof, reason: 'QA_INIT_CLEANUP_UNKNOWN'};
        if (!Number.isSafeInteger(owner.postgresPid) || !owner.postgresIdentity) {
            if (!owner.launchAttempted && !await pidFile(paths) && (await listen(owner.port)).state === 'absent')
                return {...loaded, ownership: 'stopped', ready: false, proof, reason: null};
            return {...loaded, ownership: 'unknown', ready: false, proof, reason: 'QA_LAUNCH_NOT_RECORDED'};
        }
        current = await observe(owner.postgresPid);
        pid = await pidFile(paths);
        listener = await listen(owner.port);
        const oldProcessGone = current.state === 'absent' || current.state === 'observed' && current.identity.birth !== owner.postgresIdentity.birth;
        if (oldProcessGone && !pid && listener.state !== 'unknown' && !listener.pids.includes(owner.postgresPid))
            return {...loaded, ownership: 'stopped', ready: false, proof, reason: null};
        await privateQaDirectory(paths.data);
        await assertPostgresBinaries(owner);
        const hashes = await postgresConfigurationHashes(paths.data);
        proof.files = !!owner.configurationHashes && Object.keys(hashes).every(name => hashes[name] === owner.configurationHashes[name])
            && hashes['postgresql.conf'] === owner.configurationSha256;
        proof.process = current.state === 'observed' && sameIdentity(current.identity, owner.postgresIdentity)
            && current.identity.executable === owner.binaries.postgres.path && current.identity.cwd === paths.data
            && current.identity.command === owner.binaries.postgres.path + ' -D ' + paths.data;
        const birth = Date.parse(owner.postgresIdentity.birth + ' UTC') / 1000;
        proof.pidFile = !!pid && pid.pid === owner.postgresPid && pid.directory === paths.data && pid.port === owner.port
            && Number.isFinite(birth) && Number.isFinite(pid.started) && Math.abs(pid.started - birth) <= 2;
        proof.listener = listener.state === 'observed' && listener.pids.length === 1 && listener.pids[0] === owner.postgresPid;
        if (!proof.files || !proof.process || !proof.pidFile || !['observed', 'absent'].includes(listener.state)
            || listener.state === 'observed' && !proof.listener) return {...loaded, ownership: 'unknown', ready: false, proof, reason: 'QA_OWNERSHIP_UNKNOWN'};
        if (pid.status === 'ready' && proof.listener) {
            try {
                proof.sql = (await (dependencies.probeSql ?? probePostgresSql)(root, owner, loaded.connection)).matches === true;
                proof.sqlState = proof.sql ? 'matched' : 'mismatch';
            } catch (error) { proof.sql = false; proof.sqlState = postgresSqlErrorState(error); }
        }
        if (proof.sqlState === 'mismatch') return {...loaded, ownership: 'unknown', ready: false, proof, reason: 'QA_SQL_MISMATCH'};
        const finalProcess = await observe(owner.postgresPid);
        if (finalProcess.state !== 'observed' || !sameIdentity(finalProcess.identity, owner.postgresIdentity))
            return {...loaded, ownership: 'unknown', ready: false, proof: {...proof, process: false}, reason: 'QA_OWNERSHIP_UNKNOWN'};
        proof.leaseValid = Date.now() < Date.parse(owner.expiresAt);
        return {...loaded, ownership: 'owned', ready: proof.sql && proof.leaseValid, proof,
            reason: !proof.leaseValid ? 'QA_LEASE_EXPIRED' : proof.sql ? null : 'QA_POSTGRES_NOT_READY'};
    } catch (error) { return {...loaded, ownership: 'unknown', ready: false, proof, reason: codeOf(error, 'QA_OWNERSHIP_UNKNOWN')}; }
}

/** Public observations contain neither the private URL nor the loaded nonce or credentials. */
export function publicQaPostgres(observed) {
    const leaseValid = Date.now() < Date.parse(observed.owner.expiresAt);
    return {kind, runId: observed.owner.runId, status: observed.receipt.status, ownership: observed.ownership,
        ready: observed.ready && leaseValid, reason: observed.ready && !leaseValid ? 'QA_LEASE_EXPIRED' : observed.reason,
        proof: {...observed.proof, leaseValid}, port: observed.owner.port,
        receipt: observed.paths.receipt, connectionFile: observed.paths.connection, dataRetained: true};
}

async function saveReceipt(paths, receipt, status) {
    receipt.status = status;
    receipt.updatedAt = new Date().toISOString();
    await saveQaJson(paths.receipt, receipt);
}

/** Close has no lease gate and sends no signal until fresh multi-axis ownership has been proven. */
export async function closeQaPostgres(root, runId, {signal, timeoutMs = 15000, ...dependencies} = {}) {
    let observed = await inspectQaPostgres(root, runId, dependencies);
    const {paths, receipt, owner} = observed;
    if (observed.ownership === 'stopped') { receipt.stoppedAt ??= new Date().toISOString(); await saveReceipt(paths, receipt, 'closed'); return {...publicQaPostgres(observed), status: 'closed', stopped: true}; }
    if (observed.ownership !== 'owned') {
        receipt.recoveryErrors.push({code: 'QA_OWNERSHIP_UNKNOWN'});
        await saveReceipt(paths, receipt, 'unknown');
        throw new QaPostgresError('QA_OWNERSHIP_UNKNOWN', 'Ownership is unknown; no signal or deletion was attempted.');
    }
    await saveReceipt(paths, receipt, 'closing');
    const fresh = await (dependencies.observeProcess ?? observePostgresProcess)(owner.postgresPid);
    if (fresh.state !== 'observed' || !sameIdentity(fresh.identity, owner.postgresIdentity)) {
        receipt.recoveryErrors.push({code: 'QA_OWNERSHIP_UNKNOWN'});
        await saveReceipt(paths, receipt, 'unknown');
        throw new QaPostgresError('QA_OWNERSHIP_UNKNOWN');
    }
    try { (dependencies.sendSignal ?? process.kill)(owner.postgresPid, 'SIGINT'); }
    catch (error) {
        if (error.code !== 'ESRCH') {
            receipt.recoveryErrors.push({code: 'QA_POSTGRES_STOP_UNKNOWN'});
            await saveReceipt(paths, receipt, 'unknown');
            throw new QaPostgresError('QA_POSTGRES_STOP_UNKNOWN');
        }
    }
    const deadline = Date.now() + timeoutMs;
    do {
        observed = await inspectQaPostgres(root, runId, dependencies);
        if (observed.ownership === 'stopped') {
            receipt.stoppedAt = new Date().toISOString();
            await saveReceipt(paths, receipt, 'closed');
            return {...publicQaPostgres(observed), status: 'closed', stopped: true};
        }
        if (signal?.aborted) break;
        await delay(50);
    } while (Date.now() < deadline);
    receipt.recoveryErrors.push({code: 'QA_POSTGRES_STOP_UNKNOWN'});
    await saveReceipt(paths, receipt, 'unknown');
    throw new QaPostgresError('QA_POSTGRES_STOP_UNKNOWN', 'Shutdown could not be proven; data and recovery evidence were retained.');
}

/** Create one private cluster with explicit binaries; startup failure never signals an unproven process. */
export async function createQaPostgres(root, options, {signal, environment = process.env, startupTimeoutMs = 15000, ...dependencies} = {}) {
    assertPostgresFlag(environment, 'create');
    if (!['darwin', 'linux'].includes(process.platform)) throw new QaPostgresError('QA_UNSUPPORTED_PLATFORM');
    const plan = await planQaPostgres(root, options, dependencies), runId = randomUUID(), paths = postgresPaths(root, runId);
    await createRunDirectory(root, paths);
    const startedAt = new Date().toISOString(), password = randomBytes(32).toString('base64url'), port = await allocatePort();
    const owner = {schemaVersion: 1, kind, runId, workspaceRoot: root, runDirectory: paths.directory, dataDirectory: paths.data,
        binDirectory: options.binDirectory, binaries: plan.binaries, nonce: randomBytes(16).toString('hex'), port,
        startedAt, leaseSeconds: options.leaseSeconds, expiresAt: new Date(Date.parse(startedAt) + options.leaseSeconds * 1000).toISOString(),
        postgresPid: null, postgresIdentity: null, configurationSha256: null, configurationHashes: null, launchAttempted: false};
    const connection = {schemaVersion: 1, kind, ownerFile: paths.owner, nonce: owner.nonce, dataDirectory: paths.data,
        adminUrl: 'postgresql://qa_owner:' + password + '@127.0.0.1:' + port + '/postgres'};
    const receipt = {schemaVersion: 1, kind, runId, startedAt, status: 'preparing', version: postgresVersion,
        port, leaseSeconds: options.leaseSeconds, expiresAt: owner.expiresAt, dataRetained: true,
        failure: null, recoveryErrors: [], postgresPid: null, stoppedAt: null};
    let initializationAttempted = false;
    try {
        await saveReceipt(paths, receipt, 'preparing');
        await saveQaJson(paths.owner, owner); await saveQaJson(paths.connection, connection);
        await fs.writeFile(paths.password, password + '\n', {flag: 'wx', mode: 0o600});
        await assertPostgresBinaries(owner);
        await saveReceipt(paths, receipt, 'initializing');
        initializationAttempted = true;
        receipt.initialization = await (dependencies.initialize ?? initializePostgres)(owner, paths, {signal});
        if (receipt.initialization?.ok !== true || receipt.initialization?.cleanup?.noLiveDescendants !== true || receipt.initialization?.leaderReaped !== true)
            throw new QaPostgresError('QA_POSTGRES_INIT_FAILED');
        await privateQaDirectory(paths.data);
        const configuration = path.join(paths.data, 'postgresql.conf');
        await fs.appendFile(configuration, '\n# Private opt-in Neurocenter QA fixture\nlisten_addresses = \'127.0.0.1\'\nport = ' + port
            + '\nunix_socket_directories = \'\'\npassword_encryption = \'scram-sha-256\'\nfsync = on\nfull_page_writes = on\n'
            + 'neurocenter_qa.nonce = \'' + owner.nonce + '\'\n');
        owner.configurationSha256 = sha256(await readQaFile(configuration));
        owner.configurationHashes = await postgresConfigurationHashes(paths.data);
        await saveQaJson(paths.owner, owner);
        await assertPostgresBinaries(owner);
        if (signal?.aborted) throw new QaPostgresError('QA_CANCELLED');
        owner.launchAttempted = true;
        await saveQaJson(paths.owner, owner);
        await saveReceipt(paths, receipt, 'starting');
        owner.postgresPid = await (dependencies.launch ?? launchPostgres)(owner, paths.log);
        receipt.postgresPid = owner.postgresPid;
        await saveQaJson(paths.owner, owner);
        const deadline = Date.now() + startupTimeoutMs;
        do {
            const processState = await (dependencies.observeProcess ?? observePostgresProcess)(owner.postgresPid);
            if (processState.state === 'observed') { owner.postgresIdentity = processState.identity; await saveQaJson(paths.owner, owner); break; }
            if (signal?.aborted) throw new QaPostgresError('QA_CANCELLED');
            await delay(25);
        } while (Date.now() < deadline);
        if (!owner.postgresIdentity) throw new QaPostgresError('QA_POSTGRES_START_UNKNOWN');
        let observed;
        do {
            if (signal?.aborted) throw new QaPostgresError('QA_CANCELLED');
            observed = await inspectQaPostgres(root, runId, dependencies);
            if (observed.ready) {
                await saveReceipt(paths, receipt, 'ready');
                if (Date.now() >= Date.parse(owner.expiresAt)) throw new QaPostgresError('QA_LEASE_EXPIRED');
                return {...publicQaPostgres(observed), status: 'ready'};
            }
            if (observed.ownership === 'stopped') throw new QaPostgresError('QA_POSTGRES_START_FAILED');
            await delay(50);
        } while (Date.now() < deadline);
        throw new QaPostgresError('QA_POSTGRES_START_UNKNOWN', 'Startup readiness was not proven within the budget.');
    } catch (error) {
        if (error.initialization) receipt.initialization = error.initialization;
        const initializationUnknown = initializationAttempted && (receipt.initialization?.cleanup?.noLiveDescendants !== true
            || receipt.initialization?.leaderReaped !== true);
        if (initializationUnknown) receipt.recoveryErrors.push({code: 'QA_INIT_CLEANUP_UNKNOWN'});
        receipt.failure ??= {code: codeOf(error, 'QA_POSTGRES_CREATE_FAILED')};
        try { await saveReceipt(paths, receipt, 'failed'); } catch { /* Disk failure cannot guarantee a terminal receipt. */ }
        if (owner.postgresPid && owner.postgresIdentity) {
            try { await closeQaPostgres(root, runId, {...dependencies, timeoutMs: 5000}); }
            catch (cleanupError) { receipt.recoveryErrors.push({code: codeOf(cleanupError, 'QA_POSTGRES_STOP_UNKNOWN')}); }
        }
        const current = await readQaJson(paths.receipt).catch(() => null);
        if (current?.status === 'closed') receipt.stoppedAt = current.stoppedAt;
        try { await saveReceipt(paths, receipt, receipt.stoppedAt ? 'failed' : owner.postgresPid || initializationUnknown ? 'unknown' : 'failed'); } catch {}
        return {kind, runId, status: receipt.status, ready: false, failure: receipt.failure, receipt: paths.receipt,
            connectionFile: paths.connection, dataRetained: true};
    }
}
