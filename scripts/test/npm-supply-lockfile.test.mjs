import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    NPMJS_REGISTRY,
    TRUSTED_REGISTRY,
    LOCKFILES,
    NPMRC_FILES,
    DOCKERFILES,
    vendorPath,
    scanLockfilePairs,
} from '../supply/registry.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'scripts/supply/registry-availability.json'), 'utf8'));
const classification = JSON.parse(fs.readFileSync(path.join(root, 'scripts/supply/classification.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'supply/vendor/manifest.json'), 'utf8'));
const registrySet = new Set(classification.buckets.registry);
const platformSet = new Set(classification.buckets.platform);
const supplySet = new Set([...classification.buckets.vendored, ...classification.buckets.pending]);
const manifestByPath = new Map(manifest.packages.map((item) => [item.path, item]));

/** (name, version) из resolved URL (npmjs- и trusted-формы); null — не разборчиво. */
function parsePair(resolved) {
    const url = new URL(resolved);
    const lastDash = url.pathname.lastIndexOf('/-/');
    if (lastDash < 0) return null;
    const segments = url.pathname.slice(1, lastDash).split('/');
    const base = segments[segments.length - 1];
    const scope =
        segments.length >= 2 && segments[segments.length - 2].startsWith('@')
            ? segments[segments.length - 2] + '/'
            : '';
    const name = scope + base;
    const tarball = url.pathname.slice(lastDash + 3);
    if (!name || !tarball.startsWith(base + '-') || !tarball.endsWith('.tgz')) return null;
    const version = tarball.slice(base.length + 1, -4);
    return version ? { name, version } : null;
}

const trustedUrl = (name, version) => TRUSTED_REGISTRY + name + '/-/' + name.split('/').pop() + '-' + version + '.tgz';
const npmjsUrl = (name, version) => NPMJS_REGISTRY + name + '/-/' + name.split('/').pop() + '-' + version + '.tgz';

/** Известные file:-зависимости (до vendor-схемы): (lockfile) -> resolved. */
const LEGACY_FILE_DEPS = new Map([
    ['package-lock.json', 'vendor/asset-contract'],
    ['mcp/neurocenter-asset-sync/package-lock.json', 'file:vendor/ollama-runtime'],
    ['services/api-gateway/package-lock.json', '../../vendor/asset-contract'],
    ['services/catalog-service/package-lock.json', '../../vendor/asset-contract'],
]);

/** Все записи lockfile (packages + legacy dependencies) с контекстом. */
function* lockEntries(relative) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    for (const [entryKey, entry] of Object.entries(lock.packages || {}))
        if (entry && typeof entry === 'object') yield { entry, where: 'packages/' + entryKey };
    yield* legacyEntries(lock.dependencies, '');
}

function* legacyEntries(node, where) {
    for (const [name, child] of Object.entries(node || {})) {
        if (!child || typeof child !== 'object') continue;
        yield { entry: child, where: 'dependencies/' + where + name };
        yield* legacyEntries(child.dependencies, where + name + '/');
    }
}

test('The committed supply snapshot covers every locked (name, version) and its integrity values', () => {
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.registry, TRUSTED_REGISTRY);
    assert.ok(Object.keys(snapshot.packages).length > 0);
    for (const relative of LOCKFILES) {
        const file = path.join(root, relative);
        assert.ok(fs.existsSync(file), relative + ' missing');
        for (const [key, pair] of scanLockfilePairs(file)) {
            const row = snapshot.packages[key];
            assert.ok(row, relative + ': snapshot has no ' + key);
            assert.ok(pair.integrity.size > 0, relative + ': ' + key + ' has no lockfile integrity');
            for (const value of pair.integrity)
                assert.ok(row.integrity.includes(value), relative + ': ' + key + ' integrity drift: ' + value);
        }
    }
});

test('Every lockfile resolved is exactly one of the allowed supply forms (trusted / file:vendor / platform-npmjs)', () => {
    let trusted = 0;
    let vendor = 0;
    let platform = 0;
    for (const relative of LOCKFILES) {
        const lockDir = path.dirname(relative);
        for (const { entry, where } of lockEntries(relative)) {
            const resolved = entry.resolved;
            if (typeof resolved !== 'string') continue; // корневая запись / пакеты без resolved
            const context = relative + ' (' + where + ')';
            if (resolved.startsWith('https://')) {
                if (!resolved.startsWith(TRUSTED_REGISTRY) && !resolved.startsWith(NPMJS_REGISTRY))
                    throw new Error(context + ': resolved не trusted и не npmjs: ' + resolved);
                const pair = parsePair(resolved);
                assert.ok(pair, context + ': неразборчивый resolved: ' + resolved);
                const key = pair.name + '@' + pair.version;
                assert.ok(
                    registrySet.has(key) || platformSet.has(key) || supplySet.has(key),
                    context + ': пара ' + key + ' отсутствует в classification.json',
                );
                if (registrySet.has(key)) {
                    assert.equal(
                        resolved,
                        trustedUrl(pair.name, pair.version),
                        context + ': registry-пара не на trusted URL',
                    );
                    trusted++;
                } else if (platformSet.has(key)) {
                    assert.equal(
                        resolved,
                        npmjsUrl(pair.name, pair.version),
                        context + ': platform-пара не на исходном npmjs URL',
                    );
                    platform++;
                } else {
                    throw new Error(context + ': supply-пара ' + key + ' должна быть file:-ссылкой, а не ' + resolved);
                }
            } else if (resolved.includes('supply/vendor/')) {
                const target = resolved.startsWith('file:') ? resolved.slice('file:'.length) : resolved;
                const manifestRelative = path.normalize(path.join(lockDir, target));
                const entryRow = manifestByPath.get(manifestRelative);
                assert.ok(entryRow, context + ': file:-ссылка вне supply/vendor manifest: ' + resolved);
                assert.equal(
                    manifestRelative,
                    vendorPath(entryRow.name, entryRow.version),
                    context + ': file:-путь не совпадает с manifest: ' + resolved,
                );
                if (typeof entry.integrity === 'string')
                    assert.ok(
                        entryRow.integrity.includes(entry.integrity),
                        context + ': lockfile integrity не в manifest: ' + entry.integrity,
                    );
                if (entryRow.status === 'vendored')
                    assert.ok(
                        fs.existsSync(path.join(root, manifestRelative)),
                        context + ': vendored-файл отсутствует: ' + manifestRelative,
                    );
                vendor++;
            } else {
                assert.equal(
                    resolved,
                    LEGACY_FILE_DEPS.get(relative),
                    context + ': неизвестная file:-зависимость: ' + resolved,
                );
            }
        }
    }
    // Ожидаемое количество ссылок (оба дерева: packages + legacy dependencies).
    // 5437 = 5435 (baseline 326a01f2) + 2 entry 1.2 (js-yaml, argparse) — нормализованы
    // в canonical trusted-форму при мерже 1.9 (были :443-формой с sha1 из registry-quirk).
    // 5449 = 5437 + 12 entry 2.9 (pg + 5 зависимостей × 2 дерева, api-gateway, AD-6).
    // 943 = 1025 − 82: a7270ea7 (npm install --package-lock-only) перестал дублировать
    // file: resolved в legacy-дереве api-gateway (integrity в дзеркале на месте;
    // packages-дерево неизменно — те же 82 ссылки, каждая валидирована по manifest/integrity).
    assert.equal(trusted, 5449, 'trusted-ссылок');
    assert.equal(platform, 420, 'platform npmjs-ссылок');
    assert.equal(vendor, 943, 'file: supply/vendor-ссылок');
});

test('supply manifest: 227 пар, статусы согласованы с файлами на диске, pending — явная часть', () => {
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.packages.length, 227);
    let vendored = 0;
    let pending = 0;
    for (const item of manifest.packages) {
        assert.ok(['vendored', 'pending'].includes(item.status), 'неизвестный статус: ' + item.status);
        assert.equal(item.path, vendorPath(item.name, item.version), item.path);
        assert.ok(item.integrity.length > 0, item.name + '@' + item.version + ' без integrity');
        const file = path.join(root, item.path);
        if (item.status === 'vendored') {
            assert.ok(fs.existsSync(file), 'vendored, файла нет: ' + item.path);
            const sri = 'sha512-' + createHash('sha512').update(fs.readFileSync(file)).digest('base64');
            assert.equal(item.sha512, sri, 'sha512 не совпадает с файлом: ' + item.path);
            vendored++;
        } else {
            assert.ok(!fs.existsSync(file), 'pending, но файл на месте: ' + item.path);
            assert.equal(item.sha512, null, 'pending должен иметь null sha512: ' + item.path);
            pending++;
        }
    }
    assert.equal(vendored + pending, 227);
    // Pending — явная часть: ровно тот набор, что в vendor-pending/needed.json (в обе стороны).
    const needed = JSON.parse(fs.readFileSync(path.join(root, 'supply/vendor-pending/needed.json'), 'utf8'));
    const neededKeys = new Set(needed.packages.map((row) => row.name + '@' + row.version));
    const pendingKeys = new Set(
        manifest.packages.filter((item) => item.status === 'pending').map((item) => item.name + '@' + item.version),
    );
    for (const key of pendingKeys) assert.ok(neededKeys.has(key), 'pending-пара не в needed.json: ' + key);
    for (const key of neededKeys) assert.ok(pendingKeys.has(key), 'needed.json содержит не-pending пару: ' + key);
});

