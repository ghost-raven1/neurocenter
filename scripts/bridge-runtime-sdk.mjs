import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {createGunzip} from 'node:zlib';
import {npmCli} from './workspace/node-runtime.mjs';
import {withNpmBuildEnvironment} from './workspace/npm-build-environment.mjs';
import {opencodeVersion} from './opencode-platforms.mjs';

export const SDK_UNAVAILABLE_EXIT_CODE = 75;
export const sdkManifestPath = 'bin/opencode-sdk/manifest.json';
export const sdkSourceLockSha256 = 'c075bd972208d52ea2536408bd256a480c725584e6dcb9a23da082e155d6218a';
const repository = fileURLToPath(new URL('../', import.meta.url));
const plugin = 'node_modules/@opencode-ai/plugin', maximum = 128 * 1024 ** 2, manifestMaximum = 1024 ** 2;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const ordinal = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const safe = value => typeof value === 'string' && Buffer.byteLength(value) <= 240 && !/[\\\x00-\x1f\x7f:]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
const validTarget = value => /^(?:darwin|linux|windows)-(?:arm64|x64)$|^linux-(?:arm64|x64)-musl$/.test(value);
const unavailable = new Set(['ENOTCACHED', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT',
    'EAI_AGAIN', 'ENOTFOUND', 'FETCH_ERROR', 'E401', 'E403', 'E404', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED']);
const lockEntries = lock => Object.fromEntries(Object.entries(lock.packages).filter(([name]) => name)
    .map(([name, entry]) => [name === plugin || name.startsWith(plugin + '/') ? name : plugin + '/' + name, entry]));
const selected = (entry, target) => {
    const [platform, cpu, libc = 'glibc'] = target.split('-'), os = platform === 'windows' ? 'win32' : platform;
    const accepts = (values, value) => !values || !values.includes('!' + value) && (values.includes('any') || !values.some(item => !item.startsWith('!')) || values.includes(value));
    return !entry.optional || accepts(entry.os, os) && accepts(entry.cpu, cpu) && accepts(entry.libc, libc);
};

/** Only this typed, optional prerequisite failure may defer development bridge preparation. */
export class SdkUnavailableError extends Error {
    constructor(reason) { super(`OpenCode SDK недоступен (${reason}); прежняя поставка сохранена.`); this.code = 'SDK_UNAVAILABLE'; this.reason = reason; }
}

/** The checked source lock is a build input, never a user profile or generated empty lock. */
export async function readBridgeSdkLock(root = repository) {
    const filename = path.join(root, 'scripts/bridge-opencode-sdk-lock.json'), info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > manifestMaximum) throw Error('Некорректный исходный lock OpenCode SDK.');
    const bytes = await fs.readFile(filename);
    if (sha(bytes) !== sdkSourceLockSha256) throw Error('SHA-256 исходного lock OpenCode SDK не совпала.');
    const lock = JSON.parse(bytes);
    if (lock.lockfileVersion !== 3 || lock.packages?.['']?.dependencies?.['@opencode-ai/plugin'] !== opencodeVersion
        || lock.packages?.[plugin]?.version !== opencodeVersion) throw Error('Версия исходного lock OpenCode SDK не совпала.');
    return {bytes, lock};
}

/** Exact inventory and version bounds are shared by the new producer and its candidate verifier. */
export function validateBridgeSdkManifest(value, target) {
    if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'package', 'version', 'openCodeVersion', 'layout', 'target', 'sourceLockSha256', 'filesCount', 'bytes', 'files'].includes(key))
        || value.schemaVersion !== 1 || value.package !== '@opencode-ai/plugin' || value.version !== opencodeVersion || value.openCodeVersion !== opencodeVersion
        || value.layout !== 'nested-v1' || !validTarget(target) || value.target !== target || value.sourceLockSha256 !== sdkSourceLockSha256
        || !Array.isArray(value.files) || !value.files.length || value.files.length > 6000 || value.filesCount !== value.files.length
        || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > maximum) throw Error('Некорректная опись OpenCode SDK.');
    let total = 0, previous = ''; const seen = new Set();
    for (const file of value.files) {
        if (!object(file) || Object.keys(file).some(key => !['path', 'size', 'sha256'].includes(key)) || !safe(file.path)
            || !(file.path.startsWith('package/') || ['source-lock.json', 'lock-entries.json'].includes(file.path))
            || ordinal(previous, file.path) >= 0 || seen.has(file.path.normalize('NFC').toLowerCase())
            || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw Error('Некорректный файл описи OpenCode SDK.');
        previous = file.path; seen.add(file.path.normalize('NFC').toLowerCase()); total += file.size;
    }
    if (total !== value.bytes || !['package/package.json', 'source-lock.json', 'lock-entries.json'].every(name => seen.has(name))
        || value.files.find(file => file.path === 'source-lock.json').sha256 !== sdkSourceLockSha256) throw Error('Неполная опись OpenCode SDK.');
    return value;
}

