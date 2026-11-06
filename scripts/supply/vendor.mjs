#!/usr/bin/env node
// AD-15, vendor-схема: снабжение, которого нет в доверенном registry, живёт
// в репозитории (git-tracked) как file:-тарболы `supply/vendor/`.
//
//   node scripts/supply/vendor.mjs --extract   извлечь актуальные пары из ~/.npm/_cacache
//                                              (sha512-сверка с integrity lockfile ДО записи)
//   node scripts/supply/vendor.mjs --add <dir> принять принесённые pending-тарболы
//                                              (сверка по vendor-pending/needed.json)
//   node scripts/supply/vendor.mjs --check     офлайн-гард: supply-набор на месте и
//                                              верифицирован; pending — ЯВНЫЙ отчёт
//   node scripts/supply/vendor.mjs --snapshot  read-only перегенерация
//                                              scripts/supply/registry-availability.json
//   node scripts/supply/vendor.mjs --rebuild-pending  перегенерация vendor-pending/
//                                              из текущего manifest (needed.json + fetch-скрипт)
//
// Публикации в registry НЕТ (решение человека 2026-11-06): publish-пути не существует.
//
// NC_SUPPLY_ROOT=<dir> — тест-хук: relocate supply/ (vendor + vendor-pending) в <dir>/supply.
//
// Supply-набор = (name,version) пары 13 lockfile, которых НЕТ в доверенном registry
// и которые актуальны для linux-x64 (os/cpu из lockfile-манифестов). Пары других
// платформ (npm их пропускает) не вендорятся.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
    TRUSTED_REGISTRY,
    NPMJS_REGISTRY,
    LOCKFILES,
    root,
    vendorPath,
    scanLockfilePairs,
    registryHasVersion,
    cacacheInfo,
    cacacheRead,
    sriDigest,
    mapConcurrent,
} from './registry.mjs';

// Тест-хук: NC_SUPPLY_ROOT relocate'ит supply/ (vendor + vendor-pending) в тестовое дерево.
const SUPPLY_ROOT = process.env.NC_SUPPLY_ROOT ? path.resolve(process.env.NC_SUPPLY_ROOT) : path.join(root, 'supply');
const VENDOR_DIR = path.join(SUPPLY_ROOT, 'vendor');
const PENDING_DIR = path.join(SUPPLY_ROOT, 'vendor-pending');
const MANIFEST_PATH = path.join(VENDOR_DIR, 'manifest.json');
const NEEDED_PATH = path.join(PENDING_DIR, 'needed.json');
const SNAPSHOT_PATH = path.join(root, 'scripts/supply/registry-availability.json');
const HOST = 'linux-x64';

function usage() {
    console.error(
        'Использование: node scripts/supply/vendor.mjs --extract | --add <dir> | --check | --snapshot | --rebuild-pending'
    );
    process.exit(2);
}

/** Корнеотносительный путь (supply/...) → абсолютный с учётом SUPPLY_ROOT. */
const supplyFile = (relative) => path.join(SUPPLY_ROOT, relative.slice('supply/'.length));

const sha512Sri = (bytes) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

/** Точный tarball URL npmjs (единая форма, проверена на всём срезе lockfile). */
const npmjsTarballUrl = (name, version) => {
    const base = name.split('/').pop();
    return NPMJS_REGISTRY + name + '/-/' + base + '-' + version + '.tgz';
};

/** Ожидаемые дайджесты принесённого тарбола: SRI + hex-репрезентация digest'а (не хеш digest'а). */
function expectedDigests(integrity) {
    return [...integrity].sort().map((sri) => {
        const algorithm = sri.split('-')[0];
        return { algorithm, sri, hex: Buffer.from(sri.split('-').slice(1).join('-'), 'base64').toString('hex') };
    });
}

/** Актуальна ли пара для host linux-x64 (os/cpu из lockfile-манифестов). */
const hostRelevant = (record) => {
    if (record.os && !record.os.has('linux')) return false;
    if (record.cpu && !record.cpu.has('x64')) return false;
    return true;
};

/**
 * Supply-набор. Формы:
 *  - post-align (актуальная): lockfile указывает `file:`-тарбол внутри supply/vendor/ —
 *    такие пары являются supply по определению (путь обязан совпадать с vendorPath);
 *  - bootstrap (pre-align): npmjs-пара, которой нет в registry-снимке и которая
 *    актуальна для host (исторически до align-locks.mjs).
 */