test('Every Dockerfile ships the vendor tarballs its npm ci needs; .dockerignore keeps supply/vendor in the context', () => {
    // Все 8 Dockerfile делают npm ci по lockfile с file:-ссылками на supply/vendor,
    // поэтому каждый должен копировать vendor-дерево в build-контекст образа.
    for (const relative of DOCKERFILES) {
        const text = fs.readFileSync(path.join(root, relative), 'utf8');
        assert.match(text, /^COPY supply\/vendor\/ \S+$/m, relative + ' missing COPY supply/vendor');
    }
    for (const relative of ['.dockerignore', 'frontend/.dockerignore']) {
        const lines = fs
            .readFileSync(path.join(root, relative), 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim());
        for (const line of lines)
            assert.ok(!line.startsWith('supply'), relative + ' excludes supply/ from the Docker context: ' + line);
    }
});

test('npmjs.org is not a supply source in .npmrc files or Dockerfiles', () => {
    for (const relative of [...NPMRC_FILES, ...DOCKERFILES]) {
        const text = fs.readFileSync(path.join(root, relative), 'utf8');
        assert.ok(!text.includes('registry.npmjs.org'), relative + ' still references registry.npmjs.org');
    }
});

test('Every .npmrc pins the exact trusted registry URL', () => {
    for (const relative of NPMRC_FILES) {
        const lines = fs.readFileSync(path.join(root, relative), 'utf8').split(/\r?\n/);
        const registry = lines.find((line) => line.startsWith('registry='));
        assert.equal(registry, 'registry=' + TRUSTED_REGISTRY, relative);
    }
});

test('Every Dockerfile pins the trusted registry, its auth build-arg and no npmjs fallback', () => {
    const envPattern = new RegExp(
        'ENV NPM_CONFIG_REGISTRY=' + TRUSTED_REGISTRY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\\\',
    );
    for (const relative of DOCKERFILES) {
        const text = fs.readFileSync(path.join(root, relative), 'utf8');
        assert.match(text, envPattern, relative + ' ENV registry');
        assert.ok(text.includes('--registry=' + TRUSTED_REGISTRY), relative + ' missing --registry flag');
        assert.match(text, /^ARG NPM_REGISTRY_AUTH_B64$/m, relative + ' missing auth ARG');
        assert.match(
            text,
            /RUN if \[ -n "\$NPM_REGISTRY_AUTH_B64" \]; then printf '%s' "\$NPM_REGISTRY_AUTH_B64" \| base64 -d > \/tmp\/neurocenter-empty-global\.npmrc; else : > \/tmp\/neurocenter-empty-global\.npmrc; fi/,
            relative + ' missing auth RUN',
        );
    }
});
