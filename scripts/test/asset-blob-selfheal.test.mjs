/**
 * 12.8 (R9): self-сверка описи поставки с blob-хранилищем на старте catalog-service.
 *
 * Unit-уровень поверх собранного dist: фейковый pool (ответы по тексту SQL) и фейковый
 * fetch (upstream по карте URL). Без БД и сети; фикстуры ассетов проходят настоящий
 * validateAsset контракта.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const { AssetBlobStore } = require('./dist/asset-sources/asset-blob-store.js');
const { validateAsset } = require('@neurocenter/asset-contract');
const digest = (value) => createHash('sha256').update(value).digest('hex');

let skipReason;
before(async () => {
    // reserveCapacity требует ≥1 GiB резерва на файловой системе каталога.
    const stat = await fs.statfs(os.tmpdir());
    if (stat.bavail * stat.bsize < 2 * 1024 ** 3) skipReason = 'недостаточно свободного места для capacity-резерва';
});
const guard = (t) => {
    if (skipReason) {
        t.skip(skipReason);
        return true;
    }
    return false;
};

/** Bridge-descriptor ровно в той форме, которую проверяет контракт; URL — pinned GitHub release. */
function bridgeFixture({ version = '0.10.0', repository = 'qa-owner/bridge-assets', supplyBytes } = {}) {
    const bytes = supplyBytes ?? Buffer.from('Synthetic bridge supply: ' + version + ' self-heal');
    const buildId = digest('bridge-build-' + version);
    const file = 'neurocenter-asset-sync-linux-x64-' + version + '.tgz';
    const url = 'https://github.com/' + repository + '/releases/download/bridge-v' + version + '/' + file;
    const descriptor = validateAsset({
        schemaVersion: 1,
        id: 'neurocenter-bridge',
        kind: 'bridge',
        version,
        license: { spdx: 'MIT' },
        compatibility: { bridgeProtocol: 2 },
        source: { type: 'release', repository: 'https://github.com/' + repository, tag: 'bridge-v' + version },
        card: { name: 'QA Bridge', description: 'Synthetic immutable bridge release.' },
        delivery: {
            type: 'bridge-release',
            release: {
                schemaVersion: 1,
                release: 'bridge-v' + version,
                version,
                buildId,
                artifacts: [
                    {
                        file,
                        url,
                        metadata: {
                            version,
                            buildId,
                            target: 'linux-x64',
                            nodeVersion: '24.22.0',
                            ragSupported: true,
                            probeEngine: { file: 'bin/opencode-probe', version: '1.0.0', sha256: digest('probe') },
                            sha256: digest(bytes),
                            bytes: bytes.length,
                        },
                    },
                ],
            },
        },
    });
    return { descriptor, url, bytes, sha: digest(bytes) };
}

/** Remote-модель: валидный descriptor без адресов доставки — downloadArtifacts возвращает []. */
function modelFixture() {
    const descriptor = validateAsset({
        schemaVersion: 1,
        id: 'model-selfheal-qa',
        kind: 'model',
        version: '1.0.0',
        license: { spdx: 'MIT' },
        compatibility: { packageFormat: 5 },
        source: { type: 'git', repository: 'https://github.com/qa-owner/model-assets', commit: 'b'.repeat(40) },
        card: {
            id: 'model-selfheal-qa',
            name: 'QA remote model',
            descriptor: {
                description: 'Synthetic remote model.',
                capability: 'chat',
                runtime: 'remote-openai',
                model: 'selfheal-qa',
                modelVersion: '1',
                manifestSha256: null,
                dimension: null,
                verificationSha256: null,
                source: 'custom',
            },
        },
        delivery: { type: 'remote-api' },
    });
    return { descriptor };
}

function makePool({ inventory = [], descriptors = {} } = {}) {
    return {
        async query(sql, params) {
            if (sql.includes('FROM asset_source_blobs ORDER BY')) return { rows: inventory };
            if (sql.includes('FROM asset_source_blobs b')) return { rows: descriptors[params?.[0]] ?? [] };
            if (sql.includes('FROM asset_source_blobs WHERE sha256=$1')) {
                const row = inventory.find((item) => item.sha256 === params?.[0]);
                return { rows: row ? [{ bytes: String(row.bytes) }] : [] };
            }
            throw new Error('Непредвиденный запрос: ' + sql);
        },
    };
}

