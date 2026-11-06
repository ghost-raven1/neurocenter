#!/usr/bin/env node
// AD-15 (vendor-схема): bucket-aware переписка 13 package-lock.json.
//
//   node scripts/supply/align-locks.mjs
//
// Корзины — scripts/supply/classification.json (генерится scripts/supply/classify.mjs):
//   registry   — пара в ppod-npm-trusted и актуальна для linux-x64:
//                resolved = trusted URL;
//   platform   — npm пропускает на linux-x64 по os/cpu (бинарники других ОС):
//                resolved = исходный npmjs URL (восстановление из git-HEAD, без реконструкции);
//   vendored+pending — нет в registry, актуальна:
//                resolved = file:<путь от каталога lockfile>/supply/vendor/<scope>/<base>-<version>.tgz.
//
// Гарантия: нулевое изменение версий — меняется только форма resolved; версии, integrity
// и os/cpu-поля не трогать. Редактирование JSON-уровнем; сериализация
// JSON.stringify(JSON.parse(text), null, 2) + '\n' round-trip-проверена на всех 13
// lockfile (текущий срез и git-HEAD). Переписываются оба дерева: packages (v3)
// и dependencies (legacy, lockfileVersion 2).
// После перезаписи пересчитывается pin-каскад producer-closure:
//   1) fetch-mcp компонент: SOURCE.json, записи manifest.json, components-запись lock;
//   2) node scripts/assets/catalog-source-pin.mjs --write (producer.json, manifest.json,
//      services/shared/bundled-catalog.lock.json).
// Итог проверяется: git diff содержит только resolved-строки + pin-каскад.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
    NPMJS_REGISTRY,
    TRUSTED_REGISTRY,
    LOCKFILES,
    root,
    vendorPath,
} from './registry.mjs';
import { pinCatalogSource } from '../assets/catalog-source-pin.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const serialize = (json) => JSON.stringify(json, null, 2) + '\n';
const CLASSIFICATION_PATH = path.join(root, 'scripts/supply/classification.json');

/** Точный trusted URL пары (форма, идентичная npmjs-хвосту). */
const trustedUrl = (name, version) =>
    TRUSTED_REGISTRY + name + '/-/' + name.split('/').pop() + '-' + version + '.tgz';

/** file:-ссылка на vendor-тарбол, относительная от каталога lockfile (npm-семантика, проверена). */
const fileUrl = (lockRelative, targetPath) =>
    'file:' + path.relative(path.dirname(lockRelative), targetPath);

/** (name, version) из resolved URL (npmjs- и trusted-формы), null если не разборчиво. */
function parsePair(resolved) {
    const url = new URL(resolved);
    const lastDash = url.pathname.lastIndexOf('/-/');
    if (lastDash < 0) return null;
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
    if (!name || !tarball.startsWith(base + '-') || !tarball.endsWith('.tgz')) return null;
    const version = tarball.slice(base.length + 1, -4);
    return version ? { name, version } : null;
}

/** git-HEAD-версия lockfile (worktree на base — исходный npmjs-срез). */
function gitHeadLockfile(relative) {
    const text = execFileSync('git', ['show', 'HEAD:' + relative], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
    });
    return JSON.parse(text);
}

/** pairKey -> исходный npmjs resolved из git-HEAD; уникальность формы assert'ится. */
function headResolvedMap(relative, head) {
    const map = new Map();
    const visit = (entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.resolved !== 'string') return;
        if (!entry.resolved.startsWith(NPMJS_REGISTRY)) return;
        const pair = parsePair(entry.resolved);
        if (!pair) throw new Error(`${relative} (git-HEAD): неразборчивый npmjs resolved: ${entry.resolved}`);
        const key = pair.name + '@' + pair.version;
        const existing = map.get(key);
        if (existing && existing !== entry.resolved)
            throw new Error(`${relative} (git-HEAD): разные npmjs resolved для пары ${key}`);
        map.set(key, entry.resolved);
    };
    for (const value of Object.values(head.packages || {})) visit(value);
    const walkLegacy = (node) => {
        for (const child of Object.values(node || {}))
            if (child && typeof child === 'object') {
                visit(child);
                walkLegacy(child.dependencies);
            }
    };
    walkLegacy(head.dependencies);
    return map;
}

/** Глубокое сравнение lockfile'ов с исключением только resolved. */
function assertSameExceptResolved(before, after) {
    const strip = (value) => {
        if (Array.isArray(value)) return value.map(strip);
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, child] of Object.entries(value))
                if (key !== 'resolved') out[key] = strip(child);
            return out;
        }
        return value;
    };
    if (!isDeepStrictEqual(strip(before), strip(after)))
        throw new Error('Lockfile изменился за пределами resolved-URL — abort');
}

