import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { startSkillPackagingFixture } from './skill-packaging.fixture.mjs';
import { assertIndexEvolution } from '../../vendor/asset-contract/lib/repository.mjs';

/**
 * Entry 2.10 (epic-trust-device-catalog): UJ-2 — провенанс-карточка одобренного комплекта.
 *
 * Скоуп (frozen):
 *  - FR-203: карточка показывает 5 полей провенанса активной версии (версия + SHA manifest +
 *    источник origin/revision + время createdAt + издатель author); данные — существующие
 *    GET /versions + GET /package (OQ2: без нового API).
 *  - FR-202: immutability версий — INSERT-only ai_plugin_versions (static), повторная публикация
 *    той же версии = отказ (pkey, не перезапись), vendor-уровень assertIndexEvolution;
 *    одобренный комплект = точный pin (version+manifest), зависимости сверяются по точным pins.
 *  - FR-201: SHA-опись (per-file sha256 + manifest.sha256 + filesCount) — server-issued;
 *    self-check verifyPackage перед отдачей /package; source envelope 4 доверенных источников.
 *  - RETAINED_PROVENANCE (OQ3): retired-версия (entry 7) остаётся в каталоге с провенансом;
 *    статус показывается, если поле уже присутствует в данных.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogRequire = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
catalogRequire('reflect-metadata');
const { buildPackage, verifyPackage } = catalogRequire('./dist/catalog/bundle-package.js');
const { CatalogController } = catalogRequire('./dist/catalog/catalog.controller.js');
const { checkedProjectPackage } = catalogRequire('./dist/catalog/project-asset-pins.js');
const { verifyInstallationSet, installationSetHash } = catalogRequire('./dist/devices/installation-set.js');
const { ConflictException, InternalServerErrorException } = catalogRequire('@nestjs/common');

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Плагин-фикстура для чистых (без PG) проверок пакета и провенанса. */
const makePluginPkg = (id, version, config = { entrypoint: 'index.js' }) =>
    buildPackage(
        { id, name: id, kind: 'plugin', version },
        [{ path: 'index.js', content: `module.exports = '${id}:${version}';` }],
        '2026-11-09T00:00:00.000Z',
        config,
    );

// ---------------------------------------------------------------------------
// FR-202 static: ai_plugin_versions — INSERT-only (история версий не перезаписывается).
// Единственное допущенное исключение — AD-13 (entry 2.11): metadata-only UPDATE только что
// созданной строки в той же publishing-транзакции (не история, не head, не байты версии).
// ---------------------------------------------------------------------------
test('FR-202 static: no UPDATE/DELETE/TRUNCATE on ai_plugin_versions outside the AD-13 metadata-only publish', async () => {
    const dir = path.join(root, 'services/catalog-service/src');
    const files = [];
    const walk = async (current) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith('.ts')) files.push(full);
        }
    };
    await walk(dir);
    const patterns = [
        { kind: 'update', re: /UPDATE\s+ai_plugin_versions\b/gi },
        { kind: 'delete', re: /DELETE\s+FROM\s+ai_plugin_versions\b/gi },
        { kind: 'truncate', re: /TRUNCATE\s+(?:TABLE\s+)?ai_plugin_versions\b/gi },
    ];
    const hits = [];
    for (const file of files) {
        const text = await fs.readFile(file, 'utf8');
        for (const { kind, re } of patterns) {
            for (const match of text.matchAll(re)) {
                hits.push({ kind, file: path.relative(dir, file), text, offset: match.index });
            }
        }
    }
    const deleteOrTruncate = hits.filter((hit) => hit.kind !== 'update');
    assert.deepEqual(
        deleteOrTruncate.map((hit) => `${hit.kind}:${hit.file}`),
        [],
        'DELETE/TRUNCATE по ai_plugin_versions запрещены: история версий immutable.',
    );
    const updates = hits.filter((hit) => hit.kind === 'update');
    assert.deepEqual(
        updates.map((hit) => hit.file).sort(),
        ['asset-sources/tool-adapter.ts'],
        'Единственный UPDATE — AD-13 (contractVersion в metadata) в tool-adapter.ts.',
    );
    // Допущённый UPDATE должен касаться только колонки metadata той же строки.
    const start = updates[0].text.lastIndexOf('`', updates[0].offset),
        end = updates[0].text.indexOf('`', updates[0].offset);
    const sql = updates[0].text.slice(start, end + 1);
    const setClause = sql.match(/SET\s+([\s\S]*?)\s+WHERE\s/i);
    assert.ok(setClause, 'AD-13 UPDATE: SET-клауза не найдена.');
    assert.match(setClause[1].trim(), /^metadata\s*=\s*COALESCE\(metadata/i, 'AD-13 UPDATE — только metadata.');
});

