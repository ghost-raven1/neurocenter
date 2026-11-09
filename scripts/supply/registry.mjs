import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Единый источник registry-правды для поставки (AD-15, vendor-схема).
 *
 * Поставка: (1) пары, доступные в доверенном registry — из
 * `ppod-npm-trusted`; (2) остальные актуальные для linux-x64 пары —
 * git-tracked vendor-тарболы `supply/vendor/` (file:-зависимости).
 * Публикации в registry НЕТ: publish-пути в кодовой базе не существует.
 * Скрипты читают credentials напрямую из ~/.npmrc внутри дочерних
 * процессов и НИКОГДА не печатают их значения в stdout/лог.
 */

export const TRUSTED_REGISTRY = 'https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/';
export const NPMJS_REGISTRY = 'https://registry.npmjs.org/';

export const root = fileURLToPath(new URL('../../', import.meta.url));

/** Все 13 lockfile проекта, подлежащих host-rewriting (без pnpm-lock.yaml). */
export const LOCKFILES = Object.freeze([
    'package-lock.json',
    'frontend/package-lock.json',
    'mcp/neurocenter-asset-sync/package-lock.json',
    '.opencode/package-lock.json',
    'scripts/coverage/package-lock.json',
    'scripts/snapshots/verifier/package-lock.json',
    'services/api-gateway/package-lock.json',
    'services/catalog-service/package-lock.json',
    'services/feature-flags-service/package-lock.json',
    'services/oauth2-bridge/package-lock.json',
    'services/rag-sync-service/package-lock.json',
    'services/skills-service/package-lock.json',
    'catalog-source/components/fetch-mcp/source/package-lock.json',
]);

export const NPMRC_FILES = Object.freeze([
    '.npmrc',
    'frontend/.npmrc',
    'mcp/neurocenter-asset-sync/.npmrc',
    'services/api-gateway/.npmrc',
    'services/catalog-service/.npmrc',
    'services/feature-flags-service/.npmrc',
    'services/oauth2-bridge/.npmrc',
    'services/rag-sync-service/.npmrc',
    'services/skills-service/.npmrc',
]);

export const DOCKERFILES = Object.freeze([
    'frontend/Dockerfile',
    'services/api-gateway/Dockerfile',
    'services/catalog-service/Dockerfile',
    'services/catalog-service/snapshot-verifier.Dockerfile',
    'services/feature-flags-service/Dockerfile',
    'services/oauth2-bridge/Dockerfile',
    'services/rag-sync-service/Dockerfile',
    'services/skills-service/Dockerfile',
]);

/**
 * Скан (name, version) пар из lockfile. Имя/версия выводятся из resolved URL
 * (а не из ключа node_modules), что корректно для aliased пакетов вида
 * string-width-cjs -> string-width. Пустые/файловые resolved пропускаются.
 * Возвращает Map key -> { name, version, integrity: Set SRI-значений }.
 */
/** Путь вендор-тарбола внутри supply/vendor/ (scope — отдельной подпапкой;
 *  плоское имя могло бы коллизировать: pg@8.23.1 и @types/pg@8.23.1). */
export function vendorPath(name, version) {
    const segments = name.split('/');
    const base = segments[segments.length - 1];
    const scope = segments.length === 2 ? segments[0] + '/' : '';
    return 'supply/vendor/' + scope + base + '-' + version + '.tgz';
}

/**
 * Вендор-тарболы, на которые lockfile ссылается file:-ссылками (путь относительно
 * корня репозитория, отсортирован). lockRelative — lockfile относительно корня
 * (для разрешения относительных file:-путей).
 */
export function lockfileVendorTarballs(lockfilePath, lockRelative) {
    const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    const found = new Set();
    const visit = (entry) => {
        if (!entry || typeof entry !== 'object') return;
        const resolved = entry.resolved;
        if (typeof resolved === 'string' && resolved.includes('supply/vendor/')) {
            const target = resolved.startsWith('file:') ? resolved.slice('file:'.length) : resolved;
            found.add(path.posix.normalize(path.posix.dirname(lockRelative) === '.' ? target : path.posix.join(path.posix.dirname(lockRelative), target)));
        }
        for (const child of Object.values(entry)) visit(child);
    };
    for (const value of Object.values(lock.packages || {})) visit(value);
    visit(lock.dependencies);
    return [...found].sort();
}