function alignLockfile(relative, buckets) {
    const file = path.join(root, relative);
    const text = fs.readFileSync(file, 'utf8');
    const before = JSON.parse(text);
    if (serialize(before) !== text)
        throw new Error(`${relative}: сериализация не round-trip-стабильна — abort (ручная правка?)`);
    const headMap = headResolvedMap(relative, gitHeadLockfile(relative));
    const after = JSON.parse(JSON.stringify(before));
    const counts = { registry: 0, platform: 0, vendored: 0, pending: 0, kept: 0 };

    const rewrite = (entry, where) => {
        const resolved = entry.resolved;
        if (typeof resolved !== 'string' || !resolved.startsWith('https://')) return; // file:-зависимости — не трогаем
        if (!resolved.startsWith(TRUSTED_REGISTRY) && !resolved.startsWith(NPMJS_REGISTRY))
            throw new Error(`${relative} (${where}): resolved не trusted и не npmjs — abort: ${resolved}`);
        const pair = parsePair(resolved);
        if (!pair) throw new Error(`${relative} (${where}): неразборчивый resolved — abort: ${resolved}`);
        const key = pair.name + '@' + pair.version;
        const bucket = buckets.get(key);
        if (!bucket) throw new Error(`${relative} (${where}): пара ${key} отсутствует в classification.json — abort`);
        let target;
        if (bucket === 'registry') target = trustedUrl(pair.name, pair.version);
        else if (bucket === 'platform') {
            target = headMap.get(key);
            if (!target)
                throw new Error(`${relative} (${where}): для platform-пары ${key} нет npmjs resolved в git-HEAD — abort`);
        } else target = fileUrl(relative, vendorPath(pair.name, pair.version));
        if (entry.resolved === target) {
            counts.kept++;
            return;
        }
        entry.resolved = target;
        counts[bucket]++;
    };

    for (const [entryKey, entry] of Object.entries(after.packages || {}))
        if (entry && typeof entry === 'object') rewrite(entry, 'packages/' + entryKey);
    const walkLegacy = (node, where) => {
        for (const [name, child] of Object.entries(node || {})) {
            if (!child || typeof child !== 'object') continue;
            rewrite(child, 'dependencies/' + where + name);
            walkLegacy(child.dependencies, where + name + '/');
        }
    };
    walkLegacy(after.dependencies, '');

    assertSameExceptResolved(before, after);
    fs.writeFileSync(file, serialize(after));
    console.log(
        `${relative}: registry=+${counts.registry} platform=+${counts.platform} ` +
            `vendored=+${counts.vendored} pending=+${counts.pending} без изменений=${counts.kept}`,
    );
    return counts;
}

/** fetch-mcp lockfile входит в бандл-компонент: обновляем его SOURCE.json, manifest и lock. */
function refreshFetchMcpComponent() {
    const componentDir = 'catalog-source/components/fetch-mcp';
    const lockRelative = componentDir + '/source/package-lock.json';
    const sourceRelative = componentDir + '/SOURCE.json';
    const manifestRelative = 'catalog-source/manifest.json';
    const lockPinRelative = 'services/shared/bundled-catalog.lock.json';
    const lockBytes = fs.readFileSync(path.join(root, lockRelative));
    const lockSha = sha256(lockBytes);
    const source = JSON.parse(fs.readFileSync(path.join(root, sourceRelative), 'utf8'));
    const entry = source.files.find((file) => file.path === 'source/package-lock.json');
    if (!entry) throw new Error('SOURCE.json fetch-mcp: нет записи source/package-lock.json');
    entry.sha256 = lockSha;
    entry.bytes = lockBytes.length;
    const sourceBytes = Buffer.from(JSON.stringify(source, null, 2) + '\n');
    fs.writeFileSync(path.join(root, sourceRelative), sourceBytes);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestRelative), 'utf8'));
    const upsert = (file, sha, bytes) => {
        const row = manifest.files.find((item) => item.path === file);
        if (!row) throw new Error('manifest.json: нет записи ' + file);
        row.sha256 = sha;
        row.bytes = bytes;
    };
    upsert('components/fetch-mcp/SOURCE.json', sha256(sourceBytes), sourceBytes.length);
    upsert('components/fetch-mcp/source/package-lock.json', lockSha, lockBytes.length);
    fs.writeFileSync(path.join(root, manifestRelative), JSON.stringify(manifest, null, 2) + '\n');
    const lockPin = JSON.parse(fs.readFileSync(path.join(root, lockPinRelative), 'utf8'));
    lockPin.components['fetch-mcp'] = sha256(sourceBytes);
    fs.writeFileSync(path.join(root, lockPinRelative), JSON.stringify(lockPin, null, 2) + '\n');
    console.log(`${componentDir}/SOURCE.json + manifest + lock.components пересчитаны`);
}

const classification = JSON.parse(fs.readFileSync(CLASSIFICATION_PATH, 'utf8'));
const buckets = new Map();
for (const [name, list] of Object.entries(classification.buckets))
    for (const key of list) buckets.set(key, name);

const totals = { registry: 0, platform: 0, vendored: 0, pending: 0, kept: 0 };
for (const relative of LOCKFILES) {
    const counts = alignLockfile(relative, buckets);
    for (const key of Object.keys(totals)) totals[key] += counts[key];
}
console.log(
    `Всего переписано: registry=${totals.registry} platform=${totals.platform} ` +
        `vendored=${totals.vendored} pending=${totals.pending} (без изменений ${totals.kept})`,
);
refreshFetchMcpComponent();
const pin = await pinCatalogSource({ write: true });
console.log('pin-каскад: ' + JSON.stringify(pin));