// ---------------------------------------------------------------------------
// FR-202 vendor: опубликованные байты не меняются, retired необратим (assertIndexEvolution).
// ---------------------------------------------------------------------------
const indexEntry = (id, version, sha256Value, { current = false, status } = {}) => ({
    id,
    kind: 'mcp',
    version,
    path: `assets/${id}/${version}/asset.json`,
    sha256: sha256Value,
    current,
    ...(status ? { status } : {}),
});
test('FR-202 vendor: published version bytes immutable, disappearance and re-activation rejected', () => {
    const v1 = sha256('v1-bytes'),
        v2 = sha256('v2-bytes'),
        v3 = sha256('v3-bytes');
    const previous = { schemaVersion: 1, assets: [indexEntry('qa-vendor', '2.0.0', v2, { current: true }), indexEntry('qa-vendor', '1.0.0', v1)] };
    // Байты опубликованной версии изменились.
    const bytesChanged = {
        schemaVersion: 1,
        assets: [indexEntry('qa-vendor', '2.0.0', v2, { current: true }), indexEntry('qa-vendor', '1.0.0', sha256('tampered'))],
    };
    assert.throws(() => assertIndexEvolution(previous, bytesChanged), /bytes or kind changed/);
    // Опубликованная версия исчезла из индекса.
    const disappeared = { schemaVersion: 1, assets: [indexEntry('qa-vendor', '2.0.0', v2, { current: true })] };
    assert.throws(() => assertIndexEvolution(previous, disappeared), /cannot disappear/);
    // Retired-версия вернулась в active.
    const previousRetired = {
        schemaVersion: 1,
        assets: [indexEntry('qa-vendor', '2.0.0', v2, { current: true }), indexEntry('qa-vendor', '1.0.0', v1, { status: 'retired' })],
    };
    const reactivated = {
        schemaVersion: 1,
        assets: [indexEntry('qa-vendor', '2.0.0', v2, { current: true }), indexEntry('qa-vendor', '1.0.0', v1)],
    };
    assert.throws(() => assertIndexEvolution(previousRetired, reactivated), /cannot return to active/);
    // Легитимная эволюция: head сместился на новую версию, старые сохранены.
    const evolved = {
        schemaVersion: 1,
        assets: [
            indexEntry('qa-vendor', '3.0.0', v3, { current: true }),
            indexEntry('qa-vendor', '2.0.0', v2),
            indexEntry('qa-vendor', '1.0.0', v1),
        ],
    };
    assert.doesNotThrow(() => assertIndexEvolution(previous, evolved));
});