export function scanLockfilePairs(lockfilePath) {
    const json = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    const pairs = new Map();
    const consider = (entry) => {
        if (!entry || typeof entry !== 'object') return;
        const resolved = entry.resolved;
        if (typeof resolved !== 'string' || !resolved.startsWith('https://')) return;
        const url = new URL(resolved);
        const lastDash = url.pathname.lastIndexOf('/-/');
        if (lastDash < 0) return;
        // Имя пакета — сегмент(ы) сразу перед /-/: npmjs кладёт его в корень пути,
        // Artifactory — под префиксом репозитория; scope добавляется, если предыдущий сегмент @scope.
        const segments = url.pathname.slice(1, lastDash).split('/');
        const base = segments[segments.length - 1];
        const scope =
            segments.length >= 2 && segments[segments.length - 2].startsWith('@')
                ? segments[segments.length - 2] + '/'
                : '';
        const name = scope + base;
        const tarball = url.pathname.slice(lastDash + 3);
        if (!name || !tarball.startsWith(base + '-') || !tarball.endsWith('.tgz')) return;
        const version = tarball.slice(base.length + 1, -4);
        if (!version) return;
        const key = name + '@' + version;
        let record = pairs.get(key);
        if (!record) {
            record = { name, version, integrity: new Set() };
            pairs.set(key, record);
        }
        // В lockfile встречаются sha1- и sha512-SRI (legacy-записи); разные алгоритмы —
        // совместимые представления одних байтов, конфликт — тот же алгоритм, другой дайджест.
        if (typeof entry.integrity === 'string' && /^(sha1|sha256|sha512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
            const algorithm = entry.integrity.split('-')[0];
            for (const observed of record.integrity)
                if (observed.split('-')[0] === algorithm && observed !== entry.integrity)
                    throw new Error(`Конфликт integrity для ${key} в ${lockfilePath}`);
            record.integrity.add(entry.integrity);
        }
    };
    for (const value of Object.values(json.packages || {})) consider(value);
    return pairs;
}

let npmRequire;
function npmModule(name) {
    if (!npmRequire) {
        const npmPrefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
        npmRequire = createRequire(path.join(npmPrefix, 'lib/node_modules/npm/bin/npm-cli.js'));
    }
    return npmRequire(name);
}

/**
 * Читаем только ключи авторизации trusted-host и strict-ssl из ~/.npmrc.
 * Значения не логируются; клиент использует стек npm (base64-семантика _password).
 */
function loadNpmAuthOptions() {
    const raw = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const opts = { strictSSL: false, timeout: 30000 };
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.trimStart().startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i < 0) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key === 'strict-ssl') opts.strictSSL = value === 'true';
        if (key.startsWith('//') && (key.endsWith('/:username') || key.endsWith('/:_password') || key.endsWith('/:_authToken')))
            opts[key] = value;
    }
    return opts;
}

const presenceCache = new Map();

/**
 * Существует ли (name, version) в доверенном registry. true/false;
 * сетевые/аутентификационные ошибки пробрасываются — не гадаем.
 */
export async function registryHasVersion(name, version) {
    const key = name + '@' + version;
    if (presenceCache.has(key)) return presenceCache.get(key);
    const regFetch = npmModule('npm-registry-fetch');
    const encoded = name.startsWith('@') ? '@' + name.slice(1).replace('/', '%2f') : name;
    try {
        await regFetch.json('/' + encoded + '/' + version, {
            ...loadNpmAuthOptions(),
            registry: TRUSTED_REGISTRY,
            cache: path.join(os.tmpdir(), 'nc-supply-registry-cache-' + process.pid),
            retry: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 10000 },
        });
        presenceCache.set(key, true);
        return true;
    } catch (error) {
        const status = error.statusCode ?? error.response?.statusCode;
        if (error.code === 'E404' || status === 404) {
            presenceCache.set(key, false);
            return false;
        }
        throw error;
    }
}

/** Индексный ключ cacache: тарболы исходно качались с npmjs (URL-ключ). */
export function cacacheTarballKey(name, version) {
    const base = name.split('/').pop();
    return 'make-fetch-happen:request-cache:' + NPMJS_REGISTRY + name + '/-/' + base + '-' + version + '.tgz';
}

/** { integrity, size } из ~/.npm/_cacache или null, если тарбола нет в кэше. */
export async function cacacheInfo(name, version) {
    const cacache = npmModule('cacache');
    try {
        const info = await cacache.get.info(path.join(os.homedir(), '.npm', '_cacache'), cacacheTarballKey(name, version));
        return info ? { integrity: info.integrity, size: info.size } : null;
    } catch {
        return null;
    }
}

/** Достаёт тарбол из cacache в destination. Бросает ошибку при отсутствии. */
export async function cacacheRead(name, version, destination) {
    const cacache = npmModule('cacache');
    const stream = await cacache.get.stream(path.join(os.homedir(), '.npm', '_cacache'), cacacheTarballKey(name, version));
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(destination);
        stream.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        stream.pipe(out);
    });
}

/** SRI-дайджест файла; алгоритм берётся из integrity lockfile (sha1/sha256/sha512). */
export function sriDigest(bytes, integrity) {
    const algorithm = integrity?.split('-')[0];
    if (!['sha1', 'sha256', 'sha512'].includes(algorithm))
        throw new Error('Integrity lockfile должен содержать SRI sha1/sha256/sha512');
    return algorithm + '-' + createHash(algorithm).update(bytes).digest('base64');
}

/** map с ограничением параллелизма, порядок результатов сохранён. */
export async function mapConcurrent(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const pool = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(pool);
    return results;
}
