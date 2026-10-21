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

// Переключение папок проверяется только на собственном устройстве и временной PostgreSQL.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const adminUrl = process.env.INSTALLATION_BINDINGS_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin = new Pool({ connectionString: adminUrl });
const database = 'nc_binding_test_' + randomBytes(8).toString('hex');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-installation-bindings-')));
const reportPath = process.env.INSTALLATION_BINDINGS_REPORT || path.join(root, '.run/installation-bindings.json');
const actor = { email: 'binding-fixture@example.test', activeRole: 'Главный админ' };
const projectId = 'fixture'; const assetId = 'ai-plug-binding-fixture';
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const results = []; const packages = new Map(); const approvedPlans = new Map(); const resumeEvents = [];
let devices, jobs, installations, plans, server, worker, token, deviceId;
let created = false, ownDatabaseDropped = false, originalDatabasesPreserved = false, fatal;

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
    const claims = async email => ({ email, userRoles: ['Главный админ', 'Разработчик'], projects: [{ projectId, projectName: 'Проверка', role: 'Админ проекта' }] });
    devices = new DeviceStore({ claims }); await devices.onModuleInit();
    await seedInstallationProjects(devices.pool,['fixture'],actor);

    const artifactService = { build: async (_kind, id, version) => { assert.equal(id, assetId); assert.ok(packages.has(version)); return packages.get(version); } };
    installations = new DeviceInstallations(devices); plans = new InstallPlans(devices, artifactService); jobs = new DeviceJobs(devices, artifactService, installations, plans);
    for (const version of [1, 2, 3]) packages.set(version, buildPackage({ kind: 'mcp', id: assetId, name: 'binding-fixture', version },
        [{ path: 'index.mjs', content: `// Тестовая версия ${version}\nexport default {};\n` }], 'now', { transport: 'stdio', command: 'node', entrypoint: 'index.mjs' }));
    await pinInstallationPackage(devices.pool,projectId,packages.get(1),actor);
    const credential = randomBytes(32).toString('hex');
    const pair = await devices.start({ name: 'Изолированное устройство', fingerprint: 'e'.repeat(64), credentialHash: createHash('sha256').update(credential).digest('hex') });
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
    const { setRoot, bindProject, workspaceReport, projectBindingId, projectFolder, projectInstanceId, workspaceInstanceAt } = await load('mcp/neurocenter-asset-sync/dist/bridge/workspace.js');
    const { assetBase } = await load('mcp/neurocenter-asset-sync/dist/bridge/installation-receipt.js');
    const parent = path.join(temporary, 'проекты'); const folderA = path.join(parent, 'Копия А'); const folderB = path.join(parent, 'Копия Б');
    await fs.mkdir(folderA, { recursive: true }); await fs.mkdir(folderB, { recursive: true });
    await writeState('credentials', { token, deviceId, email: actor.email }); await setRoot(parent);
    const bind = async folder => {
        let marker;
        try { marker = JSON.parse(await fs.readFile(path.join(folder, '.opencode/neurocenter.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!marker) { await bindProject(projectId, path.basename(folder)); }
        else if (await projectFolder(projectId) !== folder) {
            const previous = await workspaceInstanceAt(folder, projectId);
            const prepared = await run(await jobs.create(actor, { deviceId, projectId, kind: 'prepare-bind-project', bindingMode: 'resume',
                folderName: path.basename(folder), requestKey: randomUUID() }));
            assert.equal(prepared.result.instanceId, previous.instanceId); assert.equal(prepared.result.requiresFileVerification, true);
            const committed = await run(await jobs.create(actor, { deviceId, projectId, kind: 'bind-project', bindingMode: 'resume', folderName: path.basename(folder),
                preparationJobId: prepared.id, expectedPreparation: prepared.result.preparation, requestKey: randomUUID() }));
            assert.equal(committed.result.instanceId, previous.instanceId); assert.notEqual(committed.result.bindingId, prepared.result.previousBindingId);
            assert.equal(committed.result.previousBindingId, prepared.result.previousBindingId);
            assert.equal(await projectInstanceId(projectId), previous.instanceId);
            const event = (await devices.pool.query('SELECT * FROM bridge_instance_events WHERE id=$1', [committed.id])).rows[0];
            assert.equal(event.event, 'resume'); assert.equal(event.instance_id, previous.instanceId);
            assert.equal(event.binding_id, committed.result.bindingId); assert.equal(event.previous_binding_id, prepared.result.previousBindingId);
            assert.deepEqual(event.installations, committed.payload.installations);
            resumeEvents.push({ jobId: committed.id, instanceId: previous.instanceId, previousBindingId: event.previous_binding_id, bindingId: event.binding_id });
        }
        await devices.heartbeat(await devices.identity(token), await workspaceReport()); return projectBindingId(projectId);
    };
    const state = async id => (await devices.pool.query('SELECT * FROM bridge_jobs WHERE id=$1', [id])).rows[0];
    const create = async version => { await pinInstallationPackage(devices.pool,projectId,packages.get(version),actor); const plan = approvedPlans.get(version); return jobs.create(actor, { deviceId, projectId, kind: 'install', assetKind: 'mcp', assetId, version,
        planId: plan.id, planRevision: plan.revision, expectedManifest: plan.manifest, requestKey: randomUUID() }); };
    const remove = async version => jobs.create(actor, { deviceId, projectId, kind: 'uninstall', assetKind: 'mcp', assetId,
        expectedBindingId: await projectBindingId(projectId), expectedManifest: packages.get(version).manifest.sha256, requestKey: randomUUID() });
    const run = async job => { startWorker(); await waitFor(async () => ['succeeded', 'failed'].includes((await state(job.id)).state), 'завершения worker');
        await stopWorker(); const completed = await state(job.id); assert.equal(completed.state, 'succeeded', completed.message); return completed; };
    const file = folder => path.join(folder, assetBase(packages.get(1)), 'index.mjs');
    let bindingA, bindingB, originalBindingA, originalBindingB, installedA, installedB;
    const putInspection=async(bindingId,version,status,startedAt)=>{
        const inspectionId=randomUUID();
        const result={schemaVersion:1,projectId,bindingId,assetId,assetKind:'mcp',version,manifest:packages.get(version).manifest.sha256,
            checkedAt:new Date().toISOString(),readiness:'unverified',state:'checked',status,issues:status==='modified'?['file-modified']:[]};
        assertInstallationInspection(result,{projectId,bindingId,package:packages.get(version)});
        await devices.pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,started_at,result)
            VALUES($1,$2,$3,$4,$5,'inspect-installation',$6,$1,$1,'succeeded',$7,$8)`,
        [inspectionId,deviceId,actor.email,actor.activeRole,projectId,{package:packages.get(version),bindingId,assetId,assetKind:'mcp',version},startedAt,result]);
        return result;
    };
    for (const version of [1, 2, 3]) { await pinInstallationPackage(devices.pool,projectId,packages.get(version),actor); const pending = await plans.prepare(actor, { projectId, assetKind: 'mcp', assetId, version });
        approvedPlans.set(version, await plans.decide(actor, pending.id, { expectedManifest: pending.manifest, expectedRevision: pending.revision }, 'approved')); }
    await check('Реальный worker устанавливает первую версию в папку А', async () => {
        bindingA = originalBindingA = await bind(folderA); installedA=await run(await create(1)); assert.equal(await fs.readFile(file(folderA), 'utf8'), packages.get(1).files[0].content);
    });
    await check('Вторая привязка получает собственную версию, сохраняя файлы папки А', async () => {
        bindingB = originalBindingB = await bind(folderB); assert.notEqual(bindingA, bindingB); installedB=await run(await create(2));
        assert.equal(await fs.readFile(file(folderB), 'utf8'), packages.get(2).files[0].content); assert.equal(await fs.readFile(file(folderA), 'utf8'), packages.get(1).files[0].content);
    });
    await check('История показывает обе папки и помечает текущую Б без ложного имени папки А', async () => {
        const rows = await installations.list(actor); assert.equal(rows.length, 2);
        assert.equal(rows.find(row => row.bindingId === bindingA).version, 1);
        assert.equal(rows.find(row => row.bindingId === bindingA).isCurrentBinding, false); assert.equal(rows.find(row => row.bindingId === bindingA).folderName, undefined);
        assert.equal(rows.find(row => row.bindingId === bindingB).version, 2); assert.equal(rows.find(row => row.bindingId === bindingB).folderName, path.basename(folderB));
    });
    await check('Сверки А и Б сохраняются раздельно, поздняя старая сверка не заменяет новую',async()=>{
        const newer=await putInspection(bindingA,1,'synced',new Date(installedA.started_at.getTime()+20));
        await putInspection(bindingA,1,'modified',new Date(installedA.started_at.getTime()+10));
        await putInspection(bindingB,2,'modified',new Date(installedB.started_at.getTime()+10));
        const rows=await installations.list(actor);
        assert.deepEqual(rows.find(row=>row.bindingId===bindingA).inspection,newer);
        assert.equal(rows.find(row=>row.bindingId===bindingB).inspection.status,'modified');
    });
    await check('Долговременная сверка остаётся в списке после 130 новых записей журнала',async()=>{
        for(let i=0;i<130;i++){
            const recordId=randomUUID();
            await devices.pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash,state) VALUES($1,$2,$3,$4,'choose-root','{}',$1,$1,'cancelled')",
                [recordId,deviceId,actor.email,actor.activeRole]);
        }
        const rows=await installations.list(actor);
        assert.equal(rows.find(row=>row.bindingId===bindingA).inspection.status,'synced');
        assert.equal(rows.find(row=>row.bindingId===bindingB).inspection.status,'modified');
    });
    await check('Реальный resume А → Б → А сохраняет instance и квитанцию А, выдавая новый binding', async () => {
        bindingA = await bind(folderA); assert.notEqual(bindingA, originalBindingA);
        assert.deepEqual(await installations.removalPackage(actor, { deviceId, projectId, assetId, assetKind: 'mcp', bindingId: bindingA, expectedManifest: packages.get(1).manifest.sha256 }), packages.get(1));
        assert.deepEqual(await installations.inspectionPackage(actor, { deviceId, projectId, assetId, assetKind: 'mcp', bindingId: bindingA, expectedManifest: packages.get(1).manifest.sha256 }), packages.get(1));
        await assert.rejects(remove(2), error => error.status === 409);
        await assert.rejects(jobs.create(actor, { deviceId, projectId, kind: 'uninstall', assetKind: 'mcp', assetId,
            expectedBindingId: originalBindingA, expectedManifest: packages.get(1).manifest.sha256, requestKey: randomUUID() }), error => error.status === 409);
        const rows = await installations.list(actor); assert.equal(rows.length, 3); assert.equal(rows.find(row => row.bindingId === bindingA).isCurrentBinding, true);
        assert.equal(rows.find(row => row.bindingId === bindingB).isCurrentBinding, false);
        assert.equal(rows.find(row => row.bindingId === originalBindingA).isCurrentBinding, false);
        assert.equal(rows.find(row => row.bindingId === originalBindingA).inspection.status, 'synced');
        assert.equal(rows.find(row => row.bindingId === bindingA).inspection, undefined);
    });
    await check('Новая установка с тем же SHA сбрасывает прежнюю сверку только своей папки',async()=>{
        await putInspection(bindingA,1,'synced',new Date());
        assert.equal((await installations.list(actor)).find(row=>row.bindingId===bindingA).inspection.status,'synced');
        await run(await create(1));
        const rows=await installations.list(actor);
        assert.equal(rows.find(row=>row.bindingId===bindingA).inspection,undefined);
        assert.equal(rows.find(row=>row.bindingId===bindingB).inspection.status,'modified');
        assert.equal(rows.find(row=>row.bindingId===originalBindingA).inspection.status,'synced');
    });
    await check('Удаление в А не скрывает Б и не меняет её файлы', async () => {
        await run(await remove(1)); await assert.rejects(fs.access(file(folderA)), error => error.code === 'ENOENT');
        assert.equal(await fs.readFile(file(folderB), 'utf8'), packages.get(2).files[0].content);
        const rows = await installations.list(actor); assert.equal(rows.length, 2); assert.ok(rows.some(row => row.bindingId === bindingB && row.version === 2));
        assert.ok(rows.some(row => row.bindingId === originalBindingA && row.version === 1 && row.isCurrentBinding === false));
        assert.ok(!rows.some(row => row.bindingId === bindingA));
        await assert.rejects(remove(1), error => error.status === 409);
    });
    await check('Legacy история без привязки остаётся видимой и не воскрешает удалённую современную запись А', async () => {
        const legacyId = randomUUID();
        await devices.pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,started_at)
            VALUES($1,$2,$3,$4,$5,'install',$6,$1,$1,'succeeded',now()-interval '1 day')`,
        [legacyId, deviceId, actor.email, actor.activeRole, projectId, { package: packages.get(1), assetKind: 'mcp', assetId, version: 1 }]);
        const rows = await installations.list(actor); const legacy = rows.find(row => row.bindingId === null);
        assert.ok(legacy); assert.equal(legacy.legacyBinding, true); assert.equal(legacy.isCurrentBinding, false); assert.equal(legacy.bindingChanged, true);
        await assert.rejects(remove(1), error => error.status === 409);
        assert.ok(!rows.some(row => row.bindingId === bindingA));
    });
    await check('Новая версия в восстановленной папке А независима от сохранённой версии Б', async () => {
        await run(await create(3));
        const rows = await installations.list(actor); assert.equal(rows.find(row => row.bindingId === bindingA).version, 3);
        assert.equal(rows.find(row => row.bindingId === bindingB).version, 2);
        assert.equal(await fs.readFile(file(folderA), 'utf8'), packages.get(3).files[0].content);
    });
    await check('Одинаковый SHA в А и Б не разрешает устаревшей вкладке удалить другую папку', async () => {
        bindingB = await bind(folderB); assert.notEqual(bindingB, originalBindingB); await run(await create(3));
        await assert.rejects(jobs.create(actor, { deviceId, projectId, kind: 'uninstall', assetKind: 'mcp', assetId,
            expectedBindingId: bindingA, expectedManifest: packages.get(3).manifest.sha256, requestKey: randomUUID() }), error => error.status === 409);
        await assert.rejects(jobs.create(actor, { deviceId, projectId, kind: 'uninstall', assetKind: 'mcp', assetId,
            expectedBindingId: originalBindingB, expectedManifest: packages.get(3).manifest.sha256, requestKey: randomUUID() }), error => error.status === 409);
        assert.equal(await fs.readFile(file(folderA), 'utf8'), packages.get(3).files[0].content);
        assert.equal(await fs.readFile(file(folderB), 'utf8'), packages.get(3).files[0].content);
        await putInspection(bindingA,3,'synced',new Date());
        const rows=await installations.list(actor);
        assert.equal(rows.find(row=>row.bindingId===bindingA).inspection.status,'synced');
        assert.equal(rows.find(row=>row.bindingId===bindingB).inspection,undefined);
        assert.equal(rows.find(row=>row.bindingId===originalBindingB).inspection.status,'modified');
    });
    await check('Удаление Б после возврата в её привязку сохраняет установку А', async () => {
        assert.equal(await bind(folderB), bindingB); await run(await remove(3));
        const rows = await installations.list(actor); assert.ok(!rows.some(row => row.bindingId === bindingB)); assert.equal(rows.find(row => row.bindingId === bindingA).version, 3);
        assert.equal(rows.find(row => row.bindingId === originalBindingB).version, 2);
        assert.equal(await fs.readFile(file(folderA), 'utf8'), packages.get(3).files[0].content);
    });
    await check('Отсутствие текущей привязки не разрешает удаление legacy квитанции', async () => {
        await assert.rejects(installations.removalPackage(actor, { deviceId, projectId, assetId, assetKind: 'mcp', expectedManifest: packages.get(1).manifest.sha256 }), error => error.status === 409);
    });
    await check('Позднее подтверждение старой версии внутри А не вытесняет новую и не воскрешает Б', async () => {
        const previousBindingA = bindingA; bindingA = await bind(folderA); assert.notEqual(bindingA, previousBindingA); const history = [];
        for (const [version, hour] of [[1, 1], [3, 2]]) {
            const pending = await create(version); const lease = randomUUID();
            await devices.pool.query("UPDATE bridge_jobs SET state='cancelled',lease=$2,lease_until=now()-interval '1 minute',started_at=now()+$3*interval '1 hour' WHERE id=$1", [pending.id, lease, hour]);
            history.push({ id: pending.id, lease, version });
        }
        await devices.pool.query("UPDATE bridge_jobs SET state='reconciling' WHERE id=ANY($1::text[])", [history.map(item => item.id)]);
        for (const record of history.reverse()) await completeDeviceJob(devices.pool, deviceId, record.id, { lease: record.lease, state: 'succeeded', message: 'Сверка исторической квитанции',
            result: { projectId, assetId, version: record.version, manifest: packages.get(record.version).manifest.sha256, bindingId: bindingA } });
        const rows = await installations.list(actor); assert.equal(rows.find(row => row.bindingId === bindingA).version, 3); assert.ok(!rows.some(row => row.bindingId === bindingB));
        assert.equal(rows.find(row => row.bindingId === previousBindingA).version, 3);
        assert.equal(rows.find(row => row.bindingId === previousBindingA).isCurrentBinding, false);
        assert.equal(rows.filter(row => row.isCurrentBinding).length, 1); assert.equal(resumeEvents.length, 3);
    });
} catch (error) { fatal = error.stack || String(error); console.error(fatal); process.exitCode = 1; }
finally {
    await stopWorker(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await devices?.onModuleDestroy();
    if (created) { await admin.query(`DROP DATABASE "${database}"`); ownDatabaseDropped = true; }
    const afterDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    originalDatabasesPreserved = JSON.stringify(beforeDatabases) === JSON.stringify(afterDatabases);
    await admin.end(); await fs.rm(temporary, { recursive: true, force: true }); await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ results, resumeEvents, fatal: fatal || null, ownDatabaseDropped, originalDatabasesPreserved,
        temporaryWorkspaceRemoved: true, realDeviceCommandsCreated: false, realProfileChanged: false }, null, 2) + '\n');
    if (!originalDatabasesPreserved) process.exitCode = 1;
}