async function inventory(directory, prefix = '', result = []) {
    for (const name of (await fs.readdir(path.join(directory, prefix))).sort(ordinal)) {
        const relative = prefix ? prefix + '/' + name : name, filename = path.join(directory, relative), info = await fs.lstat(filename);
        if (!safe(relative) || info.isSymbolicLink()) throw Error('Недопустимый путь OpenCode SDK.');
        if (info.isDirectory()) await inventory(directory, relative, result);
        else {
            if (!info.isFile() || info.nlink !== 1 || info.size > maximum || result.length >= 6000) throw Error('Недопустимый файл OpenCode SDK.');
            const bytes = await fs.readFile(filename); result.push({path: relative, size: bytes.length, sha256: sha(bytes)});
        }
    }
    return result.sort((a, b) => ordinal(a.path, b.path));
}

/** Network/cache failures use npm's structured error code; integrity, cancellation and arbitrary output stay fatal. */
async function npmRun(run, npm, args, options) {
    try { return await run(process.execPath, [npm, ...args, '--json', '--loglevel=error'], {...options, encoding: 'utf8', stdio: 'pipe', timeout: 120000, maxBuffer: 8 * manifestMaximum}); }
    catch (error) {
        if (!error.signal && Number.isInteger(error.status)) {
            let code; try { code = JSON.parse(String(error.stdout || '')).error?.code; } catch { /* Not a structured npm error. */ }
            if (unavailable.has(code)) throw new SdkUnavailableError(code === 'ENOTCACHED' ? 'cache-miss' : 'registry-unavailable');
        }
        throw Error('Подготовка OpenCode SDK не завершена: ошибка установки или проверки зависимостей.');
    }
}

/** Build one complete nested SDK in the owned packaging stage, without changing bridge or profile dependencies. */
export async function packageBridgeOpenCodeSdk({root = repository, content, stage, target}, {run = execFileSync, environment = process.env} = {}) {
    if (!validTarget(target)) throw Error('Неизвестная целевая платформа OpenCode SDK.');
    const {bytes, lock} = await readBridgeSdkLock(root);
    let npm; try { npm = npmCli(environment); } catch { throw new SdkUnavailableError('missing-npm'); }
    const install = path.join(stage, 'sdk-install'), seed = path.join(content, 'bin/opencode-sdk');
    await fs.mkdir(install);
    try {
        await fs.writeFile(path.join(install, 'package.json'), JSON.stringify({...lock.packages[''], private: true}) + '\n', {flag: 'wx'});
        await fs.writeFile(path.join(install, 'package-lock.json'), bytes, {flag: 'wx'});
        await withNpmBuildEnvironment(environment, async ({env, args}) => {
            const options = {cwd: install, env: {...env, PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH || ''), npm_config_update_notifier: 'false'}};
            await npmRun(run, npm, ['ci', '--ignore-scripts', '--omit=dev', '--include=optional', '--no-bin-links', '--no-audit', '--no-fund', ...args], options);
            await npmRun(run, npm, ['ls', '--offline', '--all', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...args], options);
        });
        for (const [relative, entry] of Object.entries(lock.packages)) {
            if (!relative) continue;
            let actual; try { actual = JSON.parse(await fs.readFile(path.join(install, relative, 'package.json'), 'utf8')); }
            catch (error) { if (error.code === 'ENOENT' && !selected(entry, target)) continue; throw error; }
            const name = relative.split('node_modules/').at(-1);
            if (actual.name !== name || actual.version !== entry.version) throw Error('Установленные зависимости OpenCode SDK не совпали с lock.');
        }
        const modules = path.join(install, 'node_modules');
        await fs.rm(path.join(modules, '.package-lock.json'), {force: true});
        await inventory(modules);
        await fs.mkdir(seed);
        await fs.cp(path.join(install, plugin), path.join(seed, 'package'), {recursive: true, errorOnExist: true, force: false});
        const nested = path.join(seed, 'package/node_modules'); await fs.mkdir(nested, {recursive: true});
        for (const name of await fs.readdir(modules)) {
            if (name === '@opencode-ai') {
                for (const scoped of await fs.readdir(path.join(modules, name))) if (scoped !== 'plugin') {
                    await fs.mkdir(path.join(nested, name), {recursive: true});
                    await fs.cp(path.join(modules, name, scoped), path.join(nested, name, scoped), {recursive: true, errorOnExist: true, force: false});
                }
            } else await fs.cp(path.join(modules, name), path.join(nested, name), {recursive: true, errorOnExist: true, force: false});
        }
        await fs.writeFile(path.join(seed, 'source-lock.json'), bytes, {flag: 'wx'});
        await fs.writeFile(path.join(seed, 'lock-entries.json'), JSON.stringify({schemaVersion: 1, packages: lockEntries(lock)}, null, 2) + '\n', {flag: 'wx'});
        const files = await inventory(seed), manifest = validateBridgeSdkManifest({schemaVersion: 1, package: '@opencode-ai/plugin', version: opencodeVersion,
            openCodeVersion: opencodeVersion, layout: 'nested-v1', target, sourceLockSha256: sdkSourceLockSha256, filesCount: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), files}, target);
        const encoded = JSON.stringify(manifest, null, 2) + '\n';
        if (Buffer.byteLength(encoded) > manifestMaximum) throw Error('Опись OpenCode SDK превышает предел.');
        if (JSON.stringify(await inventory(seed)) !== JSON.stringify(files)) throw Error('OpenCode SDK изменился во время упаковки.');
        await fs.writeFile(path.join(seed, 'manifest.json'), encoded, {flag: 'wx'});
        return manifest;
    } finally { await fs.rm(install, {recursive: true, force: true}); }
}

