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

// Сканер проверяется на отдельном компьютере-фикстуре; рабочие проекты и профиль OpenCode не затрагиваются.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const adminUrl = process.env.INSTALLATION_INSPECTION_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin = new Pool({ connectionString: adminUrl });
const database = 'nc_inspection_test_' + randomBytes(8).toString('hex');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-installation-inspection-')));
const reportPath = process.env.INSTALLATION_INSPECTION_REPORT || path.join(root, '.run/installation-inspection.json');
const actor = { email: 'inspection-fixture@example.test', activeRole: 'Главный админ' };
const observer = { ...actor, activeRole: 'Наблюдатель' };
const projectId = 'fixture'; const assetId = 'ai-plug-inspection-fixture';
const results = [];
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
let devices, jobs, installations, plans, server, worker, token, deviceId, project;
let created = false, ownDatabaseDropped = false, originalDatabasesPreserved = false, fatal;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function check(name, action) { await action(); results.push({ case: name, ok: true }); console.log(name); }
async function waitFor(predicate, label, timeout = 22000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await predicate()) return; await delay(40); }
    throw new Error('Не дождались: ' + label);
}
function startWorker() {
    worker = spawn(process.execPath, [path.join(root, 'mcp/neurocenter-asset-sync/dist/index.js'), '--worker'], {
        env: { ...process.env, HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: path.join(temporary, 'config') }, cwd: temporary, stdio: 'ignore',
    });
}
async function stopWorker() {
    if (worker && worker.exitCode === null && worker.signalCode === null) { const stopped = once(worker, 'exit'); worker.kill('SIGTERM'); await stopped; }
    worker = undefined;
}
async function snapshot() {
    const files = [];
    async function walk(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) { await walk(absolute); continue; }
            assert.ok(entry.isFile()); const stat = await fs.stat(absolute);
            files.push({ path: path.relative(project, absolute), bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: digest(await fs.readFile(absolute)) });
        }
    }
    await walk(project); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const url = new URL(adminUrl); url.pathname = '/' + database;
    process.env.CATALOG_PG_URL = url.href; process.env.NEUROCENTER_BRIDGE_HOME = path.join(temporary, 'bridge');
    const { DeviceStore } = await load('services/catalog-service/dist/devices/device-store.js');
    const { DeviceJobs } = await load('services/catalog-service/dist/devices/device-jobs.js');
    const { DeviceInstallations } = await load('services/catalog-service/dist/devices/device-installations.js');
    const { InstallPlans } = await load('services/catalog-service/dist/devices/install-plans.js');
    const { completeDeviceJob } = await load('services/catalog-service/dist/devices/device-completion.js');
    const { assertInstallationInspection } = await load('services/catalog-service/dist/devices/installation-inspection.js');
    const { buildPackage } = await load('services/catalog-service/dist/catalog/bundle-package.js');
    const claims = async email => ({ email, userRoles: ['Главный админ', 'Разработчик', 'Наблюдатель'], projects: [{ projectId, projectName: 'Проверка', role: 'Админ проекта' }] });
    devices = new DeviceStore({ claims }); await devices.onModuleInit();
    await seedInstallationProjects(devices.pool,['fixture'],actor);

    const pkg = buildPackage({ kind: 'mcp', id: assetId, name: 'inspection-fixture', version: 1 },
        [{ path: 'index.mjs', content: '// Этот маркер появится только при ошибочном запуске проверяемого кода.\nimport { writeFileSync } from "node:fs";\nwriteFileSync(new URL("executed.txt", import.meta.url), "Код не должен запускаться");\nexport default {};\n' }], 'now', { transport: 'stdio', command: 'node', entrypoint: 'index.mjs' });
    const artifactService = { build: async () => pkg };
    installations = new DeviceInstallations(devices); plans = new InstallPlans(devices, artifactService); jobs = new DeviceJobs(devices, artifactService, installations, plans);
    await pinInstallationPackage(devices.pool,projectId,pkg,actor);
    const credential = randomBytes(32).toString('hex');
    const pair = await devices.start({ name: 'Компьютер сверки', fingerprint: 'd'.repeat(64), credentialHash: digest(credential) });
    await devices.approve(actor, pair.userCode); const connected = await devices.poll(pair.deviceCode); token = credential; deviceId = connected.deviceId;
    server = http.createServer(async (request, response) => {
        try {
            const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            if (request.url === '/internal/events') { response.end('{}'); return; }
            if (!request.url.startsWith('/api/device-channel/')) { response.writeHead(404).end('{}'); return; }
            const device = await devices.identity(String(request.headers.authorization || '').replace(/^Bearer /, ''));
            const route = request.url.slice('/api/device-channel/'.length); let data;
            if (route === 'identity') data = { id: device.id, email: device.email, role: device.role };
            else if (route === 'heartbeat') data = await devices.heartbeat(device, body);
            else if (route === 'jobs/claim') data = await jobs.claim(device);
            else if (/^jobs\/[^/]+\/authorize$/.test(route)) data = await jobs.authorize(device, route.split('/')[1], body.lease);
            else if (/^jobs\/[^/]+\/progress$/.test(route)) data = await jobs.update(device, route.split('/')[1], body);
            else if (/^jobs\/[^/]+\/complete$/.test(route)) data = await completeDeviceJob(devices.pool, device.id, route.split('/')[1], body);
            else { response.writeHead(404).end('{}'); return; }
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        } catch (error) { response.writeHead(error.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.NEUROCENTER_URL = origin; process.env.API_GATEWAY_URL = origin;
    const { writeState } = await load('mcp/neurocenter-asset-sync/dist/bridge/state.js');
    const { setRoot, bindProject, workspaceReport, projectBindingId } = await load('mcp/neurocenter-asset-sync/dist/bridge/workspace.js');
    const { assetBase, receiptPath } = await load('mcp/neurocenter-asset-sync/dist/bridge/installation-receipt.js');
    const { inspectInstallation } = await load('mcp/neurocenter-asset-sync/dist/bridge/installation-inspection.js');
    const { parse } = createRequire(path.join(root, 'mcp/neurocenter-asset-sync/package.json'))('jsonc-parser');
    project = path.join(temporary, 'проекты', 'Только для проверки'); await fs.mkdir(project, { recursive: true });
    await writeState('credentials', { token, deviceId, email: actor.email }); await setRoot(path.dirname(project)); await bindProject(projectId, path.basename(project));
    await devices.heartbeat(await devices.identity(token), await workspaceReport());
    const bindingId = await projectBindingId(projectId);
    const state = async id => (await devices.pool.query('SELECT * FROM bridge_jobs WHERE id=$1', [id])).rows[0];
    const request = (kind, extra = {}) => ({ deviceId, projectId, kind, assetKind: 'mcp', assetId, expectedBindingId: bindingId,
        expectedManifest: pkg.manifest.sha256, requestKey: randomUUID(), ...extra });
    const inspect = () => jobs.create(observer, request('inspect-installation'));
    const run = async job => { startWorker(); await waitFor(async () => ['succeeded', 'failed'].includes((await state(job.id)).state), 'завершения сверки');
        await stopWorker(); const completed = await state(job.id); assert.equal(completed.state, 'succeeded', completed.message); return completed; };
    const scan = async () => {
        const before = await snapshot(); const queued = await inspect(); const payload = (await state(queued.id)).payload;
        assert.deepEqual(payload.package, pkg); const completed = await run(queued);
        assertInstallationInspection(completed.result, { projectId, bindingId, package: pkg }); assert.deepEqual(await snapshot(), before);
        return completed.result;
    };
    const pending = await plans.prepare(actor, { projectId, assetKind: 'mcp', assetId, version: 1 });
    const approved = await plans.decide(actor, pending.id, { expectedManifest: pending.manifest, expectedRevision: pending.revision }, 'approved');
    const entry = path.join(project, assetBase(pkg), 'index.mjs');
    const receipt = path.join(project, receiptPath(pkg)); const ledger = path.join(project, '.opencode/neurocenter/installations.json');
    let originalReceipt, originalLedger, configPath, originalConfig;
    await check('Реальный worker устанавливает исходный пакет для последующей сверки', async () => {
        await run(await jobs.create(actor, request('install', { version: 1, planId: approved.id, planRevision: approved.revision })));
        assert.equal(await fs.readFile(entry, 'utf8'), pkg.files[0].content);
        await assert.rejects(fs.access(path.join(path.dirname(entry),'executed.txt')),error=>error.code==='ENOENT');
        originalReceipt = await fs.readFile(receipt); originalLedger = await fs.readFile(ledger);
        const parsed = JSON.parse(originalReceipt.toString()); configPath = path.join(project, parsed.config.path); originalConfig = await fs.readFile(configPath);
    });
    await check('Наблюдатель сверяет свой проект, но не устанавливает и не удаляет инструменты', async () => {
        await assert.rejects(jobs.create(observer, request('install', { version: 1, planId: approved.id, planRevision: approved.revision })), error => error.status === 403);
        await assert.rejects(jobs.create(observer, request('uninstall')), error => error.status === 403);
        const result = await scan(); assert.equal(result.status, 'synced'); assert.equal(result.readiness, 'unverified'); assert.deepEqual(result.issues, []);
    });
    await check('Правка файла обнаруживается без восстановления содержимого или mtime', async () => {
        await fs.writeFile(entry, pkg.files[0].content + '// Локальная правка\n'); const result = await scan();
        assert.equal(result.status, 'modified'); assert.ok(result.issues.includes('file-modified')); await fs.writeFile(entry, pkg.files[0].content);
    });
    await check('Отсутствующий файл отмечается как missing и не создаётся заново', async () => {
        await fs.unlink(entry); const result = await scan(); assert.equal(result.status, 'missing'); assert.ok(result.issues.includes('file-missing'));
        await assert.rejects(fs.access(entry), error => error.code === 'ENOENT'); await fs.writeFile(entry, pkg.files[0].content);
    });
    await check('Согласованная подмена файла и локальной квитанции не обходит исходный серверный пакет', async () => {
        const changed = '// Подмена локальной инструкции\n'; const parsed = JSON.parse(originalReceipt.toString());
        parsed.files[`${assetBase(pkg)}/index.mjs`] = digest(changed); await fs.writeFile(entry, changed); await fs.writeFile(receipt, JSON.stringify(parsed));
        const result = await scan(); assert.equal(result.status, 'modified'); assert.ok(result.issues.includes('file-modified')); assert.ok(result.issues.includes('receipt-mismatch'));
        await fs.writeFile(entry, pkg.files[0].content); await fs.writeFile(receipt, originalReceipt);
    });
    await check('Изменённое подключение обнаруживается без выдачи настроек, ключей или локальных путей', async () => {
        const secret = 'private-fixture-' + randomBytes(12).toString('hex'); const config = parse(originalConfig.toString());
        config.mcp[JSON.parse(originalReceipt.toString()).config.key].environment = { API_KEY: secret };
        await fs.writeFile(configPath, JSON.stringify(config)); const result = await scan();
        assert.equal(result.status, 'modified'); assert.ok(result.issues.includes('config-modified'));
        const serialized = JSON.stringify(result); assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes(project)); assert.ok(!Object.hasOwn(result, 'config'));
        await fs.writeFile(configPath, originalConfig);
    });
    await check('Занятый проект возвращает busy без удаления блокировки или ремонта', async () => {
        const lock = path.join(project, '.opencode/neurocenter/files.lock'); const text = JSON.stringify({ pid: process.pid, token: randomUUID() }); await fs.writeFile(lock, text);
        const result = await scan(); assert.equal(result.state, 'busy'); assert.equal(result.status, 'unknown'); assert.deepEqual(result.issues, ['inspection-busy']);
        assert.equal(await fs.readFile(lock, 'utf8'), text); await fs.unlink(lock);
    });
    await check('Утраченные квитанция и реестр дают unknown, не создавая подменные служебные файлы', async () => {
        await fs.unlink(receipt); await fs.unlink(ledger); const result = await scan(); assert.equal(result.status, 'unknown');
        assert.ok(result.issues.includes('receipt-missing')); assert.ok(result.issues.includes('ledger-missing'));
        await assert.rejects(fs.access(receipt), error => error.code === 'ENOENT'); await assert.rejects(fs.access(ledger), error => error.code === 'ENOENT');
        await fs.writeFile(receipt, originalReceipt); await fs.writeFile(ledger, originalLedger);
    });
    await check('Актуальная сверка сохраняется в списке установок после 130 новых событий', async () => {
        const result = await scan(); assert.equal(result.status, 'synced');
        for (let i = 0; i < 130; i++) { const id = randomUUID(); await devices.pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash,state) VALUES($1,$2,$3,$4,'choose-root','{}',$1,$1,'cancelled')", [id, deviceId, actor.email, actor.activeRole]); }
        assert.deepEqual((await installations.list(observer)).find(row => row.assetId === assetId).inspection, result);
    });
    await check('Чужая выбранная привязка и старый capability не создают задания сверки', async () => {
        const count = async () => (await devices.pool.query('SELECT count(*)::int AS n FROM bridge_jobs')).rows[0].n; const before = await count();
        await assert.rejects(jobs.create(observer, request('inspect-installation', { expectedBindingId: '0'.repeat(64) })), error => error.status === 409);
        const full = await workspaceReport(); await devices.heartbeat(await devices.identity(token), { ...full, capabilities: full.capabilities.filter(capability => capability !== 'installation-inspection-v1') });
        await assert.rejects(inspect(), error => error.status === 409); await devices.heartbeat(await devices.identity(token), full); assert.equal(await count(), before);
    });
    await check('Completion отвергает чужую identity, статус, readiness и дополнительные конфиденциальные поля', async () => {
        const queued = await inspect(); const claimed = await jobs.claim(await devices.identity(token)); assert.equal(claimed.id, queued.id);
        const valid = await inspectInstallation(projectId, pkg);
        const changes = [{ bindingId: '0'.repeat(64) }, { assetId: 'foreign' }, { manifest: '0'.repeat(64) }, { status: 'healthy' }, { readiness: 'ready' }, { config: { API_KEY: 'fixture-secret' } }];
        for (const change of changes) await assert.rejects(completeDeviceJob(devices.pool, deviceId, queued.id, { lease: claimed.lease, state: 'succeeded', message: 'Подмена', result: { ...valid, ...change } }), error => error.status === 409);
        assert.equal((await state(queued.id)).state, 'running');
        await completeDeviceJob(devices.pool, deviceId, queued.id, { lease: claimed.lease, state: 'succeeded', message: 'Проверка без раскрытия настроек', result: valid });
    });
    await check('Поздняя подтверждённая сверка после аренды завершается идемпотентно без записи файлов', async () => {
        const before = await snapshot(); const queued = await inspect(); const claimed = await jobs.claim(await devices.identity(token)); assert.equal(claimed.id, queued.id);
        const result = await inspectInstallation(projectId, pkg);
        await devices.pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [queued.id]); await jobs.list(observer);
        assert.equal((await state(queued.id)).state, 'reconciling'); const input = { lease: claimed.lease, state: 'succeeded', message: 'Сверка после аренды', result };
        assert.equal((await completeDeviceJob(devices.pool, deviceId, queued.id, input)).repeated, false);
        assert.equal((await completeDeviceJob(devices.pool, deviceId, queued.id, input)).repeated, true);
        assert.deepEqual(await snapshot(), before);
    });
} catch (error) { fatal = error.stack || String(error); console.error(fatal); process.exitCode = 1; }
finally {
    await stopWorker(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await devices?.onModuleDestroy();
    if (created) { await admin.query(`DROP DATABASE "${database}"`); ownDatabaseDropped = true; }
    const afterDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    originalDatabasesPreserved = JSON.stringify(beforeDatabases) === JSON.stringify(afterDatabases);
    await admin.end(); await fs.rm(temporary, { recursive: true, force: true }); await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ results, fatal: fatal || null, ownDatabaseDropped, originalDatabasesPreserved,
        temporaryWorkspaceRemoved: true, realDeviceCommandsCreated: false, realProfileChanged: false }, null, 2) + '\n');
    if (!originalDatabasesPreserved) process.exitCode = 1;
}
