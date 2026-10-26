import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const postgresVersion = '16.15';
export const defaultLeaseSeconds = 3600;
export const maximumLeaseSeconds = 14400;
export const postgresBinaries = ['initdb', 'pg_ctl', 'postgres'];
export const postgresHelp = `Opt-in PostgreSQL 16.15 QA fixture (existing binaries and Catalog pg dependency only).
  node scripts/qa/postgres.mjs plan --bin-dir <absolute-directory> [--lease-seconds <1..14400>]
  node scripts/qa/postgres.mjs create --bin-dir <absolute-directory> [--lease-seconds <1..14400>]
  node scripts/qa/postgres.mjs inspect --run <uuid>
  node scripts/qa/postgres.mjs close --run <uuid>
plan reads explicit binary identities/versions without creating a fixture. create uses a private UUID run under .run/qa-postgres.
close stops only a freshly proven owned server and retains its data/logs; it does not purge files.
NEUROCENTER_QA_POSTGRES=0 disables new create/native admission; help, plan, inspect and close remain available.
No runtime download, dependency installation, default database or production fallback.`;

export class QaPostgresError extends Error {
    constructor(code, message = code) { super(message); this.code = code; }
}

/** Admit a small command surface before reading binaries, resolving dependencies or writing directories. */
export function parsePostgresArguments(args, environment = process.env) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
    const [action, ...flags] = args;
    if (!['plan', 'create', 'inspect', 'close'].includes(action)) throw new QaPostgresError('QA_INVALID_ARGUMENT', postgresHelp);
    const options = {action}, allowed = ['plan', 'create'].includes(action) ? ['--bin-dir', '--lease-seconds'] : ['--run'];
    for (let index = 0; index < flags.length; index += 2) {
        const flag = flags[index], value = flags[index + 1], key = flag === '--bin-dir' ? 'binDirectory' : flag === '--lease-seconds' ? 'leaseSeconds' : 'runId';
        if (!allowed.includes(flag) || Object.hasOwn(options, key) || typeof value !== 'string' || !value || value.startsWith('--'))
            throw new QaPostgresError('QA_INVALID_ARGUMENT', 'Use one explicit value for each supported option.');
        options[key] = value;
    }
    if (['plan', 'create'].includes(action)) {
        if (!options.binDirectory || !path.isAbsolute(options.binDirectory) || path.resolve(options.binDirectory) !== options.binDirectory)
            throw new QaPostgresError('QA_INVALID_ARGUMENT', '--bin-dir must be an absolute canonical directory.');
        const seconds = options.leaseSeconds ?? String(defaultLeaseSeconds);
        if (!/^[1-9]\d*$/.test(seconds) || !Number.isSafeInteger(Number(seconds)) || Number(seconds) > maximumLeaseSeconds)
            throw new QaPostgresError('QA_INVALID_ARGUMENT', '--lease-seconds must be between 1 and 14400.');
        options.leaseSeconds = Number(seconds);
    } else if (!isRunId(options.runId)) throw new QaPostgresError('QA_INVALID_ARGUMENT', '--run must be a UUID from this checkout.');
    assertPostgresFlag(environment, action);
    return options;
}

export const isRunId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/** Disabled execution never removes access to retained evidence or owned shutdown. */
export function assertPostgresFlag(environment, action) {
    const value = environment.NEUROCENTER_QA_POSTGRES;
    if (value !== undefined && !['0', '1'].includes(value)) throw new QaPostgresError('QA_INVALID_ARGUMENT', 'NEUROCENTER_QA_POSTGRES must be 0 or 1.');
    if (['create', 'run'].includes(action) && value === '0') throw new QaPostgresError('QA_DISABLED', 'NEUROCENTER_QA_POSTGRES=0 disables new fixtures and native admission.');
}

/** Fixed paths keep CLI recovery inside one explicitly selected checkout. */
export function postgresPaths(root, runId) {
    if (!isRunId(runId)) throw new QaPostgresError('QA_INVALID_ARGUMENT');
    const directory = path.join(root, '.run/qa-postgres', runId);
    return {directory, data: path.join(directory, 'data'), owner: path.join(directory, 'owner.json'),
        connection: path.join(directory, 'connection.json'), receipt: path.join(directory, 'receipt.json'),
        password: path.join(directory, 'password.txt'), log: path.join(directory, 'postgres.log'), initLog: path.join(directory, 'initdb.log')};
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read a bounded stable file without following redirected directories, symlinks or hardlinks. */
export async function readQaFile(filename, {privateMode = false, maximumBytes = 65536} = {}) {
    if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || await fs.realpath(path.dirname(filename)) !== path.dirname(filename))
        throw new QaPostgresError('QA_UNSAFE_PATH');
    const initial = await fs.lstat(filename);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > maximumBytes
        || privateMode && ((initial.mode & 0o777) !== 0o600 || initial.uid !== process.getuid?.())) throw new QaPostgresError('QA_UNSAFE_PATH');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat(), bytes = Buffer.alloc(initial.size);
        let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await handle.stat(), selected = await fs.lstat(filename);
        if (offset !== bytes.length || [before, after, selected].some(stat => stat.dev !== initial.dev || stat.ino !== initial.ino
            || stat.size !== initial.size || stat.mtimeMs !== initial.mtimeMs || stat.ctimeMs !== initial.ctimeMs || stat.nlink !== 1))
            throw new QaPostgresError('QA_UNSAFE_PATH');
        return bytes;
    } finally { await handle.close(); }
}

export async function readQaJson(filename) {
    try { return JSON.parse((await readQaFile(filename, {privateMode: true})).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new QaPostgresError('QA_METADATA_INVALID'); throw error; }
}

/** A failed replacement leaves the previous receipt intact; secrets are always private. */
export async function saveQaJson(filename, value) {
    const temporary = path.join(path.dirname(filename), '.' + path.basename(filename) + '.' + randomUUID() + '.tmp');
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, {force: true}).catch(() => {}); }
}

/** Existing shared .run may be public; the QA root and every run are private and never redirected. */
export async function privateQaDirectory(directory, {create = false} = {}) {
    if (create) await fs.mkdir(directory, {mode: 0o700});
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory
        || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) throw new QaPostgresError('QA_UNSAFE_PATH');
}

export async function canonicalQaRoot(root) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root || await fs.realpath(root) !== root) throw new QaPostgresError('QA_UNSAFE_PATH');
    const manifest = JSON.parse((await readQaFile(path.join(root, 'package.json'))).toString('utf8'));
    if (manifest.name !== 'neurocenter-workspace') throw new QaPostgresError('QA_WORKSPACE_INVALID');
    return root;
}