// ---------------------------------------------------------------------------
// FR-201 self-check: /package пересчитывает SHA-опись перед отдачей; битый пакет не уходит.
// ---------------------------------------------------------------------------
test('FR-201 self-check: GET /package rejects a package whose SHA inventory does not verify', async () => {
    const pkg = makePluginPkg('ai-plug-selfcheck', 1);
    assert.equal(verifyPackage(pkg), true);
    const controller = (value) => new CatalogController({ getAiPluginPackage: async () => value }, {});
    const served = await controller(pkg).getAiPluginPackage('ai-plug-selfcheck', '1');
    assert.equal(served.manifest.sha256, pkg.manifest.sha256);
    // Перезаписан content файла: per-file sha256 и manifest устарели.
    const corrupted = makePluginPkg('ai-plug-selfcheck', 1);
    corrupted.files[0].content = 'module.exports = "tampered";';
    assert.equal(verifyPackage(corrupted), false);
    await assert.rejects(
        controller(corrupted).getAiPluginPackage('ai-plug-selfcheck', '1'),
        (error) => error instanceof InternalServerErrorException && /SHA-опись/.test(error.message),
    );
    // Подменяется только manifest-хэш (сервер выдал несогласованный отпечаток).
    const forged = makePluginPkg('ai-plug-selfcheck', 1);
    forged.manifest.sha256 = 'f'.repeat(64);
    await assert.rejects(controller(forged).getAiPluginPackage('ai-plug-selfcheck', '1'), InternalServerErrorException);
});

// ---------------------------------------------------------------------------
// FR-202 одобренный комплект: установка только из точного пина (version + manifest).
// ---------------------------------------------------------------------------
test('FR-202 approved kit: only the exact pinned version and manifest are installable', () => {
    const pkg = makePluginPkg('ai-plug-pinned', 2);
    const row = (overrides = {}) => ({
        project_id: 'prj-qa',
        asset_id: 'ai-plug-pinned',
        asset_kind: 'plugin',
        added_by: 'admin@example.test',
        added_at: '2026-11-09T00:00:00.000Z',
        asset_version: 2,
        asset_manifest: pkg.manifest.sha256,
        pin_origin: 'assigned',
        pin_snapshot: { card: { id: 'ai-plug-pinned' }, package: pkg },
        ...overrides,
    });
    assert.equal(checkedProjectPackage(row()).manifest.sha256, pkg.manifest.sha256);
    assert.throws(() => checkedProjectPackage(row({ asset_version: 3 })), ConflictException, 'Чужая версия пина не выдаётся.');
    assert.throws(() => checkedProjectPackage(row({ asset_manifest: 'f'.repeat(64) })), ConflictException, 'Чужой SHA пина не выдаётся.');
    assert.throws(
        () => checkedProjectPackage(row({ asset_version: null, asset_manifest: null, pin_snapshot: null })),
        ConflictException,
        'Незакреплённое назначение (unresolved) не выдаёт пакет.',
    );
    const stale = makePluginPkg('ai-plug-pinned', 2);
    stale.files[0].content = 'module.exports = "replaced";';
    assert.throws(
        () => checkedProjectPackage(row({ pin_snapshot: { card: { id: 'ai-plug-pinned' }, package: stale } })),
        ConflictException,
        'Байты снимка, не совпадающие с закреплённым SHA, не выдаются.',
    );
});

// ---------------------------------------------------------------------------
// FR-202 зависимости: комплект свёрка точных pins (kind/id/version/manifest) при установке.
// ---------------------------------------------------------------------------
test('FR-202 dependencies: exact dependency pins (kind/id/version/manifest) are verified on install', () => {
    const dep = makePluginPkg('ai-plug-dep', 3);
    const rootPkg = makePluginPkg('ai-plug-root', 2, {
        entrypoint: 'index.js',
        extra: {
            requirements: {
                mcp: [],
                plugins: [],
                dependencies: [{ kind: 'plugin', id: 'ai-plug-dep', version: 3, manifest: dep.manifest.sha256 }],
            },
        },
    });
    const ref = { kind: 'plugin', id: 'ai-plug-root', version: 2, manifest: rootPkg.manifest.sha256 };
    const okSet = {
        schemaVersion: 1,
        root: ref,
        packages: [rootPkg, dep],
        manifest: installationSetHash(ref, [rootPkg, dep]),
    };
    assert.equal(verifyInstallationSet(okSet), true, 'Закреплённый комплект с зависимостью проходит.');
    // Зависимость с другой версией, чем pin.
    const wrongVersion = makePluginPkg('ai-plug-dep', 4);
    assert.equal(
        verifyInstallationSet({ ...okSet, packages: [rootPkg, wrongVersion], manifest: installationSetHash(ref, [rootPkg, wrongVersion]) }),
        false,
    );
    // Зависимость с другим SHA (байты заменили, версия та же).
    const wrongSha = makePluginPkg('ai-plug-dep', 3);
    wrongSha.files[0].content = 'module.exports = "dep-tampered";';
    assert.equal(
        verifyInstallationSet({ ...okSet, packages: [rootPkg, wrongSha], manifest: installationSetHash(ref, [rootPkg, wrongSha]) }),
        false,
    );
});

