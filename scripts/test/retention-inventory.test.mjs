/**
 * AD-D3 (entry 5.7): retention-таблица — единый источник «ресурс → retention mode + TTL».
 *
 * Invariant'ы:
 *  1. Полнота: каждая CREATE TABLE в DDL-исходниках (src каждого сервиса, без тестов/фикстур)
 *     зарегистрирована в deploy/production/retention.json — 0 накопителей вне таблицы.
 *  2. Нет устаревших записей: каждая табличная запись retention.json существует в DDL,
 *     и указанный в `ddl` файл реально содержит её CREATE TABLE.
 *  3. Режимы: mode из разрешённого набора; ttl → значение; rolling-n → rollingN>=1;
 *     none/manual → непустая reason; project-scoped → непустой cascadeRef (story 11).
 *  4. Идентичность TTL (OQ-1): значения, зафиксированные в retention.json, совпадают
 *     с константами в коде/DDL (без импорта JSON в NestJS — таблица = данные, drift ловит тест).
 *  5. Отрицательный самоконтроль: новый CREATE TABLE без записи обязан пойматься.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RETENTION_FILE = path.join(root, 'deploy/production/retention.json');
const MODES = ['ttl', 'rolling-n', 'manual', 'project-scoped', 'none'];
const CREATE_TABLE_RE =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;

/** DDL-исходники: .ts/.sql под services/<service>/src с CREATE TABLE; тесты и фикстуры исключены. */
function discoverDdlFiles() {
    const files = [];
    const servicesDir = path.join(root, 'services');
    for (const service of fs.readdirSync(servicesDir)) {
        const srcDir = path.join(servicesDir, service, 'src');
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) continue;
        for (const file of fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
            if (!/\.(ts|sql)$/.test(file)) continue;
            const rel = path.join('services', service, 'src', file).split(path.sep).join('/');
            if (/[/\\]test[/\\]|\.test\.|fixture/i.test(rel)) continue;
            if (fs.readFileSync(path.join(srcDir, file), 'utf8').includes('CREATE TABLE')) files.push(rel);
        }
    }
    return files;
}

/** Таблицы из текста DDL: имя → множество файлов. */
function parseTables(text) {
    const tables = new Map();
    for (const match of text.matchAll(CREATE_TABLE_RE)) {
        if (!tables.has(match[1])) tables.set(match[1], new Set());
        tables.get(match[1]).add(match.index);
    }
    return tables;
}

const retention = JSON.parse(fs.readFileSync(RETENTION_FILE, 'utf8'));
const resources = retention.resources;
const byName = new Map();
for (const item of resources) {
    assert.ok(!byName.has(item.resource), `дубликат ресурса в retention.json: ${item.resource}`);
    byName.set(item.resource, item);
}
const ddlFiles = discoverDdlFiles();
const ddlTables = new Map();
for (const file of ddlFiles) {
    const tables = parseTables(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const [name] of tables) {
        if (!ddlTables.has(name)) ddlTables.set(name, new Set());
        ddlTables.get(name).add(file);
    }
}

test('retention: полнота — 0 DDL-накопителей вне retention.json', () => {
    const missing = [...ddlTables.keys()].filter((name) => !byName.has(name)).sort();
    assert.deepEqual(
        missing,
        [],
        `таблицы без записи в retention.json:\n${missing.map((name) => `  ${name} (${[...ddlTables.get(name)].join(', ')})`).join('\n')}`,
    );
    console.log(
        `retention-inventory: DDL-таблиц ${ddlTables.size}, файлов с DDL ${ddlFiles.length}, ресурсов ${resources.length} — покрытие 100%`,
    );
});

test('retention: нет устаревших записей (каждая таблица существует в DDL)', () => {
    const stale = resources
        .filter((item) => item.kind === 'table' && !ddlTables.has(item.resource))
        .map((item) => item.resource);
    assert.deepEqual(stale, [], `записи без CREATE TABLE в DDL: ${stale.join(', ')}`);
});

test('retention: поле ddl указывает на файлы, содержащие CREATE TABLE ресурса', () => {
    const bad = [];
    for (const item of resources) {
        if (item.kind !== 'table') continue;
        for (const file of item.ddl) {
            const text = fs.readFileSync(path.join(root, file), 'utf8');
            if (!parseTables(text).has(item.resource)) bad.push(`${item.resource}: ${file}`);
        }
    }
    assert.deepEqual(bad, [], `неверные ddl-ссылки:\n${bad.join('\n')}`);
});