function supplySet() {
    const pairs = new Map();
    let snapshot = null;
    const recordFor = (name, version, item) => {
        const key = name + '@' + version;
        let record = pairs.get(key);
        if (!record) {
            record = { key, name, version, integrity: new Set(), os: null, cpu: null, path: null };
            pairs.set(key, record);
        }
        if (typeof item.integrity === 'string' && /^(sha1|sha256|sha512)-[A-Za-z0-9+/=]+$/.test(item.integrity))
            record.integrity.add(item.integrity);
        if (Array.isArray(item.os)) record.os = new Set([...(record.os ?? []), ...item.os]);
        if (Array.isArray(item.cpu)) record.cpu = new Set([...(record.cpu ?? []), ...item.cpu]);
        return record;
    };
    for (const relative of LOCKFILES) {
        const lockFile = path.join(root, relative);
        const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        for (const [entryKey, item] of Object.entries(lock.packages || {})) {
            if (!item || typeof item !== 'object' || typeof item.version !== 'string') continue;
            const resolved = item.resolved;
            if (typeof resolved !== 'string') continue;
            const name = entryKey.split('node_modules/').pop();
            if (resolved.startsWith('file:')) {
                const targetAbs = path.resolve(path.dirname(lockFile), decodeURIComponent(resolved.slice(5)));
                const targetRel = path.relative(root, targetAbs).split(path.sep).join('/');
                if (!targetRel.startsWith('supply/vendor/')) continue; // legacy-локальные file:-зависимости
                const expected = vendorPath(name, item.version);
                if (targetRel !== expected)
                    throw new Error(
                        `file:-путь в ${relative} расходится с supply-путью для ${name}@${item.version}: ${targetRel} != ${expected}`
                    );
                recordFor(name, item.version, item).path = targetRel;
            } else if (resolved.startsWith('https://')) {
                // Имя из URL (для алиасов ключ в lockfile отличается от реального имени пакета).
                let urlName = null;
                try {
                    const url = new URL(resolved);
                    const lastDash = url.pathname.lastIndexOf('/-/');
                    if (lastDash >= 0 && url.pathname.endsWith('.tgz')) {
                        const segments = url.pathname.slice(1, lastDash).split('/');
                        const base = segments[segments.length - 1];
                        const scope = segments.length >= 2 && segments[segments.length - 2].startsWith('@') ? segments[segments.length - 2] + '/' : '';
                        urlName = scope + base;
                    }
                } catch {
                    /* не npm-URL — оставляем имя из ключа */
                }
                recordFor(urlName ?? name, item.version, item);
            }
        }
    }
    const rows = [];
    for (const record of pairs.values()) {
        if (record.path) {
            rows.push(record);
            continue;
        }
        if (!snapshot) snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
        const row = snapshot.packages[record.key];
        if (!row) throw new Error('Снимок registry не содержит пару из lockfile: ' + record.key);
        if (row.source === 'registry') continue;
        if (!hostRelevant(record)) continue;
        record.path = vendorPath(record.name, record.version);
        rows.push(record);
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key, 'en'));
}

function readManifest() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    if (manifest.schemaVersion !== 1) throw new Error('Неизвестная schemaVersion manifest.json');
    return manifest;
}

function writeJson(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
}

/** vendor-pending/ (needed.json + fetch-скрипт) из pending-строк manifest. */
function writePendingDocs(manifest) {
    const pending = manifest.packages.filter((item) => item.status === 'pending');
    const needed = {
        schemaVersion: 1,
        generatedBy: 'scripts/supply/vendor.mjs',
        host: HOST,
        packages: pending.map((row) => ({
            name: row.name,
            version: row.version,
            path: row.path,
            url: npmjsTarballUrl(row.name, row.version),
            expected: expectedDigests(row.integrity),
        })),
    };
    writeJson(NEEDED_PATH, needed);
    writeFetchScript(needed);
    return needed;
}

/** Генерация manifest.json + vendor-pending/ (needed.json + fetch-скрипт). */
function writeSupplyDocs(rows) {
    const manifest = {
        schemaVersion: 1,
        generatedBy: 'scripts/supply/vendor.mjs',
        registry: TRUSTED_REGISTRY,
        host: HOST,
        packages: rows.map((row) => ({
            name: row.name,
            version: row.version,
            path: row.path,
            integrity: [...row.integrity].sort(),
            sha512: row.sha512 ?? null,
            status: row.status,
        })),
    };
    writeJson(MANIFEST_PATH, manifest);
    writePendingDocs(manifest);
    return manifest;
}

