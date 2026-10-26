import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {devProcessIdentity} from './dev-processes.mjs';
import {stopWatchGroup, groupAlive} from './dev-watch-owned.mjs';
import {inspectLaunchBirth as inspectBirth, inspectLaunchProcess} from './dev-launch-inspection.mjs';
import {recoverDevLaunch} from './dev-launch-recovery.mjs';
export {inspectLaunchProcess};

export const launchServices = ['bridge', 'catalog', 'flags', 'skills', 'rag', 'gateway', 'frontend', 'snapshot-verifier'];
export const isLaunchId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error(code), {code});
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const cancellation = signal => signal.reason instanceof Error && signal.reason.code === 'ECANCELED' ? signal.reason
    : Object.assign(failure('ECANCELED'), {signal: signal.reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT'});
const checkCancellation = signal => { if (signal?.aborted) throw cancellation(signal); };

export function launchProvenanceEnabled(environment = process.env) {
    const value = environment.NEUROCENTER_DEV_LAUNCH_PROVENANCE ?? '1';
    if (!['0', '1'].includes(value)) throw failure('DEV_LAUNCH_INVALID_FLAG');
    return value === '1';
}

async function privateDirectory(directory, create = true) {
    if (create) await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory
        || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) throw failure('DEV_LAUNCH_UNSAFE_PATH');
}

async function privateMetadata(filename) {
    let before;
    try { before = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024
        || (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()) throw failure('DEV_LAUNCH_UNSAFE_INDEX');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await handle.stat(), bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await handle.stat(), selected = await fs.lstat(filename);
        if (![opened, after, selected].every(info => same(info, before) && info.size === before.size && info.mtimeMs === before.mtimeMs
            && info.ctimeMs === before.ctimeMs && info.nlink === 1 && info.mode === before.mode) || offset !== before.size) throw failure('DEV_LAUNCH_UNSAFE_INDEX');
        let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw failure('DEV_LAUNCH_UNSAFE_INDEX'); }
        return {value, filename, dev: before.dev, ino: before.ino, contentSha256: sha(bytes)};
    } finally { await handle.close(); }
}

async function currentIndex(root, service) {
    if (!launchServices.includes(service)) throw failure('DEV_LAUNCH_INVALID_ARGUMENT');
    const directory = path.join(root, '.run/dev-launches', service), filename = path.join(directory, 'current.json');
    try { await privateDirectory(path.dirname(directory), false); await privateDirectory(directory, false); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const result = await privateMetadata(filename);
    if (!result) return null;
    if (result.value?.schemaVersion !== 1 || !isLaunchId(result.value.launchId)) throw failure('DEV_LAUNCH_UNSAFE_INDEX');
    return {...result, launchId: result.value.launchId};
}

/** Serialize publication/rollback; stale locks fail closed and are never reclaimed automatically. */
async function indexTransaction(root, service) {
    const directory = path.join(root, '.run/dev-launches', service), filename = path.join(directory, 'index.lock');
    await privateDirectory(path.dirname(directory)); await privateDirectory(directory);
    const owner = inspectBirth(process.pid);
    if (owner.state !== 'observed') throw failure('DEV_LAUNCH_INDEX_UNKNOWN');
    {
        let handle;
        try { handle = await fs.open(filename, 'wx', 0o600); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const previous = await privateMetadata(filename), value = previous?.value;
            if (!previous || !Number.isSafeInteger(value?.pid) || !isLaunchId(value.nonce) || typeof value.birth !== 'string') throw failure('DEV_LAUNCH_INDEX_UNKNOWN');
            const observed = inspectBirth(value.pid);
            if (observed.state === 'unknown') throw failure('DEV_LAUNCH_INDEX_UNKNOWN');
            if (observed.state === 'observed' && observed.birth === value.birth) throw failure('DEV_LAUNCH_INDEX_BUSY');
            throw failure('DEV_LAUNCH_LOCK_STALE');
        }
        const nonce = randomUUID();
        let closed = false;
        try { await handle.writeFile(JSON.stringify({pid: process.pid, birth: owner.birth, nonce}) + '\n'); }
        catch (error) {
            const owned = await handle.stat(); await handle.close(); closed = true;
            const selected = await fs.lstat(filename);
            if (same(selected, owned) && selected.isFile() && selected.nlink === 1) await fs.unlink(filename);
            throw error;
        } finally { if (!closed) await handle.close(); }
        const retained = await privateMetadata(filename);
        if (retained?.value.nonce !== nonce) throw failure('DEV_LAUNCH_INDEX_CHANGED');
        return async () => {
            const selected = await privateMetadata(filename);
            if (!selected || !same(selected, retained) || selected.contentSha256 !== retained.contentSha256) throw failure('DEV_LAUNCH_INDEX_CHANGED');
            await fs.unlink(filename);
        };
    }
}

async function restoreIndex(root, service, launchId, previous) {
    const current = await currentIndex(root, service);
    if (current?.launchId !== launchId) return;
    // A different publisher's UUID is never replaced, even if it bypassed this launcher's lock.
    const fresh = await currentIndex(root, service);
    if (!fresh || !same(fresh, current) || fresh.contentSha256 !== current.contentSha256) return;
    if (previous) await saveLaunchReceipt(current.filename, previous.value);
    else await fs.unlink(current.filename);
}

/** The fixed service index chooses a basename; callers never supply a receipt or log path. */
export async function currentDevLaunchId(root, service) { return (await currentIndex(root, service))?.launchId ?? null; }

export async function saveLaunchReceipt(filename, value) {
    const temporary = path.join(path.dirname(filename), '.' + path.basename(filename) + '.' + randomUUID());
    try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600}); await fs.rename(temporary, filename); }
    finally { await fs.rm(temporary, {force: true}); }
}

