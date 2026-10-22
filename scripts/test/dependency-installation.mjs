import {seedInstallationProjects,pinInstallationPackage} from './installation-catalog.fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.DEPENDENCY_INSTALLATION_PG_URL).href;

// Все команды и файлы принадлежат временной БД и профилю; личный OpenCode не используется.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const adminUrl = adminConnection;
const admin = new Pool({ connectionString: adminUrl });
const database = 'nc_dependency_test_' + randomBytes(8).toString('hex');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-dependency-installation-')));
const reportPath = process.env.DEPENDENCY_INSTALLATION_REPORT || path.join(root, '.run/dependency-installation.json');
const actor = { email: 'dependency-fixture@example.test', activeRole: 'Главный админ' };
const projectId = 'fixture';
const results = [];
const artifacts = new Map();
const authorizations = new Map();
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
let devices, jobs, installations, plans, server, worker, token, deviceId, project;
let created = false, ownDatabaseDropped = false, originalDatabasesPreserved = false, fatal;

async function check(name, action) { await action(); results.push({ case: name, ok: true }); console.log(name); }
async function waitFor(predicate, label, timeout = 22000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await predicate()) return; await delay(40); }
    throw new Error('Не дождались: ' + label);
}
function startWorker() {
    worker = spawn(process.execPath, [path.join(root, 'mcp/neurocenter-asset-sync/dist/index.js'), '--worker'], {
        env: { ...process.env, HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: path.join(temporary, 'config') },
        cwd: temporary, stdio: ['ignore', 'ignore', 'pipe'],
    });
    worker.stderr.on('data', () => {});
}
async function stopWorker() {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
        const stopped = once(worker, 'exit'); worker.kill('SIGTERM'); await stopped;
    }
    worker = undefined;
}
try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const url = new URL(adminUrl); url.pathname = '/' + database;
    process.env.CATALOG_PG_URL = url.href;
    process.env.NEUROCENTER_BRIDGE_HOME = path.join(temporary, 'bridge');
    const { DeviceStore } = await load('services/catalog-service/dist/devices/device-store.js');
    const { DeviceJobs } = await load('services/catalog-service/dist/devices/device-jobs.js');
    const { DeviceInstallations } = await load('services/catalog-service/dist/devices/device-installations.js');
    const { InstallPlans } = await load('services/catalog-service/dist/devices/install-plans.js');
    const { completeDeviceJob } = await load('services/catalog-service/dist/devices/device-completion.js');
    const { buildPackage } = await load('services/catalog-service/dist/catalog/bundle-package.js');
    const { installationRef, installationRefs, verifyInstallationSet } = await load('services/catalog-service/dist/devices/installation-set.js');
    const claims = async email => ({ email, userRoles: ['Главный админ', 'Разработчик'], projects: [{ projectId, projectName: 'Проверка', role: 'Админ проекта' }] });
    devices = new DeviceStore({ claims }); await devices.onModuleInit();
    await seedInstallationProjects(devices.pool,['fixture'],actor);

    const artifactService = { build: async (kind, id, version) => {
        const pkg = artifacts.get(kind + ':' + id + ':' + version); assert.ok(pkg, 'Точная версия фикстуры существует'); return pkg;
    } };
    plans = new InstallPlans(devices, artifactService);
    installations = new DeviceInstallations(devices);
    jobs = new DeviceJobs(devices, artifactService, installations, plans);
    const register = pkg => { artifacts.set(pkg.plugin.kind + ':' + pkg.plugin.id + ':' + pkg.plugin.version, pkg); return pkg; };
    const requirements = dependencies => ({ extra: { requirements: { mcp: [], plugins: [], dependencies: dependencies.map(installationRef) } } });
    const remote = (id, dependencies = []) => register(buildPackage({ kind: 'mcp', id: 'ai-plug-' + id, name: id, version: 1 }, [], 'now',
        { transport: 'remote', url: `https://${id}.example.test/mcp`, ...(dependencies.length ? requirements(dependencies) : {}) }));
    const shared = remote('shared');
    const left = remote('left', [shared]); const right = remote('right', [shared]);
    const plugin = register(buildPackage({ kind: 'plugin', id: 'ai-plug-plugin', name: 'plugin', version: 1 },
        [{ path: 'index.ts', content: 'export default () => ({ name: "Плагин команды" });\n' }], 'now', { entrypoint: 'index.ts' }));
    const makeSkill = (id, dependencies) => register(buildPackage({ kind: 'skill', id, name: id.split('/').at(-1), version: 1 },
        [{ path: 'SKILL.md', content: 'Инструкция: ' + id }], 'now', requirements(dependencies)));
    const skill = makeSkill('common/main', [left, right, plugin]);
    const second = makeSkill('common/second', [shared]);
    const members = [skill, left, right, shared, plugin];
    for (const pkg of [...members,second]) await pinInstallationPackage(devices.pool,projectId,pkg,actor);
    const credential = randomBytes(32).toString('hex');
    const pair = await devices.start({ name: 'Изолированный компьютер', fingerprint: 'f'.repeat(64), credentialHash: createHash('sha256').update(credential).digest('hex') });
    await devices.approve(actor, pair.userCode); const connected = await devices.poll(pair.deviceCode); token = credential; deviceId = connected.deviceId;
    server = http.createServer(async (request, response) => {
        try {
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            if (request.url === '/internal/events') { response.end('{}'); return; }
            if (!request.url.startsWith('/api/device-channel/')) { response.writeHead(404).end('{}'); return; }
            const device = await devices.identity(String(request.headers.authorization || '').replace(/^Bearer /, ''));
            const route = request.url.slice('/api/device-channel/'.length); let data;
            if (route === 'identity') data = { id: device.id, email: device.email, role: device.role };
            else if (route === 'heartbeat') data = await devices.heartbeat(device, body);
            else if (route === 'jobs/claim') data = await jobs.claim(device);
            else if (route === 'worker/pause') data = await devices.pause(device);
            else if (route === 'worker/resume') data = await devices.resume(device);
            else if (/^jobs\/[^/]+\/authorize$/.test(route)) {
                const id = route.split('/')[1]; authorizations.set(id, (authorizations.get(id) || 0) + 1);
                data = await jobs.authorize(device, id, body.lease);
            } else if (/^jobs\/[^/]+\/progress$/.test(route)) data = await jobs.update(device, route.split('/')[1], body);
            else if (/^jobs\/[^/]+\/complete$/.test(route)) data = await completeDeviceJob(devices.pool, device.id, route.split('/')[1], body);
            else { response.writeHead(404).end('{}'); return; }
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        } catch (error) { response.writeHead(error.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.NEUROCENTER_URL = origin; process.env.API_GATEWAY_URL = origin;
    const { writeState, stateDir, hash } = await load('mcp/neurocenter-asset-sync/dist/bridge/state.js');
    const { setRoot, bindProject, workspaceReport, projectBindingId } = await load('mcp/neurocenter-asset-sync/dist/bridge/workspace.js');
    const { assetBase, receiptPath } = await load('mcp/neurocenter-asset-sync/dist/bridge/installation-receipt.js');
    const { verifyInstallSet } = await load('mcp/neurocenter-asset-sync/dist/bridge/install-set.js');
    const { parse } = createRequire(path.join(root, 'mcp/neurocenter-asset-sync/package.json'))('jsonc-parser');
    project = path.join(temporary, 'проекты', 'копия с другим именем'); await fs.mkdir(path.join(project, '.opencode'), { recursive: true });
    const configPath = path.join(project, '.opencode/opencode.jsonc');
    await fs.writeFile(configPath, '// Личная настройка фикстуры\n{ "theme":"fixture", "mcp": { "personal": { "type":"remote", "url":"https://personal.example.test" } }, "plugin":["fixture-personal-plugin"], }\n');
    await writeState('credentials', { token, deviceId, email: actor.email });
    await setRoot(path.dirname(project)); await bindProject(projectId, path.basename(project));
    await devices.heartbeat(await devices.identity(token), await workspaceReport());
    const state = async id => (await devices.pool.query('SELECT * FROM bridge_jobs WHERE id=$1', [id])).rows[0];
    const approve = async pkg => {
        const plan = await plans.prepare(actor, { projectId, assetKind: pkg.plugin.kind, assetId: pkg.plugin.id, version: pkg.plugin.version });
        return plans.decide(actor, plan.id, { expectedManifest: plan.manifest, expectedRevision: plan.revision }, 'approved');
    };
    const create = (pkg, plan) => jobs.create(actor, { deviceId, projectId, kind: 'install', assetKind: pkg.plugin.kind, assetId: pkg.plugin.id,
        version: pkg.plugin.version, planId: plan.id, planRevision: plan.revision, expectedManifest: plan.manifest, requestKey: randomUUID() });
    const remove = async pkg => jobs.create(actor, { deviceId, projectId, kind: 'uninstall', assetKind: pkg.plugin.kind, assetId: pkg.plugin.id,
        expectedBindingId: await projectBindingId(projectId), expectedManifest: pkg.manifest.sha256, requestKey: randomUUID() });
    const run = async (job, expected = 'succeeded') => {
        startWorker();
        await waitFor(async () => ['succeeded', 'failed'].includes((await state(job.id)).state), 'завершения worker');
        await stopWorker(); const completed = await state(job.id);
        assert.equal(completed.state, expected, completed.message); return completed;
    };
    const fullReport = await workspaceReport();
    const oldReport = { ...fullReport, capabilities: fullReport.capabilities.filter(value => value !== 'install-set-v1') };
    let prepared, approved, installJob, completed, installedSet;
    await check('Подготовка закрепляет пять пакетов и отдельный SHA полного комплекта', async () => {
        prepared = await plans.prepare(actor, { projectId, assetKind: 'skill', assetId: skill.plugin.id, version: 1 });
        assert.equal(prepared.packages.length, 5); assert.notEqual(prepared.manifest, skill.manifest.sha256);
        installedSet = (await devices.pool.query('SELECT installation_set FROM device_install_plans WHERE id=$1', [prepared.id])).rows[0].installation_set;
        assert.ok(verifyInstallationSet(installedSet)); assert.deepEqual(verifyInstallSet(installedSet), installationRefs(members));
    });
    await check('Неодобренный комплект не попадает в очередь', async () => {
        await assert.rejects(create(skill, prepared), error => error.status === 409);
        assert.equal((await devices.pool.query('SELECT count(*)::int AS n FROM bridge_jobs')).rows[0].n, 0);
    });
    await check('Админ одобряет SHA всего графа; решение сохраняется в аудите', async () => {
        approved = await plans.decide(actor, prepared.id, { expectedManifest: prepared.manifest, expectedRevision: prepared.revision }, 'approved');
        assert.equal(approved.status, 'approved');
        assert.equal((await devices.pool.query("SELECT count(*)::int AS n FROM security_events WHERE action='installation.approved'")).rows[0].n, 1);
    });
    await check('Старый capability не получает комплект даже до первой установки', async () => {
        await devices.heartbeat(await devices.identity(token), oldReport);
        await assert.rejects(create(skill, approved), error => error.status === 409);
        await devices.heartbeat(await devices.identity(token), fullReport);
    });
    await check('Пакет задания остаётся исходным после изменения каталога', async () => {
        register(buildPackage(skill.plugin, [{ path: 'SKILL.md', content: 'Новый head не одобрен' }], 'later', skill.config));
        register(buildPackage(plugin.plugin, [{ path: 'index.ts', content: 'export default "Новый head"' }], 'later', plugin.config));
        installJob = await create(skill, approved);
        const queued = await state(installJob.id);
        assert.deepEqual(queued.payload.package, skill); assert.deepEqual(queued.payload.installSet, installedSet);
    });
    await check('Completion с чужим составом отклоняется без ложного успешного результата', async () => {
        const claimed = await jobs.claim(await devices.identity(token)); assert.equal(claimed.id, installJob.id);
        const receipt = { projectId, assetId: skill.plugin.id, version: 1, manifest: installedSet.manifest, bindingId: claimed.payload.bindingId,
            packages: installationRefs(members), unchanged: true };
        await assert.rejects(completeDeviceJob(devices.pool, deviceId, claimed.id, { lease: claimed.lease, state: 'succeeded', message: 'Подмена',
            result: { ...receipt, packages: receipt.packages.slice(1) } }), error => error.status === 409);
        assert.equal((await state(claimed.id)).state, 'running');
        await completeDeviceJob(devices.pool, deviceId, claimed.id, { lease: claimed.lease, state: 'failed', message: 'Проверка без изменения файлов', result: receipt });
        installJob = await jobs.retry(actor, claimed.id, randomUUID());
    });
    await check('Реальный worker записывает весь граф одним журналом и проверяет авторизацию перед фиксацией', async () => {
        completed = await run(installJob);
        assert.equal(completed.result.manifest, installedSet.manifest); assert.deepEqual(completed.result.packages, installationRefs(members));
        assert.equal(completed.result.readiness, 'unverified'); assert.equal(authorizations.get(installJob.id), 2);
        const journals = await fs.readdir(path.join(stateDir(), 'file-changes', hash(project), 'history'));
        assert.equal(journals.length, 1);
        const journal = JSON.parse(await fs.readFile(completed.result.recoveryPath, 'utf8'));
        assert.equal(journal.state, 'committed'); assert.equal(journal.changes.filter(change => change.relative === '.opencode/opencode.jsonc').length, 1);
        for (const pkg of members) { for (const file of pkg.files) assert.equal(await fs.readFile(path.join(project, assetBase(pkg), file.path), 'utf8'), file.content); }
    });
    await check('Конфигурация объединяет три MCP и плагин, сохраняя пользовательские поля и комментарий', async () => {
        const raw = await fs.readFile(configPath, 'utf8'); const config = parse(raw);
        assert.ok(raw.includes('// Личная настройка фикстуры')); assert.equal(config.theme, 'fixture');
        assert.equal(Object.keys(config.mcp).length, 4); assert.equal(config.mcp.personal.url, 'https://personal.example.test');
        assert.equal(config.plugin.length, 2); assert.ok(config.plugin.includes('fixture-personal-plugin'));
    });
    await check('История установок включает корень и все четыре зависимости', async () => {
        const installed = await installations.list(actor); assert.equal(installed.length, 5);
        for (const pkg of members) assert.equal(installed.find(item => item.assetId === pkg.plugin.id).manifest, pkg.manifest.sha256);
    });
    await check('Старый клиент не может ни установить, ни удалить инструмент в папке с историей комплектов', async () => {
        await devices.heartbeat(await devices.identity(token), oldReport);
        await assert.rejects(create(skill, approved), error => error.status === 409);
        await assert.rejects(remove(shared), error => error.status === 409);
        await devices.heartbeat(await devices.identity(token), fullReport);
    });
    await check('Общая зависимость защищена от прямого удаления работающим worker', async () => {
        const before = await fs.readFile(configPath, 'utf8'); const failed = await run(await remove(shared), 'failed');
        assert.equal(failed.result.unchanged, true); assert.match(failed.message, /зависимост/);
        assert.equal(await fs.readFile(configPath, 'utf8'), before);
    });
    let secondPlan;
    await check('Второй корень переиспользует общую зависимость и сохраняет её квитанцию', async () => {
        const receipt = path.join(project, receiptPath(shared)); const before = await fs.stat(receipt);
        secondPlan = await approve(second); await run(await create(second, secondPlan));
        assert.equal((await fs.stat(receipt)).mtimeMs, before.mtimeMs);
        assert.equal((await installations.list(actor)).length, 6);
    });
    await check('Удаление первого корня сохраняет четыре зависимости и второй скилл', async () => {
        await run(await remove(skill));
        await assert.rejects(fs.access(path.join(project, assetBase(skill), 'SKILL.md')), error => error.code === 'ENOENT');
        for (const pkg of [left, right, shared, plugin, second]) await fs.access(path.join(project, receiptPath(pkg)));
        const installed = await installations.list(actor); assert.equal(installed.length, 5); assert.ok(!installed.some(item => item.assetId === skill.plugin.id));
    });
    await check('Сохранённые транзитивные владельцы защищают общую зависимость после удаления обоих корней', async () => {
        await run(await remove(second));
        const failed = await run(await remove(shared), 'failed'); assert.match(failed.message, /зависимост/);
        assert.equal(failed.result.unchanged, true);
        for (const pkg of [left, right, shared, plugin]) await fs.access(path.join(project, receiptPath(pkg)));
    });
    await check('Явное удаление зависимых MCP освобождает общую зависимость без удаления личной конфигурации', async () => {
        await run(await remove(left)); await run(await remove(right)); await run(await remove(shared)); await run(await remove(plugin));
        assert.equal((await installations.list(actor)).length, 0);
        const config = parse(await fs.readFile(configPath, 'utf8'));
        assert.deepEqual(Object.keys(config.mcp), ['personal']); assert.deepEqual(config.plugin, ['fixture-personal-plugin']); assert.equal(config.theme, 'fixture');
    });
} catch (error) { fatal = error.stack || String(error); console.error(fatal); process.exitCode = 1; }
finally {
    await stopWorker();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await devices?.onModuleDestroy();
    if (created) { await admin.query(`DROP DATABASE "${database}"`); ownDatabaseDropped = true; }
    const afterDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    originalDatabasesPreserved = JSON.stringify(beforeDatabases) === JSON.stringify(afterDatabases);
    await admin.end(); await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ results, fatal: fatal || null, ownDatabaseDropped, originalDatabasesPreserved,
        temporaryWorkspaceRemoved: true, realDeviceCommandsCreated: false, realProfileChanged: false }, null, 2) + '\n');
    if (!originalDatabasesPreserved) process.exitCode = 1;
}