/** Самодостаточный fetch-скрипт для интернет-машины: bash+curl+sha512sum/shasum, без npm/node. */
function writeFetchScript(needed) {
    const lines = needed.packages
        .map((row) => {
            const digest = row.expected.find((item) => item.algorithm === 'sha512') ?? row.expected[0];
            return row.path + '\t' + row.url + '\t' + digest.algorithm + '\t' + digest.hex;
        })
        .join('\n');
    const script = `#!/usr/bin/env bash
# AD-15: загрузка ${needed.packages.length} pending-тарболов на машине с доступом к npmjs.
# Самодостаточен: bash + curl + sha512sum (или shasum). Результат — каталог out/<path>.
# Затем в checkout проекта: node scripts/supply/vendor.mjs --add out
set -euo pipefail
OUT=\${1:-out}
mkdir -p "$OUT"
digest() { # $1=алгоритм $2=файл -> hex
    if [ "$1" = "sha512" ]; then
        if command -v sha512sum >/dev/null 2>&1; then sha512sum "$2" | cut -d' ' -f1
        else shasum -a 512 "$2" | cut -d' ' -f1; fi
    else
        if command -v sha1sum >/dev/null 2>&1; then sha1sum "$2" | cut -d' ' -f1
        else shasum -a 1 "$2" | cut -d' ' -f1; fi
    fi
}
fail=0
while IFS=$'\\t' read -r rel url algo hex; do
    [ -z "$rel" ] && continue
    dest="$OUT/$rel"
    mkdir -p "$(dirname "$dest")"
    if ! curl -fSL --retry 3 --retry-delay 2 -o "$dest" "$url"; then echo "FAIL (download): $rel"; fail=1; continue; fi
    actual=$(digest "$algo" "$dest")
    if [ "$actual" != "$hex" ]; then echo "FAIL (digest $algo): $rel"; rm -f "$dest"; fail=1; continue; fi
    echo "OK: $rel"
done <<'EOF'
${lines}
EOF
if [ "$fail" != "0" ]; then
    echo
    echo 'Есть ошибки — список выше. Повторите запуск: уже скачанные и проверенные файлы перескачиваются.'
    exit 1
fi
echo
echo "Все ${needed.packages.length} тарболов скачаны и проверены: $OUT/"
echo 'Далее в checkout проекта: node scripts/supply/vendor.mjs --add out'
`;
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const file = path.join(PENDING_DIR, 'fetch-on-online-machine.sh');
    fs.writeFileSync(file, script, { mode: 0o755 });
}

/**
 * --extract: supply-набор из lockfile; пары из cacache извлекаются в supply/vendor/
 * после полной верификации (integrity cacache + все SRI lockfile). Атомарно: либо
 * записаны все проверенные, либо ничего (mismatch = стоп + список, exit 1).
 */
async function extract() {
    const rows = supplySet();
    const fromCache = [];
    const missing = [];
    for (const row of rows) {
        const info = await cacacheInfo(row.name, row.version);
        (info ? fromCache : missing).push(row);
    }
    console.log(`Supply-набор (нет в registry, актуально для ${HOST}): ${rows.length}`);
    console.log(`  из ~/.npm/_cacache: ${fromCache.length}`);
    console.log(`  нет в кэше (pending): ${missing.length}`);
    // Фаза 1: верификация всех кэшированных байтов ДО записи в репозиторий.
    const verified = new Map();
    const mismatches = [];
    await mapConcurrent(fromCache, 8, async (row) => {
        const tgz = path.join(os.tmpdir(), 'nc-supply-verify-' + process.pid + '-' + row.key.replace(/[^a-zA-Z0-9]+/g, '_') + '.tgz');
        try {
            await cacacheRead(row.name, row.version, tgz);
            const bytes = fs.readFileSync(tgz);
            const problems = [];
            const cacheInfo = await cacacheInfo(row.name, row.version);
            try {
                if (sriDigest(bytes, cacheInfo.integrity) !== cacheInfo.integrity)
                    problems.push('байты != integrity cacache (' + cacheInfo.integrity + ')');
            } catch (error) {
                problems.push('integrity cacache не SRI: ' + cacheInfo.integrity + ' (' + error.message + ')');
            }
            for (const sri of row.integrity) {
                if (sriDigest(bytes, sri) !== sri) problems.push('SRI lockfile не совпадает: ' + sri);
            }
            if (problems.length) mismatches.push(row.key + ': ' + problems.join('; '));
            else verified.set(row.key, bytes);
        } finally {
            fs.rmSync(tgz, { force: true });
        }
    });
    if (mismatches.length) {
        console.error(`Integrity-расхождений: ${mismatches.length}. STOP, в supply/vendor ничего не записано:`);
        for (const item of mismatches) console.error('  ' + item);
        process.exit(1);
    }
    // Фаза 2: запись.
    for (const row of rows) {
        row.status = verified.has(row.key) ? 'vendored' : 'pending';
        row.sha512 = verified.has(row.key) ? sha512Sri(verified.get(row.key)) : null;
    }
    for (const row of rows) {
        if (row.status !== 'vendored') continue;
        const file = supplyFile(row.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, verified.get(row.key));
    }
    writeSupplyDocs(rows);
    console.log(`Записано tarball'ов: ${fromCache.length} -> supply/vendor/`);
    console.log(`Manifest: ${path.relative(root, MANIFEST_PATH)} (${rows.length} пар)`);
    if (missing.length) {
        console.log(`${missing.length} pending: ждём тарболы (supply/vendor-pending/ + fetch-on-online-machine.sh):`);
        for (const row of missing) console.log('  ' + row.key);
    }
}