function makeUpstream(map) {
    const calls = [];
    async function request(url) {
        calls.push(String(url));
        const entry = map.get(String(url));
        if (!entry || entry.status !== 200) return new Response(null, { status: entry?.status ?? 404 });
        return new Response(entry.body, { status: 200, headers: { 'content-length': String(entry.body.length) } });
    }
    request.calls = calls;
    return request;
}

async function makeStore(t, { inventory = [], descriptors = {}, upstream, offline = false } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-blob-selfheal-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const pool = makePool({ inventory, descriptors });
    const request = makeUpstream(upstream ?? new Map());
    const store = new AssetBlobStore(pool, directory, request, offline);
    return { store, directory, pool, request };
}

const blobPath = (directory, sha) => path.join(directory, sha + '.blob');
const inventoryRow = (sha, bytes) => ({ sha256: sha, bytes: String(bytes) });
const mutated = (bytes, offset = 0) => {
    const copy = Buffer.from(bytes);
    copy[offset] ^= 0xff;
    return copy;
};
const signal = () => new AbortController().signal;
const run = (store) => store.selfHeal(signal());

test('Целостный файл: опись подтверждается без сети', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    await fs.writeFile(blobPath(directory, bridge.sha), bridge.bytes, { mode: 0o600 });
    const report = await run(store);
    assert.deepEqual(report, { checked: 1, intact: 1, restored: [], pending: [] });
    assert.equal(request.calls.length, 0);
});

test('Отсутствующий файл: восстановлен из зарегистрированного источника', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    const report = await run(store);
    assert.deepEqual(report, { checked: 1, intact: 0, restored: [bridge.sha], pending: [] });
    assert.deepEqual(request.calls, [bridge.url]);
    const file = await fs.lstat(blobPath(directory, bridge.sha));
    assert.equal(file.mode & 0o777, 0o400);
    assert.equal(file.nlink, 1);
    assert.equal(file.size, bridge.bytes.length);
    assert.equal(digest(await fs.readFile(blobPath(directory, bridge.sha))), bridge.sha);
});

test('Повреждённый файл того же размера: SHA-сверка ловит замену', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    await fs.writeFile(blobPath(directory, bridge.sha), mutated(bridge.bytes), { mode: 0o600 });
    const report = await run(store);
    assert.deepEqual(report, { checked: 1, intact: 0, restored: [bridge.sha], pending: [] });
    assert.equal(request.calls.length, 1);
    assert.equal(digest(await fs.readFile(blobPath(directory, bridge.sha))), bridge.sha);
    assert.equal((await fs.lstat(blobPath(directory, bridge.sha))).mode & 0o777, 0o400);
});

test('Повреждённый файл другого размера: заменён атомарно', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    await fs.writeFile(blobPath(directory, bridge.sha), bridge.bytes.subarray(0, 5), { mode: 0o600 });
    const report = await run(store);
    assert.deepEqual(report, { checked: 1, intact: 0, restored: [bridge.sha], pending: [] });
    assert.equal(digest(await fs.readFile(blobPath(directory, bridge.sha))), bridge.sha);
});

test('Файл не объявлен ни одним зарегистрированным источником: явный pending', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    const report = await run(store);
    assert.deepEqual(report, {
        checked: 1,
        intact: 0,
        restored: [],
        pending: [
            { sha256: bridge.sha, bytes: bridge.bytes.length, reason: 'no registered source declares this file' },
        ],
    });
    await assert.rejects(fs.access(blobPath(directory, bridge.sha)), { code: 'ENOENT' });
    assert.equal(request.calls.length, 0);
});

