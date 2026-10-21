import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const {Pool} = require('pg');
const dist = process.env.PUBLICATION_SCENARIO_DIST || fileURLToPath(new URL('../../services/catalog-service/dist/', import.meta.url));
const {PluginRepository} = require(path.join(dist, 'publication/plugin-repository.js'));
const {ProjectAssetRepository} = require(path.join(dist, 'catalog/project-asset-repository.js'));
const {buildPackage} = require(path.join(dist, 'catalog/bundle-package.js'));
const {ensureCatalogSchema} = require(path.join(dist, 'database/catalog-schema.js'));
const {InstallPlans} = require(path.join(dist, 'devices/install-plans.js'));
const {resolveInstallationSet} = require(path.join(dist, 'devices/installation-set.js'));
const historical = process.env.PUBLICATION_SCENARIO_MODE === 'historical-red';
const adminUrl = process.env.PUBLICATION_SCENARIO_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin = new Pool({connectionString: adminUrl, max: 2});
const poolErrors = [];
admin.on('error', error => poolErrors.push(error.code || error.message));
const database = 'nc_publication_scenario_' + randomBytes(8).toString('hex');
const before = (await admin.query('SELECT datname,oid FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const checks = [], findings = [];
let pool, repository, created = false, dropped = false, fatal;
const actor = {email: 'scenario@example.test', activeRole: 'Главный админ'};
const project = 'prj-publication-scenario';
const config = {transport: 'remote', url: 'https://example.test/mcp'};
const input = (name, extra = {}) => ({name, kind: 'mcp', description: name, config, publicationKey: randomUUID(), ...extra});
const packageFor = async (kind, id, version) => {
    const plugin = await repository.get(id), saved = await repository.version(id, version);
    assert.ok(plugin && saved, 'Нужен точный исторический снимок');
    const dependencies = saved.metadata?.dependencies || [];
    const packedConfig = dependencies.length ? {...saved.config, extra: {...saved.config?.extra,
        requirements: {mcp: [], plugins: [], dependencies}}} : saved.config;
    return buildPackage({id, name: plugin.name, kind, version}, saved.files.map(file => ({path: file.path, content: file.content ?? ''})), '', packedConfig);
};
const pinFor = async (plugin, version = plugin.version) => {
    const pkg = await packageFor(plugin.kind, plugin.id, version);
    return {kind: plugin.kind, id: plugin.id, version, manifest: pkg.manifest.sha256};
};
const rejectWithoutMutation = async (work, id, action) => {
    const previous = id && await repository.get(id);
    await assert.rejects(work, error => error.status === 409);
    if (id) {
        assert.deepEqual(await repository.get(id), previous);
        assert.equal((await pool.query('SELECT count(*)::int n FROM ai_plugin_versions WHERE ai_plugin_id=$1', [id])).rows[0].n, previous.version);
        assert.equal((await pool.query('SELECT count(*)::int n FROM security_events WHERE resource_id=$1 AND action=$2', [id, action])).rows[0].n, 0);
    }
};
try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const url = new URL(adminUrl); url.pathname = '/' + database;
    pool = new Pool({connectionString: url.href, max: 5});
    pool.on('error', error => poolErrors.push(error.code || error.message));
    await ensureCatalogSchema(pool);
    repository = new PluginRepository(pool);
    const assets = new ProjectAssetRepository(pool);
    await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [project,'Publication scenario fixture']);
    const base = await repository.create(input('Базовая зависимость'), actor.email);
    const basePin = await pinFor(base);
    const oldOwner = await repository.create(input('Исторический владелец pin', {dependencies: [basePin]}), actor.email);
    await repository.update(oldOwner.id, {dependencies: [], expectedVersion: 1}, actor.email);
    assert.equal(await repository.delete(base.id, actor.email),true);assert.ok((await repository.get(base.id)).archivedAt);
    const restore=await pool.connect();try{await restore.query('BEGIN');await repository.archive(restore,base.id,actor.email,{restore:true});await restore.query('COMMIT');}finally{restore.release();}
    assert.equal((await repository.versions(base.id)).length, 1);
    checks.push('S14: архив зависимости сохраняет исторический pin и точную версию; явное восстановление возвращает возможность назначения');

    const b = await repository.create(input('B зависит от A1', {dependencies: [basePin]}), actor.email);
    const bPin = await pinFor(b);
    if (historical) {
        const broken = await repository.update(base.id, {dependencies: [bPin], expectedVersion: 1}, actor.email);
        for (const item of [base, b]) await assets.add(project, item.id, item.kind, actor.email);
        await assert.rejects(resolveInstallationSet(pool, project, await packageFor(broken.kind, broken.id, broken.version), packageFor), error => error.status === 409);
        findings.push({confirmed: true, trigger: 'A2 → B1 → A1', publicationAccepted: true, installationStatus: 409,
            consequence: 'Сохранённая версия не имеет устанавливаемого замкнутого комплекта'});
        checks.push('RED S14→S15: публикация A2→B1→A1 принята, подготовка её установки завершается 409');
    } else {
        await rejectWithoutMutation(() => repository.update(base.id, {dependencies: [bPin], expectedVersion: 1}, actor.email), base.id, 'plugin.update');
        checks.push('S14: обновление A2→B1→A1 отклонено 409 до новой версии и аудита');
    }

    const shared = await repository.create(input('Общая leaf'), actor.email);
    const sharedPin1 = await pinFor(shared);
    const left = await repository.create(input('Левая ветвь', {dependencies: [sharedPin1]}), actor.email);
    const shared2 = await repository.update(shared.id, {description: 'Новая leaf версия', expectedVersion: 1}, actor.email);
    const right = await repository.create(input('Правая ветвь', {dependencies: [await pinFor(shared2)]}), actor.email);
    const incompatible = input('Несовместимые транзитивные версии', {dependencies: [await pinFor(left), await pinFor(right)]});
    if (historical) {
        const broken = await repository.create(incompatible, actor.email);
        for (const item of [shared, left, right, broken]) await assets.add(project, item.id, item.kind, actor.email);
        await assert.rejects(resolveInstallationSet(pool, project, await packageFor(broken.kind, broken.id, broken.version), packageFor), error => error.status === 409);
        findings.push({confirmed: true, trigger: 'Root→Left1→Shared1 + Root→Right1→Shared2', publicationAccepted: true, installationStatus: 409});
        checks.push('RED S14→S15: разные транзитивные версии одного ID опубликованы и не устанавливаются');
    } else {
        await assert.rejects(repository.create(incompatible, actor.email), error => error.status === 409);
        assert.equal((await pool.query('SELECT 1 FROM ai_plugins WHERE name=$1', [incompatible.name])).rowCount, 0);
        checks.push('S14: несовместимые транзитивные pins при создании отклонены 409 без карточки');
    }

    if (!historical) {
        const legacy = await repository.create(input('Старая версия с циклом'), actor.email);
        const legacyChild = await repository.create(input('Старая зависимая ветвь', {dependencies: [await pinFor(legacy)]}), actor.email);
        const legacyPin = await pinFor(legacyChild);
        // Старая реализация позволяла A2→B1→A1; моделируем только собственную историю до исправления.
        const legacyVersion = await repository.version(legacy.id, 1);
        await pool.query(`INSERT INTO ai_plugin_versions(ai_plugin_id,version,files,config,metadata)
            VALUES($1,2,$2::jsonb,$3::jsonb,$4::jsonb),($1,3,$2::jsonb,$3::jsonb,$5::jsonb)`,
        [legacy.id, JSON.stringify(legacyVersion.files), JSON.stringify(legacyVersion.config),
            JSON.stringify({...legacyVersion.metadata, dependencies: [legacyPin]}), JSON.stringify(legacyVersion.metadata)]);
        await pool.query('UPDATE ai_plugins SET version=3 WHERE id=$1', [legacy.id]);
        const legacyHistory = await repository.versions(legacy.id);
        await rejectWithoutMutation(() => repository.activate(legacy.id, 2, actor.email), legacy.id, 'plugin.activate');
        assert.deepEqual(await repository.versions(legacy.id), legacyHistory);
        assert.equal(await repository.delete(legacyChild.id, actor.email),true);assert.ok(await repository.version(legacyChild.id,1));
        checks.push('S14: активация старого циклического снимка отклонена до новой версии/аудита; история и точные pins сохраняются при архивировании');

        const fragile = await repository.create(input('Временно недоступная точная leaf'), actor.email);
        const fragileVersion = (await pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1', [fragile.id])).rows[0];
        const branch = await repository.create(input('Ветвь с недоступной leaf', {dependencies: [await pinFor(fragile)]}), actor.email);
        const retryBody = input('Повтор после восстановления leaf', {dependencies: [await pinFor(branch)]});
        await pool.query('DELETE FROM ai_plugin_versions WHERE ai_plugin_id=$1', [fragile.id]);
        await assert.rejects(repository.create(retryBody, actor.email), error => error.status === 409);
        assert.equal((await pool.query('SELECT 1 FROM ai_plugins WHERE name=$1', [retryBody.name])).rowCount, 0);
        await pool.query(`INSERT INTO ai_plugin_versions(ai_plugin_id,version,files,config,author,note,metadata,created_at)
            VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb,$8)`, [fragile.id, fragileVersion.version,
            JSON.stringify(fragileVersion.files), JSON.stringify(fragileVersion.config), fragileVersion.author, fragileVersion.note,
            JSON.stringify(fragileVersion.metadata), fragileVersion.created_at]);
        const retried = await repository.create(retryBody, actor.email);
        assert.equal((await repository.create(retryBody, actor.email)).id, retried.id);
        checks.push('S14: недоступная транзитивная версия отклонена; восстановление точного снимка позволяет тот же requestKey, повтор не создаёт дубль');

        let chain;
        for (let index = 0; index < 20; index++) {
            chain = await repository.create(input('Цепочка ' + index, {dependencies: chain ? [await pinFor(chain)] : []}), actor.email);
        }
        const tooMany = input('Двадцать первый инструмент', {dependencies: [await pinFor(chain)]});
        await assert.rejects(repository.create(tooMany, actor.email), error => error.status === 409);
        assert.equal((await pool.query('SELECT 1 FROM ai_plugins WHERE name=$1', [tooMany.name])).rowCount, 0);
        checks.push('S14: двадцать инструментов вместе с корнем разрешены; двадцать первый отклонён до публикации');
        const files = Array.from({length: 100}, (_, index) => ({path: index ? `f${index}.txt` : 'index.mjs', content: 'x'}));
        const localConfig = {transport: 'stdio', command: 'node', entrypoint: 'index.mjs'};
        const leafFiles = await repository.create(input('Сто файлов leaf', {config: localConfig, files}), actor.email);
        const parentFiles = await repository.create(input('Двести файлов комплекта', {config: localConfig, files, dependencies: [await pinFor(leafFiles)]}), actor.email);
        const tooManyFiles = input('Двести первый файл', {config: localConfig, files: [{path: 'index.mjs', content: 'x'}], dependencies: [await pinFor(parentFiles)]});
        await assert.rejects(repository.create(tooManyFiles, actor.email), error => error.status === 409);
        assert.equal((await pool.query('SELECT 1 FROM ai_plugins WHERE name=$1', [tooManyFiles.name])).rowCount, 0);
        checks.push('S14: двести файлов вместе с корнем разрешены; двести первый отклонён до публикации');
    }

    const sameRight = await repository.create(input('Правая совместимая ветвь', {dependencies: [sharedPin1]}), actor.email);
    const diamond = await repository.create(input('Совместимый ромб', {dependencies: [await pinFor(left), await pinFor(sameRight)]}), actor.email);
    for (const item of [shared, left, sameRight, diamond]) await assets.add(project, item.id, item.kind, actor.email);
    const currentSharedPin=await pinFor(shared2);
    await assets.pin(project,shared.id,shared.kind,actor.email,{version:1,expectedVersion:2,expectedManifest:currentSharedPin.manifest});
    const set = await resolveInstallationSet(pool, project, await packageFor(diamond.kind, diamond.id, diamond.version), packageFor);
    assert.equal(set.packages.length, 4);
    assert.equal(set.packages.find(pkg => pkg.plugin.id === shared.id).plugin.version, 1);
    checks.push('S14/S15: совместимый ромб читает исторический Shared1 вместо head Shared2 и устанавливает leaf один раз');

    const plans = new InstallPlans({pool, access: {claims: async () => ({userRoles: ['Главный админ']})}}, {build: packageFor});
    const prepared = await plans.prepare(actor, {projectId: project, assetKind: diamond.kind, assetId: diamond.id, version: 1});
    const repeated = await plans.prepare(actor, {projectId: project, assetKind: diamond.kind, assetId: diamond.id, version: 1});
    assert.equal(prepared.id, repeated.id);
    const approved = await plans.decide(actor, prepared.id, {expectedRevision: prepared.revision, expectedManifest: prepared.manifest}, 'approved');
    await repository.update(diamond.id, {description: 'Head после одобрения', expectedVersion: 1}, actor.email);
    const delivered = await plans.delivery(approved.id, project, diamond.kind, diamond.id, 1, approved.revision, approved.manifest);
    assert.equal(delivered.package.plugin.version, 1); assert.equal(delivered.installSet.manifest, approved.manifest);
    await assert.rejects(plans.decide(actor, prepared.id, {expectedRevision: prepared.revision, expectedManifest: prepared.manifest}, 'revoked'), error => error.status === 409);
    const revoked = await plans.decide(actor, prepared.id, {expectedRevision: approved.revision, expectedManifest: approved.manifest}, 'revoked');
    await assert.rejects(plans.delivery(revoked.id, project, diamond.kind, diamond.id, 1, approved.revision, approved.manifest), error => error.status === 409);
    await assert.rejects(plans.delivery(revoked.id, project, diamond.kind, diamond.id, 1, revoked.revision, revoked.manifest), error => error.status === 409);
    checks.push('S15: повтор prepare возвращает один план; head не подменяет одобренный комплект, CAS и отзыв блокируют старую доставку');
    const reapproved = await plans.decide(actor, prepared.id, {expectedRevision: revoked.revision, expectedManifest: revoked.manifest}, 'approved');
    assert.ok(await plans.delivery(reapproved.id, project, diamond.kind, diamond.id, 1, reapproved.revision, reapproved.manifest));
    await assets.remove(project, shared.id, shared.kind, actor.email);
    const withoutLeaf=await plans.delivery(reapproved.id, project, diamond.kind, diamond.id, 1, reapproved.revision, reapproved.manifest);
    assert.equal(withoutLeaf.installSet.manifest,reapproved.manifest);
    assert.equal(withoutLeaf.installSet.packages.find(pkg=>pkg.plugin.id===shared.id).plugin.version,1);
    await assets.remove(project,diamond.id,diamond.kind,actor.email);
    await assert.rejects(plans.delivery(reapproved.id,project,diamond.kind,diamond.id,1,reapproved.revision,reapproved.manifest),error=>error.status===403);
    await assets.add(project,diamond.id,diamond.kind,actor.email);
    await assets.pin(project,diamond.id,diamond.kind,actor.email,{version:1,expectedVersion:2,expectedManifest:(await pinFor(await repository.get(diamond.id))).manifest});
    assert.ok(await plans.delivery(reapproved.id, project, diamond.kind, diamond.id, 1, reapproved.revision, reapproved.manifest));
    checks.push('S15: одобренный immutable граф разрешает exact leaf без отдельного назначения; удаление root запрещает доставку, явный возврат прежнего root pin восстанавливает её');

} catch (error) { fatal = error.stack || String(error); process.exitCode = 1; console.error(fatal); }
finally {
    await pool?.end();
    if (created) { await admin.query(`DROP DATABASE "${database}"`); dropped = true; }
    const after = (await admin.query('SELECT datname,oid FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const preserved = before.every(item => after.some(current => current.datname === item.datname && current.oid === item.oid));
    await admin.end();
    const filename = path.resolve(process.env.PUBLICATION_SCENARIO_REPORT || 'output/scenario-audit-20261018/catalog/publication-db.json');
    const ok = !fatal && dropped && preserved && !poolErrors.length;
    await mkdir(path.dirname(filename), {recursive: true});
    await writeFile(filename, JSON.stringify({ok, mode: historical ? 'historical-red' : 'green', checks, findings, fatal: fatal || null,
        database, ownDatabaseDropped: dropped, originalDatabasesPreserved: preserved, beforeDatabases: before, afterDatabases: after,
        poolErrors, realCatalogRowsCreated: false}, null, 2) + '\n');
    if (!ok) process.exitCode = 1;
    console.log(JSON.stringify({ok, mode: historical ? 'historical-red' : 'green', scenarios: checks.length, findings: findings.length}));
}
