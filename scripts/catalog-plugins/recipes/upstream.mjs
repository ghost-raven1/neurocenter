import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cache = path.resolve('.run/catalog-plugin-cache');

/** Выполняет подготовку только на площадке; lifecycle scripts на клиенте не нужны. */
export async function run(command, args, options = {}) {
    return execFileAsync(command, args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

/** Закреплённый SHA проверяется и при первом скачивании, и при повторном использовании. */
export async function download(url, sha256) {
    await fs.mkdir(cache, { recursive: true });
    const destination = path.join(cache, sha256);
    const valid = async file => {
        try { return createHash('sha256').update(await fs.readFile(file)).digest('hex') === sha256; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    if (await valid(destination)) return destination;
    const temporary = destination + '.' + process.pid + '.tmp';
    try {
        await run('curl', ['-fsSL', '--retry', '2', '--connect-timeout', '20', '--max-time', '180', url, '-o', temporary]);
        if (!await valid(temporary)) throw new Error('Не совпала SHA256 внешнего пакета.');
        await fs.rename(temporary, destination);
        return destination;
    } finally { await fs.rm(temporary, { force: true }); }
}

/** Известные архивы имеют закреплённые байты; пути и ссылки дополнительно проверяются. */
export async function extract(archive, directory, format = 'tar') {
    await fs.mkdir(directory, { recursive: true });
    const listing = await run(format === 'zip' ? 'unzip' : 'tar', format === 'zip' ? ['-Z1', archive] : ['-tzf', archive]);
    for (const name of listing.stdout.split('\n').filter(Boolean)) {
        if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..')) {
            throw new Error('Небезопасный путь во внешнем архиве.');
        }
    }
    await run(format === 'zip' ? 'unzip' : 'tar', format === 'zip' ? ['-q', archive, '-d', directory] : ['-xzf', archive, '-C', directory]);
    await assertRegularTree(directory);
}

export async function assertRegularTree(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await assertRegularTree(file);
        else if (!entry.isFile()) throw new Error('Поставка содержит ссылку или специальный файл: ' + entry.name);
    }
}

async function npmCli() {
    if (process.env.NPM_CLI_JS) return process.env.NPM_CLI_JS;
    if (process.env.npm_execpath?.endsWith('.js')) return process.env.npm_execpath;
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        try {
            const candidate = await fs.realpath(path.join(directory, 'npm'));
            if (candidate.endsWith('.js')) return candidate;
        } catch { /* Следующий каталог PATH. */ }
    }
    throw new Error('На площадке требуется npm-cli.js (можно задать NPM_CLI_JS).');
}

export const TARGETS = Object.freeze({
    'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
    'darwin-x64': { os: 'darwin', cpu: 'x64' },
    'linux-arm64-glibc': { os: 'linux', cpu: 'arm64', libc: 'glibc' },
    'linux-arm64-musl': { os: 'linux', cpu: 'arm64', libc: 'musl' },
    'linux-x64-glibc': { os: 'linux', cpu: 'x64', libc: 'glibc' },
    'linux-x64-musl': { os: 'linux', cpu: 'x64', libc: 'musl' },
    'win32-arm64': { os: 'win32', cpu: 'arm64' },
    'win32-x64': { os: 'win32', cpu: 'x64' },
});

/** npm проверяет integrity всех транзитивных пакетов; установки из сети на клиенте нет. */
export async function installDependencies(directory, dependencies, target, {optionalDependencies={}}={}) {
    const platform = TARGETS[target];
    if (!platform) throw new Error('Неизвестная платформа: ' + target);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'neurocenter-prepared-runtime', version: '1.0.0', private: true, type: 'module', dependencies,
        ...(Object.keys(optionalDependencies).length?{optionalDependencies}:{}) }, null, 2) + '\n');
    await fs.mkdir(cache, { recursive: true });
    const home = await fs.mkdtemp(path.join(cache, 'npm-home-'));
    const userconfig = path.join(home, 'npmrc');
    const globalconfig = path.join(home, 'global-npmrc');
    await Promise.all([fs.writeFile(userconfig, ''), fs.writeFile(globalconfig, '')]);
    try {
        const locked = await fs.stat(path.join(directory, 'package-lock.json')).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
        const args = [locked ? 'ci' : 'install', '--prefix', directory, '--ignore-scripts', '--omit=dev', '--include=optional', '--no-bin-links', '--no-audit', '--no-fund',
            '--registry=https://registry.npmjs.org', '--cache', path.join(cache, 'npm'), '--userconfig', userconfig, '--globalconfig', globalconfig,
            '--os', platform.os, '--cpu', platform.cpu, ...(platform.libc ? ['--libc', platform.libc] : [])];
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
        await run(process.execPath, [await npmCli(), ...args], { env: { ...environment, HOME: home, USERPROFILE: home, npm_config_update_notifier: 'false' } });
        await assertRegularTree(directory);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
}