test('Источник без адресов доставки (remote-модель): явный pending', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const model = modelFixture();
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: model.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    const report = await run(store);
    assert.deepEqual(report, {
        checked: 1,
        intact: 0,
        restored: [],
        pending: [
            {
                sha256: bridge.sha,
                bytes: bridge.bytes.length,
                reason: 'registered sources do not declare a download URL',
            },
        ],
    });
    await assert.rejects(fs.access(blobPath(directory, bridge.sha)), { code: 'ENOENT' });
    assert.equal(request.calls.length, 0);
});

test('Offline-режим: сетевой restore отключён', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
        offline: true,
    });
    const report = await run(store);
    assert.deepEqual(report, {
        checked: 1,
        intact: 0,
        restored: [],
        pending: [
            { sha256: bridge.sha, bytes: bridge.bytes.length, reason: 'offline mode: network restore is disabled' },
        ],
    });
    assert.equal(request.calls.length, 0);
});

test('Upstream отдаёт другие байты того же размера: restore failed', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: mutated(bridge.bytes, bridge.bytes.length - 1) }]]),
    });
    const report = await run(store);
    assert.equal(report.checked, 1);
    assert.equal(report.restored.length, 0);
    assert.equal(report.pending.length, 1);
    assert.match(report.pending[0].reason, /^restore failed: .*SHA-256 mismatch/);
    await assert.rejects(fs.access(blobPath(directory, bridge.sha)), { code: 'ENOENT' });
    assert.equal(request.calls.length, 1);
});

test('Идемпотентность: повторная сверка не скачивает повторно', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const upstream = new Map([[bridge.url, { status: 200, body: bridge.bytes }]]);
    const { store, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream,
    });
    const first = await run(store);
    assert.deepEqual(first.restored, [bridge.sha]);
    assert.equal(request.calls.length, 1);
    const second = await run(store);
    assert.deepEqual(second, { checked: 1, intact: 1, restored: [], pending: [] });
    assert.equal(request.calls.length, 1);
});

test('Pre-aborted сигнал: AbortError без побочного эффекта', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const { store, directory } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        descriptors: { [bridge.sha]: [{ descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.selfHeal(controller.signal), (error) => error.name === 'AbortError');
    await assert.rejects(fs.access(blobPath(directory, bridge.sha)), { code: 'ENOENT' });
});

test('Смешанная опись: целый файл + отсутствующий', async (t) => {
    if (guard(t)) return;
    const first = bridgeFixture({ version: '0.10.0' });
    const second = bridgeFixture({ version: '0.11.0' });
    const { store, directory, request } = await makeStore(t, {
        inventory: [inventoryRow(first.sha, first.bytes.length), inventoryRow(second.sha, second.bytes.length)],
        descriptors: {
            [first.sha]: [{ descriptor: first.descriptor }],
            [second.sha]: [{ descriptor: second.descriptor }],
        },
        upstream: new Map([
            [first.url, { status: 200, body: first.bytes }],
            [second.url, { status: 200, body: second.bytes }],
        ]),
    });
    await fs.writeFile(blobPath(directory, first.sha), first.bytes, { mode: 0o600 });
    const report = await run(store);
    assert.equal(report.checked, 2);
    assert.equal(report.intact, 1);
    assert.deepEqual(report.restored, [second.sha]);
    assert.deepEqual(report.pending, []);
    assert.deepEqual(request.calls, [second.url]);
});

test('Первая строка описи не даёт файл: fallback на следующий источник', async (t) => {
    if (guard(t)) return;
    const bridge = bridgeFixture();
    const model = modelFixture();
    const { store, request } = await makeStore(t, {
        inventory: [inventoryRow(bridge.sha, bridge.bytes.length)],
        // ORDER BY v.created_at DESC: самая свежая версия первой — и она файл не содержит.
        descriptors: { [bridge.sha]: [{ descriptor: model.descriptor }, { descriptor: bridge.descriptor }] },
        upstream: new Map([[bridge.url, { status: 200, body: bridge.bytes }]]),
    });
    const report = await run(store);
    assert.deepEqual(report, { checked: 1, intact: 0, restored: [bridge.sha], pending: [] });
    assert.deepEqual(request.calls, [bridge.url]);
});