/** flat-именование pending-тарбола (расклад оркестратора): `@scope/pkg-1.2.3.tgz`. */
const flatName = (name, version) => name.replace('/', '-') + '-' + version + '.tgz';

/** --add <dir>: принять принесённые pending-тарболы; сверка по needed.json.
 *  Распознаёт два расклада: относительный путь по needed.json (layout fetch-скрипта)
 *  и плоское имя `flatName` в корне каталога (расклад, принятый оркестратором 2026-11-06). */
function add(directory) {
    const manifest = readManifest();
    const needed = JSON.parse(fs.readFileSync(NEEDED_PATH, 'utf8'));
    const byPath = new Map(needed.packages.map((row) => [row.path, row]));
    const byFlat = new Map();
    for (const row of needed.packages) {
        const flat = flatName(row.name, row.version);
        if (byFlat.has(flat)) throw new Error('Столкновение flat-имён в needed.json: ' + flat);
        byFlat.set(flat, row);
    }
    const files = [];
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, [...prefix, entry.name]);
            else if (entry.isFile() && entry.name.endsWith('.tgz')) files.push([...prefix, entry.name].join('/'));
        }
    };
    const info = fs.statSync(directory);
    if (!info.isDirectory()) throw new Error('Каталог принесённых тарболов не найден: ' + directory);
    walk(directory, []);
    let added = 0;
    const problems = [];
    const unknown = [];
    for (const rel of files.sort()) {
        const row = byPath.get(rel) ?? byFlat.get(rel.split('/').pop());
        if (!row) {
            unknown.push(rel);
            continue;
        }
        const entry = manifest.packages.find((item) => item.path === row.path);
        if (!entry) {
            problems.push(rel + ': нет записи в manifest');
            continue;
        }
        if (entry.status !== 'pending') {
            problems.push(rel + ': ожидался pending, статус ' + entry.status);
            continue;
        }
        const source = path.join(directory, ...rel.split('/'));
        const bytes = fs.readFileSync(source);
        const bad = row.expected.filter((item) => createHash(item.algorithm).update(bytes).digest('hex') !== item.hex);
        if (bad.length) {
            problems.push(rel + ': digest не совпадает: ' + bad.map((item) => item.algorithm).join(', '));
            continue;
        }
        const target = supplyFile(row.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        entry.status = 'vendored';
        entry.sha512 = sha512Sri(bytes);
        added++;
        console.log('OK: ' + entry.name + '@' + entry.version);
    }
    writeJson(MANIFEST_PATH, manifest);
    const refreshed = writePendingDocs(manifest);
    const pending = manifest.packages.filter((item) => item.status === 'pending');
    console.log(
        `Добавлено: ${added}; неизвестных файлов: ${unknown.length}; ошибок: ${problems.length}. vendor-pending/ обновлён (${refreshed.packages.length} pending).`
    );
    for (const item of problems) console.error('  ' + item);
    for (const item of unknown) console.error('  unknown: ' + item);
    if (pending.length) {
        console.log(`${pending.length} pending: ждём тарболы:`);
        for (const item of pending) console.log('  ' + item.name + '@' + item.version);
    }
    if (problems.length) process.exitCode = 1;
}