// ---------------------------------------------------------------------------
// PG-часть: API-данные карточки, 4 источника, immutability-поведение, pin-политика.
// ---------------------------------------------------------------------------
const pluginBody = (suffix, { origin, revision, files = [{ path: 'index.js', content: `module.exports = '${suffix}';` }] } = {}) => ({
    name: `QA UJ2 ${suffix}`,
    kind: 'plugin',
    description: 'UJ-2 provenance QA',
    origin,
    ...(revision !== undefined ? { revision } : {}),
    config: { entrypoint: 'index.js' },
    files,
});

test('UJ-2 API: provenance card data, 4 trusted sources, version immutability, pin policy', {
    skip: !process.env.CATALOG_TEST_PG_URL ? 'CATALOG_TEST_PG_URL не задана' : false,
    timeout: 300000,
}, async (t) => {
    const f = await startSkillPackagingFixture({ adminUrl: process.env.CATALOG_TEST_PG_URL });
    t.after(async () => {
        await f.close();
    });
    const base = f.catalogUrl;
    const mainActor = { email: f.actors.main.email, activeRole: 'Главный админ' };
    const devActor = { email: f.actors.developer.email, activeRole: 'Разработчик' };
    const call = async (method, url, { actor = mainActor, body } = {}) => {
        const response = await fetch(url, {
            method,
            headers: {
                'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
                'x-bridge-actor': encodeURIComponent(JSON.stringify(actor)),
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(60000),
        });
        let data = null;
        try {
            data = await response.json();
        } catch {
            /* non-JSON */
        }
        return { status: response.status, data };
    };
    const run = randomUUID().slice(0, 8);

    // CARD_PROVENANCE (FR-203): 5 полей провенанса из /versions + /package.
    await t.test('FR-203 card provenance: version + SHA + source + time + author from existing endpoints', async () => {
        const suffix = `prov-${run}`;
        const created = await call('POST', base + '/api/ai-plugins', {
            body: pluginBody(suffix, { origin: 'https://github.com/qa/provenance-repo', revision: 'v1.4.2' }),
        });
        assert.ok([200, 201].includes(created.status), `create: ${created.status} ${JSON.stringify(created.data)}`);
        const id = created.data.id;
        const versions = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/versions`);
        assert.equal(versions.status, 200);
        assert.equal(versions.data.length, 1);
        const version = versions.data[0];
        const pkgResponse = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/package?version=1`);
        assert.equal(pkgResponse.status, 200, JSON.stringify(pkgResponse.data));
        const pkg = pkgResponse.data;
        // Версия.
        assert.equal(version.version, 1);
        assert.equal(pkg.plugin.version, 1);
        // SHA — server-issued manifest, self-verified.
        assert.match(pkg.manifest.sha256, /^[a-f0-9]{64}$/);
        assert.equal(verifyPackage(pkg), true);
        assert.equal(pkg.manifest.filesCount, pkg.files.length);
        for (const file of pkg.files) {
            assert.equal(sha256(file.content), file.sha256, `per-file sha256: ${file.path}`);
        }
        // Источник (origin + revision) — source envelope из метаданных версии.
        assert.equal(version.metadata?.origin, 'https://github.com/qa/provenance-repo');
        assert.equal(version.metadata?.revision, 'v1.4.2');
        // Время и издатель.
        assert.doesNotThrow(() => new Date(version.createdAt).toISOString());
        assert.equal(version.author, mainActor.email);
        t.context = { ...(t.context ?? {}), id, version };
    });

    // FR-201 4 источника: source envelope сохраняется, SHA-опись полная; невалидный — отказ.
    await t.test('FR-201 sources: npm/GitHub/archive/ready-runtime envelopes kept, SHA inventory complete', async () => {
        const sources = [
            { name: 'npm', origin: 'https://www.npmjs.com/package/qa-npm-tool', revision: 'v1.2.3' },
            { name: 'github', origin: 'https://github.com/qa/qa-repo', revision: '0123456789abcdef0123456789abcdef01234567' },
            { name: 'archive', origin: sha256('qa-archive-bytes'), revision: null },
            { name: 'ready-runtime', origin: 'neurocenter:recipe/qa-runtime-recipe', revision: null },
        ];
        for (const source of sources) {
            const suffix = `${source.name}-${run}`;
            const created = await call('POST', base + '/api/ai-plugins', {
                body: pluginBody(suffix, { origin: source.origin, revision: source.revision }),
            });
            assert.ok([200, 201].includes(created.status), `${source.name}: create ${created.status}`);
            const id = created.data.id;
            const versions = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/versions`);
            assert.equal(versions.status, 200);
            const version = versions.data.find((entry) => entry.version === 1);
            assert.equal(version.metadata?.origin, source.origin, `${source.name}: origin`);
            assert.equal(version.metadata?.revision ?? null, source.revision, `${source.name}: revision`);
            const pkgResponse = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/package?version=1`);
            assert.equal(pkgResponse.status, 200, `${source.name}: package`);
            assert.equal(verifyPackage(pkgResponse.data), true, `${source.name}: SHA-опись`);
            assert.match(pkgResponse.data.manifest.sha256, /^[a-f0-9]{64}$/);
        }
        // Неверная source envelope отклоняется при публикации.
        const rejected = await call('POST', base + '/api/ai-plugins', {
            body: pluginBody(`bad-${run}`, { origin: 'a'.repeat(300) }),
        });
        assert.equal(rejected.status, 400, `invalid envelope: ${rejected.status}`);
    });

    // REVISION_IMMUTABLE (FR-202 behavior): новая редакция получает новую версию; повторный
    // INSERT той же (ai_plugin_id, version) = pkey-конфликт, строка истории не перезаписывается.
    await t.test('FR-202 re-publish: version always advances; same-version insert refused, row untouched', async () => {
        const { id } = t.context;
        const updated = await call('PATCH', `${base}/api/ai-plugins/${encodeURIComponent(id)}`, {
            body: {
                description: 'UJ-2 provenance QA v2',
                expectedVersion: 1,
                files: [{ path: 'index.js', content: 'module.exports = 2;' }],
            },
        });
        assert.equal(updated.status, 200, JSON.stringify(updated.data));
        assert.equal(updated.data.version, 2);
        const versions = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/versions`);
        assert.deepEqual(
            versions.data.map((entry) => entry.version),
            [2, 1],
            'История append-only: новая редакция = новая версия, старая строка на месте.',
        );
        const before = await f.pool.query(
            'SELECT files,author,metadata FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=1',
            [id],
        );
        const conflict = await f.pool
            .query(
                'INSERT INTO ai_plugin_versions (ai_plugin_id,version,files,config,author,note) VALUES ($1,1,$2::jsonb,null,$3,$4)',
                [id, JSON.stringify([{ path: 'index.js', content: 'module.exports = "forged";' }]), 'intruder', 'forged'],
            )
            .catch((error) => error);
        assert.equal(conflict.code, '23505', 'Повторная публикация той же версии — pkey-конфликт, а не перезапись.');
        const after = await f.pool.query(
            'SELECT files,author,metadata FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=1',
            [id],
        );
        assert.deepEqual(after.rows, before.rows, 'Историческая строка не изменена конфликтом.');
    });

    // KIT_PIN_ONLY (FR-202 комплект): закрепление версии — только админ проекта (level ≥ 3);
    // пин хранит точную версию + manifest одобренного комплекта.
    await t.test('FR-202 pin policy: developer (level < 3) cannot assign the approved kit', async () => {
        const { id } = t.context;
        const pinUrl = `${base}/api/projects/${f.projectId}/assets/pin`;
        const denied = await call('PATCH', pinUrl, {
            actor: devActor,
            body: { assetId: id, assetKind: 'plugin', version: 1, expectedVersion: null, expectedManifest: null },
        });
        assert.equal(denied.status, 403, JSON.stringify(denied.data));
        // Админ добавляет актив в проект (назначение head), затем закрепляет точную версию 1.
        const added = await call('POST', `${base}/api/projects/${f.projectId}/assets`, {
            body: { assetId: id, assetKind: 'plugin' },
        });
        assert.ok([200, 201].includes(added.status), JSON.stringify(added.data));
        const before = (
            await f.pool.query('SELECT asset_version, asset_manifest FROM project_assets WHERE project_id=$1 AND asset_id=$2', [
                f.projectId,
                id,
            ])
        ).rows[0];
        assert.ok(before, 'Назначение создано.');
        const pinned = await call('PATCH', pinUrl, {
            body: {
                assetId: id,
                assetKind: 'plugin',
                version: 1,
                expectedVersion: before.asset_version,
                expectedManifest: before.asset_manifest,
            },
        });
        assert.equal(pinned.status, 200, JSON.stringify(pinned.data));
        const after = (
            await f.pool.query('SELECT asset_version, asset_manifest, pin_origin FROM project_assets WHERE project_id=$1 AND asset_id=$2', [
                f.projectId,
                id,
            ])
        ).rows[0];
        assert.equal(after.asset_version, 1, 'Закреплена точная версия, а не head.');
        assert.match(after.asset_manifest, /^[a-f0-9]{64}$/, 'Пин хранит manifest одобренного комплекта.');
        const pkgResponse = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/package?version=1`);
        assert.equal(after.asset_manifest, pkgResponse.data.manifest.sha256, 'SHA пина = SHA пакета версии.');
        t.context = { ...t.context, pinnedManifest: after.asset_manifest };
    });

    // RETAINED_PROVENANCE (OQ3): retired-версия остаётся в каталоге; провенанс и SHA-карточка
    // достижимы. Статус — из данных версии (поле даёт entry 7); здесь фиксируем состояние данных.
    await t.test('retained provenance: retired version stays listed with provenance and package', async () => {
        const { id } = t.context;
        // Тестовая симуляция состояния, которое создаёт entry 7 (retire): статус в metadata версии.
        await f.pool.query(
            "UPDATE ai_plugin_versions SET metadata = metadata || '{\"status\":\"retired\"}'::jsonb WHERE ai_plugin_id=$1 AND version=1",
            [id],
        );
        const versions = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/versions`);
        assert.equal(versions.status, 200);
        const retained = versions.data.find((entry) => entry.version === 1);
        assert.ok(retained, 'Retired-версия не удаляется из истории.');
        assert.equal(retained.metadata?.status, 'retired');
        assert.equal(retained.metadata?.origin, 'https://github.com/qa/provenance-repo', 'Провенанс сохранён.');
        assert.equal(retained.author, mainActor.email, 'Издание сохранено.');
        assert.doesNotThrow(() => new Date(retained.createdAt).toISOString(), 'Время публикации сохранено.');
        const pkgResponse = await call('GET', `${base}/api/ai-plugins/${encodeURIComponent(id)}/package?version=1`);
        assert.equal(pkgResponse.status, 200, 'Пакет retired-версии по-прежнему выдаётся с SHA-описью.');
        assert.equal(verifyPackage(pkgResponse.data), true);
    });
});