test('retention: режимы валидны (ttl-значение, rollingN, reason для none/manual, cascadeRef для project-scoped)', () => {
    const bad = [];
    for (const item of resources) {
        if (!MODES.includes(item.mode)) {
            bad.push(`${item.resource}: неизвестный mode '${item.mode}'`);
            continue;
        }
        if (item.mode === 'ttl' && !/^\d+(d|m|h)$/.test(item.ttl || ''))
            bad.push(`${item.resource}: ttl='${item.ttl}'`);
        if (
            (item.mode === 'rolling-n' && !Number.isInteger(item.rollingN)) ||
            (item.mode === 'rolling-n' && item.rollingN < 1)
        )
            bad.push(`${item.resource}: rollingN=${item.rollingN}`);
        if (
            (item.mode === 'none' || item.mode === 'manual') &&
            !(typeof item.reason === 'string' && item.reason.trim())
        )
            bad.push(
                `${item.resource}: mode=${item.mode} без причины (AD-D3: «none» только с зафиксированной причиной)`,
            );
        if (item.mode === 'project-scoped' && !(typeof item.cascadeRef === 'string' && item.cascadeRef.trim()))
            bad.push(`${item.resource}: project-scoped без ссылки на каскад (story 11)`);
    }
    assert.deepEqual(bad, [], bad.join('\n'));
});

/** Все interval-константы (minutes/days) в тексте DDL/кода: [{value, unit}]. */
function listIntervals(text) {
    return [...text.matchAll(/interval\s*'\s*(\d+)\s*(minutes|days)\s*'/gi)].map((match) => ({
        value: Number(match[1]),
        unit: match[2].toLowerCase(),
    }));
}
function ttlToInterval(ttl) {
    const match = /^(\d+)([dmh])$/.exec(ttl);
    assert.ok(match, `некорректный ttl '${ttl}'`);
    return { value: Number(match[1]), unit: { d: 'days', m: 'minutes', h: 'hours' }[match[2]] };
}

/** OQ-1: значения в retention.json идентичны константам в коде/DDL (код дублирует значения, drift ловит тест). */
const TTL_IDENTITY_CHECKS = [
    {
        resource: 'bridge_pairs',
        files: ['services/catalog-service/src/devices/device-schema.ts'],
    },
    {
        resource: 'chat_presence_sessions',
        files: ['services/catalog-service/src/chat-activity/chat-presence.service.ts'],
    },
    {
        resource: 'project_chat_typing_sessions',
        files: ['services/catalog-service/src/chat-activity/chat-presence.service.ts'],
    },
];
for (const check of TTL_IDENTITY_CHECKS) {
    test(`retention: TTL идентичен коду — ${check.resource}`, () => {
        const item = byName.get(check.resource);
        assert.ok(item, `ресурс ${check.resource} отсутствует в retention.json`);
        const expected = ttlToInterval(item.ttl);
        for (const file of check.files) {
            const intervals = listIntervals(fs.readFileSync(path.join(root, file), 'utf8'));
            assert.ok(
                intervals.some((interval) => interval.value === expected.value && interval.unit === expected.unit),
                `${file}: нет interval '${expected.value} ${expected.unit}' (найдено: ${JSON.stringify(intervals)}) — drift от retention.json ttl '${item.ttl}'`,
            );
        }
    });
}
test('retention: функциональный TTL токена bridge_devices (30d) идентичен DDL и device-store', () => {
    const item = byName.get('bridge_devices');
    assert.ok(item, 'bridge_devices отсутствует в retention.json');
    const expected = { value: item.tokenTtlDays, unit: 'days' };
    for (const file of [
        'services/catalog-service/src/devices/device-schema.ts',
        'services/catalog-service/src/devices/device-store.ts',
    ]) {
        const intervals = listIntervals(fs.readFileSync(path.join(root, file), 'utf8'));
        assert.ok(
            intervals.some((interval) => interval.value === expected.value && interval.unit === expected.unit),
            `${file}: нет interval '${expected.value} ${expected.unit}' (найдено: ${JSON.stringify(intervals)}) — drift от retention.json tokenTtlDays=${item.tokenTtlDays}`,
        );
    }
});

test('retention: skill-versions — rolling N из таблицы совпадает с AD-D3(5) и якорем в коде', () => {
    const item = byName.get('skill-versions');
    assert.ok(item, 'skill-versions отсутствует в retention.json');
    assert.equal(item.mode, 'rolling-n');
    assert.equal(item.rollingN, 2, 'AD-D3(5): rolling N=2');
    const storage = fs.readFileSync(path.join(root, 'services/skills-service/src/storage/skill-versions.ts'), 'utf8');
    assert.ok(
        storage.includes(`export const SKILL_VERSIONS_DIRECTORY = '${item.path}'`),
        `skill-versions.ts: SKILL_VERSIONS_DIRECTORY ≠ retention.json path '${item.path}'`,
    );
});

test('retention: новый CREATE TABLE без записи обязан пойматься (отрицательный самоконтроль)', () => {
    const probe = `CREATE TABLE retention_unregistered_probe (id text PRIMARY KEY);`;
    const detected = [...parseTables(probe).keys()].filter((name) => !byName.has(name));
    assert.deepEqual(detected, ['retention_unregistered_probe'], 'детектор не поймал незарегистрированную таблицу');
    const known = [...parseTables('CREATE TABLE IF NOT EXISTS security_events (event_id UUID);').keys()].filter(
        (name) => !byName.has(name),
    );
    assert.deepEqual(known, [], 'известная таблица ошибочно признана незарегистрированной');
});