/** --rebuild-pending: перегенерировать vendor-pending/ (needed.json + fetch-скрипт) из manifest. */
function rebuildPending() {
    const manifest = readManifest();
    const needed = writePendingDocs(manifest);
    console.log(`vendor-pending/ перегенерирован: ${needed.packages.length} pending (needed.json + fetch-on-online-machine.sh)`);
}

/** --check: офлайн-гард supply-набора. */
function check() {
    const manifest = readManifest();
    const rows = supplySet();
    const manifestByPath = new Map(manifest.packages.map((item) => [item.path, item]));
    const problems = [];
    // 1) Совпадение supply-набора (lockfile + snapshot) и manifest.
    const current = new Set(rows.map((row) => row.path));
    const inManifest = new Set(manifestByPath.keys());
    for (const p of current) if (!inManifest.has(p)) problems.push('manifest: нет записи для пары из lockfile: ' + p);
    for (const p of inManifest) if (!current.has(p)) problems.push('manifest: лишняя запись (пара больше не в supply-наборе): ' + p);
    // 2) Vendored: файл на месте, sha512 == manifest, SRI lockfile совпадает с байтами.
    for (const item of manifest.packages) {
        if (item.status !== 'vendored') continue;
        const file = supplyFile(item.path);
        if (!fs.existsSync(file)) {
            problems.push('vendored, файла нет: ' + item.path);
            continue;
        }
        const bytes = fs.readFileSync(file);
        if (item.sha512 !== sha512Sri(bytes)) {
            problems.push('sha512 не совпадает с manifest: ' + item.path);
            continue;
        }
        const row = rows.find((r) => r.path === item.path);
        if (row) {
            for (const sri of row.integrity) {
                if (sriDigest(bytes, sri) !== sri) problems.push('SRI lockfile не совпадает: ' + item.path + ' ' + sri);
            }
        }
    }
    // 3) Pending — ЯВНЫЙ отчёт (не ошибка).
    const pending = manifest.packages.filter((item) => item.status === 'pending');
    if (problems.length) {
        console.error(`Vendor-набор: ${problems.length} проблем:`);
        for (const item of problems) console.error('  ' + item);
        process.exitCode = 1;
    } else {
        console.log(`Vendor-набор OK: ${manifest.packages.length - pending.length} vendored (верифицированы), ${manifest.packages.length} всего.`);
    }
    if (pending.length) {
        console.log(`${pending.length} pending: ждём тарболы (fetch-on-online-machine.sh -> vendor.mjs --add):`);
        for (const item of pending) console.log('  ' + item.name + '@' + item.version + '  ' + item.path);
    }
}

/** --snapshot: read-only переопрос registry по всем парам 13 lockfile. */
async function snapshot() {
    const pairs = new Map();
    for (const relative of LOCKFILES) {
        for (const [key, pair] of scanLockfilePairs(path.join(root, relative))) {
            const existing = pairs.get(key);
            if (existing) for (const value of pair.integrity) existing.integrity.add(value);
            else pairs.set(key, { name: pair.name, version: pair.version, integrity: new Set(pair.integrity) });
        }
    }
    const list = [...pairs.values()].sort((a, b) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version, 'en'));
    const rows = await mapConcurrent(list, 8, async (pair) => {
        const inRegistry = await registryHasVersion(pair.name, pair.version);
        const cached = inRegistry ? null : await cacacheInfo(pair.name, pair.version);
        return { key: pair.name + '@' + pair.version, integrity: [...pair.integrity].sort(), source: inRegistry ? 'registry' : cached ? 'cacache' : 'missing' };
    });
    const packages = {};
    for (const row of rows) packages[row.key] = { integrity: row.integrity, source: row.source };
    writeJson(SNAPSHOT_PATH, { schemaVersion: 1, registry: TRUSTED_REGISTRY, packages });
    const bySource = rows.reduce((acc, row) => ((acc[row.source] = (acc[row.source] || 0) + 1), acc), {});
    console.log(`Snapshot записан: ${path.relative(root, SNAPSHOT_PATH)}`);
    console.log(`Пар: ${rows.length}; по источникам: ` + Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(', '));
}

export { expectedDigests, flatName, npmjsTarballUrl };

// CLI-ветка только при прямом запуске (импорт из тестов не трогает dispatch).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const mode = process.argv[2];
    if (!['--extract', '--add', '--check', '--snapshot', '--rebuild-pending'].includes(mode)) usage();
    if (mode === '--extract') await extract();
    else if (mode === '--add') add(process.argv[3]);
    else if (mode === '--check') check();
    else if (mode === '--rebuild-pending') rebuildPending();
    else await snapshot();
}