/** Read and hash the seed from TAR without extracting files; legacy consumers do not call this verifier. */
export async function verifyBridgeSdkArchive(filename, target, expected = {}) {
    const tar = createRequire(npmCli())('tar'), Parser = tar.Parser || tar.Parse, files = [], names = new Map(), ancestors = new Set(), captured = new Map();
    let total = 0, count = 0, seedBytes = 0, seedCount = 0, captureBytes = 0;
    const parser = new Parser({strict: true, maxMetaEntrySize: manifestMaximum});
    parser.on('entry', entry => {
        total += entry.size; count++;
        if (total > 1024 ** 3 || count > 50000) { parser.abort(Error('Архив SDK превышает предел.')); return; }
        const raw = entry.header?.path, normalized = typeof raw === 'string' ? raw.replace(/\/+$/, '') : '';
        if (raw !== entry.path || !normalized || path.posix.normalize(normalized) !== normalized || raw !== normalized && raw !== normalized + '/'
            || normalized.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(normalized) || normalized.split('/').some(part => part === '..')) { parser.abort(Error('Неоднозначный путь архива SDK.')); return; }
        const folded = normalized.normalize('NFC').toLowerCase(), segments = normalized.split('/');
        if ((folded === 'bin' || folded.startsWith('bin/')) && segments[0] !== 'bin'
            || (folded === 'bin/opencode-sdk' || folded.startsWith('bin/opencode-sdk/')) && segments[1] !== 'opencode-sdk') { parser.abort(Error('Регистр пути архива SDK неоднозначен.')); return; }
        if (['bin', 'bin/opencode-sdk'].includes(normalized) && (entry.type !== 'Directory' || entry.size !== 0)) { parser.abort(Error('Корень архива SDK занят файлом или ссылкой.')); return; }
        const prefix = 'bin/opencode-sdk/', relative = normalized === 'bin/opencode-sdk' ? '' : normalized.slice(prefix.length);
        if (normalized !== 'bin/opencode-sdk' && !normalized.startsWith(prefix)) { entry.resume(); return; }
        seedBytes += entry.size; seedCount++;
        const directory = entry.type === 'Directory', key = relative.normalize('NFC').toLowerCase();
        const parents = key.split('/').slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join('/'));
        if (seedBytes > maximum + manifestMaximum || seedCount > 12001 || !directory && entry.type !== 'File'
            || relative && !safe(relative) || names.has(key) || !directory && ancestors.has(key) || parents.some(parent => names.get(parent) === 'file')
            || directory && entry.size !== 0 || entry.size > maximum || files.length >= 6001) { parser.abort(Error('Недопустимая запись архива SDK.')); return; }
        names.set(key, directory ? 'directory' : 'file'); for (const parent of parents) ancestors.add(parent);
        if (directory) { entry.resume(); return; }
        const digest = createHash('sha256'), chunks = []; let size = 0;
        const capture = ['manifest.json', 'source-lock.json', 'lock-entries.json'].includes(relative) || relative.startsWith('package/') && relative.endsWith('/package.json');
        if (capture) captureBytes += entry.size;
        if (captureBytes > 4 * manifestMaximum || capture && entry.size > manifestMaximum) { parser.abort(Error('Метаданные архива SDK превышают предел.')); return; }
        entry.on('data', chunk => { size += chunk.length; digest.update(chunk); if (capture) chunks.push(chunk); });
        entry.on('end', () => { files.push({path: relative, size, sha256: digest.digest('hex')}); if (capture) captured.set(relative, Buffer.concat(chunks)); });
    });
    const selectedPath = await fs.lstat(filename);
    if (!selectedPath.isFile() || selectedPath.isSymbolicLink() || selectedPath.nlink !== 1 || selectedPath.size <= 0 || selectedPath.size > 1024 ** 3) throw Error('Недопустимый архив OpenCode SDK.');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.dev !== selectedPath.dev || before.ino !== selectedPath.ino || before.size !== selectedPath.size
            || before.size > 1024 ** 3 || expected.bytes !== undefined && expected.bytes !== before.size) throw Error('Недопустимый архив OpenCode SDK.');
        let compressed = 0, expanded = 0; const digest = createHash('sha256'), abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 30000); timer.unref();
        try {
            await pipeline(handle.createReadStream({autoClose: false}), new Transform({transform(chunk, _encoding, done) {
                compressed += chunk.length; digest.update(chunk); done(compressed > before.size ? Error('Архив SDK изменился во время чтения.') : undefined, chunk);
            }}), createGunzip(), new Transform({transform(chunk, _encoding, done) {
                expanded += chunk.length; done(expanded > 1024 ** 3 + 50000 * 1536 + manifestMaximum ? Error('Распакованный архив SDK превышает предел.') : undefined, chunk);
            }}), parser, {signal: abort.signal});
        } finally { clearTimeout(timer); }
        const after = await handle.stat(), currentPath = await fs.lstat(filename), actualSha = digest.digest('hex');
        if (compressed !== before.size || expected.sha256 !== undefined && expected.sha256 !== actualSha || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1
            || !currentPath.isFile() || currentPath.isSymbolicLink() || currentPath.dev !== before.dev || currentPath.ino !== before.ino) throw Error('Архив SDK изменился или не совпал с закреплёнными байтами.');
    } finally { await handle.close(); }
    const manifest = validateBridgeSdkManifest(JSON.parse(captured.get('manifest.json')?.toString('utf8') || 'null'), target);
    const actual = files.filter(file => file.path !== 'manifest.json').sort((a, b) => ordinal(a.path, b.path));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw Error('Файлы архива OpenCode SDK не совпали с описью.');
    const pkg = JSON.parse(captured.get('package/package.json')?.toString('utf8') || 'null');
    if (pkg?.name !== '@opencode-ai/plugin' || pkg.version !== opencodeVersion) throw Error('Пакет OpenCode SDK не совпал с описью.');
    const lock = JSON.parse(captured.get('source-lock.json').toString('utf8')), entries = JSON.parse(captured.get('lock-entries.json').toString('utf8'));
    if (JSON.stringify(entries) !== JSON.stringify({schemaVersion: 1, packages: lockEntries(lock)})) throw Error('Зависимости архива SDK не совпали с исходным lock.');
    for (const [name, item] of Object.entries(entries.packages)) {
        const relative = 'package' + name.slice(plugin.length) + '/package.json', bytes = captured.get(relative);
        if (!bytes && !selected(item, target)) continue;
        const actual = bytes && JSON.parse(bytes.toString('utf8'));
        if (actual?.name !== name.split('node_modules/').at(-1) || actual.version !== item.version) throw Error('Архив SDK не содержит полного набора зависимостей.');
    }
    return manifest;
}
