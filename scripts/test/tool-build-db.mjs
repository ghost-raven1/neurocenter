import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.TOOL_BUILD_TEST_PG_URL).href;

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const {Pool} = require('pg');
const dist = process.env.TOOL_BUILD_TEST_DIST || fileURLToPath(new URL('../../services/catalog-service/dist/', import.meta.url));
const {PackageBuildRepository} = require(path.join(dist, 'package-build/package-build.repository.js'));
const {PluginRepository} = require(path.join(dist, 'publication/plugin-repository.js'));
const {CatalogDb} = require(path.join(dist, 'catalog/catalog-db.js'));
const {PackageBuildService} = require(path.join(dist, 'package-build/package-build.service.js'));
const {RuntimeArtifacts} = require(path.join(dist, 'runtime-artifacts/runtime-artifacts.js'));
const {AssetSourcesService}=require(path.join(dist,'asset-sources/asset-sources.service.js'));
const adminUrl = adminConnection;
const admin = new Pool({connectionString: adminUrl, max: 2});
admin.on('error', error => {console.error('Тестовый административный пул: ' + error.code);});
const database = 'nc_tool_build_test_' + randomBytes(8).toString('hex');
const before = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
let pool, catalog, builds, sources, temporary, created = false, dropped = false, fatal;
const previousEnvironment = {...process.env};
const checks = [];
try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const url = new URL(adminUrl); url.pathname = '/' + database;
    pool = new Pool({connectionString: url.href, max: 5});
    pool.on('error', error => {console.error('Тестовый пул: ' + error.code);});
    process.env.NODE_ENV = 'production';
    catalog = new CatalogDb(url.href); await catalog.setup();
    const repository = new PackageBuildRepository(pool);
    const actor = 'builder@example.test', requestKey = randomUUID();
    const config = {kind: 'plugin', name: 'Тестовый плагин', description: 'Проверка', tags: [], targets: ['darwin-arm64'],
        source: {type: 'files', entrypoint: 'index.mjs', files: [{path: 'index.mjs', content: 'export default async () => ({})'}]}};
    const same = await Promise.all([repository.enqueue(actor, requestKey, 'same-hash', config), repository.enqueue(actor, requestKey, 'same-hash', config)]);
    assert.equal(same[0].id, same[1].id);
    assert.equal((await repository.findByRequest(actor, requestKey)).id, same[0].id);
    await assert.rejects(repository.findByRequest('other@example.test', requestKey), error => error.status === 404);
    assert.equal((await pool.query('SELECT count(*)::int n FROM operations')).rows[0].n, 1);
    await assert.rejects(repository.enqueue(actor, requestKey, 'other-hash', config), error => error.status === 409);
    checks.push('Одновременный повтор создаёт одно задание и одну операцию; другой payload с тем же ключом отклонён');
    const competing = await Promise.allSettled([repository.enqueue('other@example.test', randomUUID(), 'hash', config), repository.enqueue(actor, randomUUID(), 'hash', config)]);
    assert.equal(competing.filter(item => item.status === 'fulfilled').length, 2);
    const waitingIds = competing.map(item => item.value.id);
    checks.push('Запросы разных администраторов получают отдельные задания очереди без ручного повтора');
    await repository.progress(same[0].id, 'RUNNING', 30, 'Сборка');
    assert.equal((await pool.query('SELECT percent FROM operations WHERE operation_id=$1', ['tool-build-' + same[0].id])).rows[0].percent, 30);
    await repository.failInterrupted();
    const interrupted = await repository.get(same[0].id);
    assert.equal(interrupted.state, 'FAILED'); assert.match(interrupted.error, /перезапустился/);
    assert.equal((await repository.existing(actor, requestKey, 'same-hash')).id, interrupted.id);
    const operation = (await pool.query('SELECT state,finished_at,log FROM operations WHERE operation_id=$1', ['tool-build-' + same[0].id])).rows[0];
    assert.equal(operation.state, 'FAILED'); assert.ok(operation.finished_at);
    await repository.failInterrupted();
    assert.deepEqual((await pool.query('SELECT log FROM operations WHERE operation_id=$1', ['tool-build-' + same[0].id])).rows[0].log, operation.log);
    for (const id of waitingIds) assert.equal((await repository.get(id)).state, 'QUEUED');
    checks.push('Перезапуск завершает запущенную сборку ошибкой, сохраняет ожидающие и не дописывает повторно журнал');
    const lease = await pool.connect();
    try {
        await lease.query('SELECT pg_advisory_lock(72465395)');
        const claimed = await repository.takeQueued(lease);
        assert.ok(waitingIds.includes(claimed.id)); assert.equal(claimed.state, 'RUNNING');
        await assert.rejects(repository.takeQueued(lease), error => error.code === '23505');
        assert.equal((await pool.query("SELECT count(*)::int n FROM tool_build_jobs WHERE state='RUNNING'")).rows[0].n, 1);
        for (const id of waitingIds) await repository.progress(id, 'FAILED', 0, 'Проверка ограничения завершена');
    } finally {await lease.query('SELECT pg_advisory_unlock(72465395)');lease.release();}
    checks.push('Индекс PostgreSQL запрещает две RUNNING сборки, сохраняя следующее ожидающее задание');
    const quota = [];
    for (let index = 0; index < 10; index++) quota.push(await repository.enqueue(actor, randomUUID(), 'quota-' + index, config));
    await assert.rejects(repository.enqueue(actor, randomUUID(), 'over-quota', config), error => error.status === 409 && /10/.test(error.message));
    assert.equal((await repository.enqueue(actor, quota[0].request_key, 'quota-0', config)).id, quota[0].id);
    for (const row of quota) await repository.progress(row.id, 'FAILED', 0, 'Проверка ёмкости очереди завершена');
    checks.push('Очередь ограничена десятью заданиями; повтор принятого UUID работает и при заполненной очереди');
    const next = await repository.enqueue(actor, randomUUID(), 'new-hash', config);
    await repository.progress(next.id, 'SUCCEEDED', 100, 'Опубликовано', {catalogId: 'ai-plug-test', name: config.name, version: 1});
    assert.equal((await repository.get(next.id)).result.catalogId, 'ai-plug-test');
    await assert.rejects(repository.progress(next.id, 'RUNNING', 30, 'Поздний ответ'), error => error.status === 409);
    checks.push('Новый запрос после сбоя разрешён; сохранённый результат и терминальное состояние не перезаписываются поздним ответом');
    const failingKey = randomUUID();
    const brokenPool = {async connect() {const client = await pool.connect(); return {query(sql, params) {if (String(sql).startsWith('INSERT INTO operations')) {throw new Error('operation-write-failed');} return client.query(sql, params);}, release() {client.release();}};}};
    await assert.rejects(new PackageBuildRepository(brokenPool).enqueue(actor, failingKey, 'failure', config), /operation-write-failed/);
    assert.equal((await pool.query('SELECT 1 FROM tool_build_jobs WHERE request_key=$1', [failingKey])).rowCount, 0);
    checks.push('Сбой записи «Операций» откатывает задание целиком');
    const publishing = await repository.enqueue(actor, randomUUID(), 'publish-hash', config);
    const publication = {name: 'Атомарная публикация', kind: 'plugin', description: 'Проверка', config: {entrypoint: 'index.mjs'}, files: [{path: 'index.mjs', content: 'export default async () => ({})'}], publicationKey: randomUUID()};
    await assert.rejects(new PluginRepository(pool).create(publication, actor, async (client, plugin) => {
        await repository.completeWithPublication(client, publishing.id, {catalogId: plugin.id, name: plugin.name, version: plugin.version});
        throw new Error('commit-not-reached');
    }), /commit-not-reached/);
    assert.equal((await pool.query('SELECT 1 FROM ai_plugins WHERE name=$1', [publication.name])).rowCount, 0);
    assert.equal((await repository.get(publishing.id)).state, 'QUEUED');
    const published = await new PluginRepository(pool).create(publication, actor, (client, plugin) => repository.completeWithPublication(client, publishing.id, {catalogId: plugin.id, name: plugin.name, version: plugin.version}));
    assert.equal((await repository.get(publishing.id)).result.catalogId, published.id);
    await repository.failInterrupted();
    assert.equal((await repository.get(publishing.id)).state, 'SUCCEEDED');
    checks.push('Публикация и успех задания атомарны: исключение откатывает оба, рестарт после commit сохраняет успешный результат');

    temporary = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-tool-build-'));
    Object.assign(process.env, {CATALOG_PG_URL: url.href, RUNTIME_ARTIFACT_DIR: path.join(temporary, 'runtime'), CAPACITY_REQUIRED: 'false', API_GATEWAY_URL: 'http://127.0.0.1:1'});
    const oldStage = await repository.enqueue(actor, randomUUID(), 'stale-stage-hash', config);
    await repository.progress(oldStage.id, 'RUNNING', 10, 'Подготовка прерванного задания');
    const staging = path.join(temporary, 'runtime', '.build-staging'), unknown = randomUUID();
    await mkdir(path.join(staging, oldStage.id), {recursive: true}); await writeFile(path.join(staging, oldStage.id, 'partial'), 'Незавершённая сборка');
    await mkdir(path.join(staging, unknown)); await writeFile(path.join(staging, unknown, 'keep'), 'Нет записи задания — не трогать');
    const access = {claims: async () => ({userRoles: ['Главный админ']})};
    sources??=new AssetSourcesService({ensureSchema:async()=>undefined},access,new RuntimeArtifacts({pool}));
    if(!sources.worker)await sources.onModuleInit();
    builds = new PackageBuildService(access,new RuntimeArtifacts({pool}),{ensureSchema:async()=>undefined},sources);
    await builds.onModuleInit();
    assert.equal((await repository.get(oldStage.id)).state, 'FAILED');
    await assert.rejects(stat(path.join(staging, oldStage.id)), error => error.code === 'ENOENT');
    assert.equal(await readFile(path.join(staging, unknown, 'keep'), 'utf8'), 'Нет записи задания — не трогать');
    checks.push('Перезапуск очищает staging доказанно прерванного задания и сохраняет неизвестный каталог');
    const marker = path.join(temporary, 'КОД_НЕ_ДОЛЖЕН_ВЫПОЛНИТЬСЯ');
    const job = await builds.create({email: actor, activeRole: 'Главный админ'}, {requestKey: randomUUID(), kind: 'plugin', name: 'Реальная сборка исходников', description: 'JS импортирует TS, собирается без исполнения',
        targets: ['darwin-arm64'], source: {type: 'files', entrypoint: 'index.js', files: [
            {path: 'index.js', content: `import fs from 'node:fs'; import number from 'is-number'; import {text} from './helper.ts'; fs.writeFileSync(${JSON.stringify(marker)}, 'Код исполнился'); export default async () => ({text, number});`},
            {path: 'helper.ts', content: "export const text: string = 'Готово';"},
            {path: 'package.json', content: JSON.stringify({private: true, type: 'module', dependencies: {'is-number': '7.0.0'}, scripts: {postinstall: `node -e "process.exit(13)"`}})},
        ]}});
    const deadline = Date.now() + 60_000;
    let result;
    do {result = await builds.get({email: actor, activeRole: 'Главный админ'}, job.id); if (['SUCCEEDED','FAILED'].includes(result.state)) {break;} await new Promise(resolve => setTimeout(resolve, 100));} while (Date.now() < deadline);
    assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
    const card = (await pool.query('SELECT kind,config,files FROM ai_plugins WHERE id=$1', [result.result.catalogId])).rows[0];
    assert.ok(result.result.assetId);assert.match(result.result.sourceVersion,/^build-[a-f0-9]{64}$/);
    const exported=await builds.exportAsset({email:actor,activeRole:'Главный админ'},job.id);assert.equal(exported.id,result.result.assetId);assert.equal(exported.source.type,'archive');
    assert.equal((await pool.query("SELECT count(*)::int n FROM asset_source_versions WHERE repository='local-archive' AND native_id=$1",[result.result.catalogId])).rows[0].n,1);
    const sourcePath=await sources.blobs.checkedPath(exported.source.sha256,exported.source.bytes);
    await sources.blobs.ingestLocal([{archivePath:sourcePath,sha256:exported.source.sha256,bytes:exported.source.bytes,filename:exported.source.sha256+'.source'}],randomUUID());
    const imported=await builds.importAsset({email:actor,activeRole:'Главный админ'},{requestKey:randomUUID(),asset:exported});assert.equal(imported.catalogId,result.result.catalogId);
    assert.equal(card.kind, 'plugin'); assert.equal(card.config.extra.runtimeArtifacts.length, 1); assert.deepEqual(card.files, []);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bridge_runtime_artifacts')).rows[0].n, 1);
    await assert.rejects(stat(marker), error => error.code === 'ENOENT');
    await builds.onModuleDestroy(); builds = undefined;
    assert.deepEqual(await readdir(path.join(temporary, 'runtime', '.build-staging')), [unknown]);
    checks.push('Настоящий subprocess собирает JS→TS и npm-зависимость в автономный архив, импортирует и публикует карточку; staging очищен, код и postinstall расширения не выполнялись');
    const queued = [];
    for (let index = 0; index < 2; index++) queued.push(await repository.enqueue(actor, randomUUID(), 'resume-' + index,
        {...config, name: 'Ожидавшая сборка ' + index, source: {type: 'files', entrypoint: 'index.mjs', files: [{path: 'index.mjs', content: 'export default async()=>({})'}]}}));
    sources??=new AssetSourcesService({ensureSchema:async()=>undefined},access,new RuntimeArtifacts({pool}));
    if(!sources.worker)await sources.onModuleInit();
    builds = new PackageBuildService(access,new RuntimeArtifacts({pool}),{ensureSchema:async()=>undefined},sources);
    await builds.onModuleInit();
    const resumedUntil = Date.now() + 60000;
    let resumed;
    do {resumed = await Promise.all(queued.map(row => repository.get(row.id))); if (resumed.every(row => ['SUCCEEDED', 'FAILED'].includes(row.state))) break; await new Promise(resolve => setTimeout(resolve, 100));} while (Date.now() < resumedUntil);
    assert.ok(resumed.every(row => row.state === 'SUCCEEDED'), JSON.stringify(resumed));
    assert.equal(new Set(resumed.map(row => row.result.catalogId)).size, 2);
    await builds.onModuleDestroy(); builds = undefined;
    assert.deepEqual(await readdir(staging), [unknown]);
    checks.push('Новый владелец автоматически выполняет два сохранённых QUEUED задания без повторного POST; две карточки, staging очищен');
    if (process.platform !== 'win32') {
        const heartbeat = path.join(temporary, 'heartbeat');
        const grandchild = `const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),30);`;
        const childCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
        const guardian = require.resolve(path.join(dist, 'package-build/build-guardian.js'));
        const child = spawn(process.execPath, ['--require', guardian, '-e', childCode], {detached: true, stdio: ['ignore','ignore','ignore','ipc']});
        const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
        try {
            const until = Date.now() + 3000;
            while (Date.now() < until && !(await stat(heartbeat).catch(() => undefined))) {await new Promise(resolve => setTimeout(resolve, 30));}
            assert.ok(await stat(heartbeat));
            child.disconnect();
            const result = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('guardian-timeout')), 3000))]);
            assert.equal(result.signal, 'SIGKILL');
            await new Promise(resolve => setTimeout(resolve, 100));
            const before = await readFile(heartbeat, 'utf8');
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.equal(await readFile(heartbeat, 'utf8'), before);
            checks.push('Потеря IPC сервера останавливает процесс сборки и его настоящего дочернего писателя');
        } finally {try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') {throw error;}}}
    }
} catch (error) {fatal = error.stack || String(error); process.exitCode = 1; console.error(fatal);}
finally {
    await builds?.onModuleDestroy();
    await sources?.onApplicationShutdown();
    await catalog?.close();
    await pool?.end();
    if (created) {await admin.query(`DROP DATABASE "${database}"`); dropped = true;}
    const after = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    await admin.end();
    if (temporary) {await rm(temporary, {recursive: true, force: true});}
    for (const key of Object.keys(process.env)) {if (!(key in previousEnvironment)) {delete process.env[key];}}
    Object.assign(process.env, previousEnvironment);
    const preserved = JSON.stringify(before) === JSON.stringify(after);
    const filename = path.resolve(process.env.TOOL_BUILD_TEST_REPORT || '.run/tool-build-db-smoke.json');
    await mkdir(path.dirname(filename), {recursive: true});
    await writeFile(filename, JSON.stringify({ok: !fatal && dropped && preserved, checks, fatal: fatal || null,
        ownDatabaseDropped: dropped, originalDatabasesPreserved: preserved, realCatalogRowsCreated: false}, null, 2) + '\n');
    console.log(JSON.stringify({ok: !fatal && dropped && preserved, scenarios: checks.length}));
    if (!preserved) {process.exitCode = 1;}
}