async function entryDigest(entry) {
    if (!path.isAbsolute(entry) || await fs.realpath(path.dirname(entry)) !== path.dirname(entry)) throw failure('DEV_LAUNCH_UNSAFE_ENTRY');
    const before = await fs.lstat(entry);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 32 * 1024 ** 2) throw failure('DEV_LAUNCH_UNSAFE_ENTRY');
    const file = await fs.open(entry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await file.stat(), bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await file.stat(), selected = await fs.lstat(entry);
        if (![opened, after, selected].every(info => same(info, before) && info.size === before.size && info.mtimeMs === before.mtimeMs && info.ctimeMs === before.ctimeMs)
            || offset !== before.size) throw failure('DEV_LAUNCH_ENTRY_CHANGED');
        return sha(bytes);
    } finally { await file.close(); }
}

function waitForAcknowledgement(child, launchId, nonce, {signal, timeoutMs}) {
    return new Promise((resolve, reject) => {
        const finish = (error, message) => { clearTimeout(timer); child.off('message', messageReceived); child.off('error', failed); child.off('exit', exited); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(message); };
        const messageReceived = message => { if (message?.kind === 'dev-launch-ack' && message.launchId === launchId && message.nonce === nonce && Number.isSafeInteger(message.pid) && message.pid > 0) finish(null, message); };
        const failed = () => finish(failure('DEV_LAUNCH_FAILED')), exited = () => finish(failure('DEV_LAUNCH_EXITED'));
        const aborted = () => finish(cancellation(signal));
        const timer = setTimeout(() => finish(failure('DEV_LAUNCH_ACK_MISSING')), timeoutMs);
        child.on('message', messageReceived); child.once('error', failed); child.once('exit', exited); signal?.addEventListener('abort', aborted, {once: true});
        if (signal?.aborted) aborted();
    });
}

function detachOwner(child) {
    return new Promise((resolve, reject) => {
        const done = error => { clearTimeout(timer); child.off('disconnect', disconnected); child.off('exit', exited); error ? reject(error) : resolve(); };
        const disconnected = () => done(), exited = () => done(failure('DEV_LAUNCH_EXITED'));
        const timer = setTimeout(() => done(failure('DEV_LAUNCH_DETACH_FAILED')), 2000);
        child.once('disconnect', disconnected); child.once('exit', exited);
        child.send({kind: 'detach-parent'}, error => { if (error) done(error); });
    });
}

