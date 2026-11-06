#!/usr/bin/env node
// AD-15 (vendor-схема): классификация всех (name, version) пар 13 lockfile'ов.
//
//   node scripts/supply/classify.mjs
//
// Корзина:
//   registry    — пара есть в доверенном registry И актуальна для linux-x64 (resolved → local registry)
//   platform    — пара пропускется npm на linux-x64 по os/cpu (resolved НЕ трогать — npmjs)
//   vendored    — нет в registry, есть в cacache, актуальна (resolved → file: supply/vendor)
//   pending     — нет нигде, актуальна (resolved → file: supply/vendor, статус pending)
import fs from 'node:fs';
import path from 'node:path';
import { LOCKFILES, root, scanLockfilePairs, TRUSTED_REGISTRY } from './registry.mjs';

const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'scripts/supply/registry-availability.json'), 'utf8'));

/** Особи os/cpu из самих lockfile-записей (npm записывает поля манифеста пакета). */
const platformInfo = new Map(); // key -> { os: Set|null, cpu: Set|null, entries: number }
/** Имя пакета из ключа node_modules/... (для алиасов — явное поле name записи). */
const nameFromPath = (item, entryKey) => {
    if (typeof item.name === 'string') return item.name;
    const segments = entryKey.split('node_modules/');
    const tail = segments[segments.length - 1];
    const parts = tail.split('/');
    return parts.length === 2 && parts[0].startsWith('@') ? tail : parts[parts.length - 1];
};

for (const relative of LOCKFILES) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    for (const [entryKey, item] of Object.entries(lock.packages || {})) {
        if (!item || typeof item !== 'object' || typeof item.version !== 'string') continue;
        const key = nameFromPath(item, entryKey) + '@' + item.version;
        const info = platformInfo.get(key) ?? { os: null, cpu: null, entries: 0 };
        info.entries += 1;
        if (Array.isArray(item.os)) info.os = new Set([...(info.os ?? []), ...item.os]);
        if (Array.isArray(item.cpu)) info.cpu = new Set([...(info.cpu ?? []), ...item.cpu]);
        platformInfo.set(key, info);
    }
}

const hostOk = (info) => {
    if (!info) return true;
    if (info.os && !info.os.has('linux')) return false;
    if (info.cpu && !info.cpu.has('x64')) return false;
    return true;
};

const buckets = { registry: [], platform: [], vendored: [], pending: [] };
const unpaired = [];
for (const [key, row] of Object.entries(snapshot.packages)) {
    const info = platformInfo.get(key);
    if (!info) {
        unpaired.push(key);
        continue;
    }
    const relevant = hostOk(info);
    if (row.source === 'registry') buckets[relevant ? 'registry' : 'platform'].push(key);
    else if (row.source === 'cacache') buckets[relevant ? 'vendored' : 'platform'].push(key);
    else buckets[relevant ? 'pending' : 'platform'].push(key);
}
for (const bucket of Object.values(buckets)) bucket.sort();

const report = {
    generatedBy: 'scripts/supply/classify.mjs',
    host: 'linux-x64 (glibc; musl-варианты считаются актуальными и попадают в pending)',
    total: Object.keys(snapshot.packages).length,
    counts: Object.fromEntries(Object.entries(buckets).map(([name, list]) => [name, list.length])),
    unpaired,
    buckets,
};
const out = path.join(root, 'scripts/supply/classification.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`Всего пар: ${report.total}`);
for (const [name, list] of Object.entries(buckets)) console.log(`${name}: ${list.length}`);
if (unpaired.length) console.log('unpaired (нет os/cpu-записи в lockfile):', unpaired);
console.log('Записано: ' + path.relative(root, out));