/** Spawn one owned service; the service ACK, OS identity and checked log FD precede publication. */
export async function launchDevService({root, node, service, entry, environment, logDir, generation = null, sourceSha256 = null,
    wrapper = false, signal, onOwner, acknowledgeTimeoutMs = 5000, identifyOwner = devProcessIdentity, inspectProcess = inspectLaunchProcess, save = saveLaunchReceipt}) {
    if (!launchServices.includes(service.name) || !path.isAbsolute(root) || await fs.realpath(root) !== root) throw failure('DEV_LAUNCH_INVALID_ARGUMENT');
    const enabled = launchProvenanceEnabled(environment), launchId = enabled ? randomUUID() : null, ownerNonce = randomUUID();
    const logFile = path.join(logDir, 'neurocenter-' + service.name + (launchId ? '-' + launchId : '') + '.log');
    const cwd = await fs.realpath(path.join(root, service.dir)), startedAt = new Date().toISOString();
    const directory = path.join(root, '.run/dev-launches', service.name), filename = launchId && path.join(directory, launchId + '.json');
    const digest = enabled ? await entryDigest(entry) : null;
    if (enabled) { await privateDirectory(path.join(root, '.run/dev-launches')); await privateDirectory(directory); }
    const log = await fs.open(logFile, enabled ? 'wx' : 'a', 0o600);
    let child, record, acknowledgement, releaseIndex, previousIndex, serviceExit, logClosed = false;
    const childEnvironment = {...environment};
    // Caller labels cannot impersonate a launcher-created generation, including when recording is disabled.
    delete childEnvironment.NEUROCENTER_DEV_LAUNCH_ID; delete childEnvironment.NEUROCENTER_DEV_LAUNCH_ACK; delete childEnvironment.NEUROCENTER_DEV_OWNER_NONCE;
    if (enabled) childEnvironment.NEUROCENTER_DEV_LAUNCH_ID = launchId;
    childEnvironment.NEUROCENTER_DEV_LAUNCH_ACK = '1'; childEnvironment.NEUROCENTER_DEV_OWNER_NONCE = ownerNonce;
    childEnvironment.NODE_OPTIONS = [environment.NODE_OPTIONS, '--import=' + pathToFileURL(path.join(root, 'scripts/workspace/dev-launch-ack.mjs')).href].filter(Boolean).join(' ');
    try {
        const index = await currentIndex(root, service.name);
        if (enabled || index) { releaseIndex = await indexTransaction(root, service.name); previousIndex = await currentIndex(root, service.name); }
        checkCancellation(signal);
        child = spawn(node, [path.join(root, 'scripts/workspace/dev-watch-child.mjs')], {cwd,
            env: {PATH: path.dirname(node) + path.delimiter + '/usr/bin:/bin'}, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc']});
        child.on('message', value => { if (value?.kind === 'dev-service-exit' && Number.isSafeInteger(value.pid)
            && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255) serviceExit = value.exitCode; });
        acknowledgement = waitForAcknowledgement(child, launchId, ownerNonce, {signal, timeoutMs: acknowledgeTimeoutMs});
        // Attach rejection handling immediately; the spawn event may precede the awaited acknowledgement.
        acknowledgement?.catch(() => {});
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        record = {name: service.name, pid: child.pid, identity: identifyOwner(child.pid)};
        const spawnedOwner = inspectBirth(child.pid);
        if (!record.identity || spawnedOwner.state !== 'observed' || spawnedOwner.pgid !== child.pid) throw failure('DEV_LAUNCH_PROCESS_IDENTITY');
        onOwner?.(record);
        checkCancellation(signal);
        child.send({kind: 'run', args: [entry], environment: childEnvironment});
        const ack = await acknowledgement;
        const actual = inspectProcess(ack.pid), owner = inspectBirth(child.pid), file = await log.stat(), selected = await fs.lstat(logFile);
        if (!same(file, selected) || !file.isFile() || !selected.isFile() || file.nlink !== 1 || enabled && (file.mode & 0o777) !== 0o600)
            throw failure('DEV_LAUNCH_LOG_CHANGED');
        if (actual.state !== 'observed' || actual.cwd !== cwd || actual.pgid !== child.pid || !/^[a-f0-9]{64}$/.test(actual.commandSha256 ?? '')
            || actual.outputs.length !== 2 || actual.outputs.some(item => !item || !same(item, file))) throw failure('DEV_LAUNCH_PROCESS_IDENTITY');
        record.serviceWitness = {schemaVersion: 1, pid: actual.pid, birth: actual.birth, pgid: actual.pgid, ownerBirth: spawnedOwner.birth,
            directory: service.dir, entry: path.relative(root, entry).split(path.sep).join('/'), commandSha256: actual.commandSha256, log: {dev: file.dev, ino: file.ino}};
        if (owner.state !== 'observed' || owner.birth !== spawnedOwner.birth || actual.ppid !== child.pid) throw failure('DEV_LAUNCH_PROCESS_IDENTITY');
        if (enabled) {
            const launcher = inspectBirth(process.pid);
            if (launcher.state !== 'observed') throw failure('DEV_LAUNCH_PROCESS_IDENTITY');
            if (await entryDigest(entry) !== digest) throw failure('DEV_LAUNCH_ENTRY_CHANGED');
            checkCancellation(signal);
            const receipt = {schemaVersion: 1, kind: 'neurocenter-dev-launch', service: service.name, launchId,
                generation: isLaunchId(generation) ? generation : null, entryDigest: digest, sourceSha256: /^[a-f0-9]{64}$/.test(sourceSha256 ?? '') ? sourceSha256 : null,
                startedAt, launcher: {pid: process.pid, birth: launcher.birth}, owner: {pid: owner.pid, birth: owner.birth},
                process: {pid: actual.pid, birth: actual.birth, cwd: actual.cwd},
                log: {path: path.relative(root, logFile), dev: file.dev, ino: file.ino}};
            await save(filename, receipt); checkCancellation(signal);
            await save(path.join(directory, 'current.json'), {schemaVersion: 1, launchId}); checkCancellation(signal);
            record.launchId = launchId; record.servicePid = actual.pid;
        } else { const current = await currentIndex(root, service.name);
            if (current && (!previousIndex || !same(current, previousIndex) || current.contentSha256 !== previousIndex.contentSha256)) throw failure('DEV_LAUNCH_INDEX_CHANGED');
            if (current) await fs.unlink(current.filename); }
        const finalFile = await log.stat(), finalSelected = await fs.lstat(logFile), finalActual = inspectProcess(actual.pid), finalOwner = inspectBirth(owner.pid);
        if (!same(finalFile, file) || !same(finalSelected, file) || !finalSelected.isFile() || finalFile.nlink !== 1
            || enabled && (finalFile.mode & 0o777) !== 0o600) throw failure('DEV_LAUNCH_LOG_CHANGED');
        if (finalActual.state !== 'observed' || finalOwner.state !== 'observed' || finalActual.birth !== actual.birth || finalOwner.birth !== owner.birth
            || finalActual.pgid !== child.pid || finalActual.commandSha256 !== actual.commandSha256 || finalActual.cwd !== cwd
            || finalActual.outputs.length !== 2 || finalActual.outputs.some(item => !item || !same(item, file))) throw failure('DEV_LAUNCH_PROCESS_IDENTITY');
        if (!wrapper) await detachOwner(child);
        checkCancellation(signal);
        await log.close(); logClosed = true;
        if (releaseIndex) { await releaseIndex(); releaseIndex = null; }
        return {child, record, logFile, launchId};
    } catch (error) {
        try { if (child?.pid) {
            if (record?.identity) { if (groupAlive(record.pid)) {
                if (record.serviceWitness && inspectBirth(record.pid).state === 'ended') {
                    if ((await recoverDevLaunch(root, record, service)).state === 'unknown') throw failure('DEV_LAUNCH_PROCESS_CLEANUP');
                } else await stopWatchGroup(record);
            } }
            else { try { child.kill('SIGKILL'); } catch {} }
            if (child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
                const exited = () => { clearTimeout(timer); resolve(); };
                const timer = setTimeout(() => { child.off('exit', exited); reject(failure('DEV_LAUNCH_PROCESS_CLEANUP')); }, 2000);
                child.once('exit', exited);
            });
        } } finally {
            if (enabled && releaseIndex) await restoreIndex(root, service.name, launchId, previousIndex);
        }
        const exitCode = serviceExit ?? child?.exitCode;
        if (error.code !== 'ECANCELED') error.message = (service.label ?? service.name) + (service.port ? ' (:' + service.port + ')' : '')
            + ' не запущен: ' + (error.code ?? 'DEV_LAUNCH_FAILED') + (exitCode !== null && exitCode !== undefined ? ', код ' + exitCode : '') + '. Лог: ' + logFile;
        throw error;
    } finally { try { if (releaseIndex) await releaseIndex(); } finally { if (!logClosed) await log.close(); } }
}
