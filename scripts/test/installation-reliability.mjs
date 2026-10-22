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

const adminConnection=ownedTestPostgresAdmin(process.env.INSTALLATION_TEST_PG_URL).href;

// Только собственная временная база, HTTP-порт и файловый профиль; реальные проекты не изменяются.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const adminUrl = adminConnection;
const admin = new Pool({ connectionString: adminUrl });
const database = 'nc_install_test_' + randomBytes(8).toString('hex');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-install-reliability-'));
const reportPath = process.env.INSTALLATION_TEST_REPORT || path.join(root, '.run/installation-hardening-20261017/reliability.json');
const results = [];
const actor = { email: 'installation-fixture@example.test', activeRole: 'Главный админ' };
let devices, jobs, installations, plans, worker, server, token, deviceId, hold, dropped = 0;
let created = false, droppedDatabase = false, fatal;
const manifests = new Map();
const approvedPlans = new Map();
const requestStates = [];
const beforeDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
const claims = async email => ({ email, userRoles: ['Главный админ', 'Разработчик', 'Наблюдатель'],
    projects: [{ projectId: 'fixture', projectName: 'Проверка', role: 'Админ проекта' }], pluginIds: [], skillPaths: [] });
async function check(name, action) { await action(); results.push({ case: name, ok: true }); console.log(name); }
async function waitFor(predicate, label, timeout = 12000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await predicate()) return; await delay(40); }
    throw new Error('Не дождались: ' + label);
}
function startWorker() {
    worker = spawn(process.execPath, [path.join(root, 'mcp/neurocenter-asset-sync/dist/index.js'), '--worker'],
        { env: { ...process.env, HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: path.join(temporary, 'config') }, stdio: 'ignore', cwd: temporary });
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
    const { completeDeviceJob } = await load('services/catalog-service/dist/devices/device-completion.js');
    const { buildPackage } = await load('services/catalog-service/dist/catalog/bundle-package.js');
    const { InstallPlans } = await load('services/catalog-service/dist/devices/install-plans.js');
    devices = new DeviceStore({ claims }); await devices.onModuleInit();
    await seedInstallationProjects(devices.pool,['fixture'],actor);
    installations = new DeviceInstallations(devices);
    const artifacts = { build: async (kind, id, version) => {
        const pkg = manifests.get(id + ':' + version); assert.ok(pkg, 'Известный тестовый пакет'); return pkg;
    } };

    plans = new InstallPlans(devices, artifacts);
    jobs = new DeviceJobs(devices, artifacts, installations, plans);
    const makePackage = (version, id = 'fixture-mcp') => {
        const pkg = buildPackage({ id, name: id, kind: 'mcp', version }, [{ path: 'index.mjs', content: `// Версия ${version}\nexport default {};\n` }], new Date().toISOString(), { command: 'node', entrypoint: 'index.mjs' });
        manifests.set(id + ':' + version, pkg); return pkg;
    };
    for (const version of [1, 2, 3]) makePackage(version);
    await pinInstallationPackage(devices.pool,'fixture',manifests.get('fixture-mcp:1'),actor);
    const secret = randomBytes(32).toString('hex');
    const pair = await devices.start({ name: 'Временный компьютер', fingerprint: 'a'.repeat(64), credentialHash: createHash('sha256').update(secret).digest('hex') });
    await devices.approve(actor, pair.userCode);
    const connected = await devices.poll(pair.deviceCode); token = secret; deviceId = connected.deviceId;
    await check('Потерянный ответ подключения повторяется без нового устройства и выдачи секретов', async () => {
        const repeated = await devices.poll(pair.deviceCode); assert.equal(repeated.deviceId, deviceId); assert.equal(repeated.token, undefined);
        assert.equal((await devices.pool.query('SELECT count(*)::int AS n FROM bridge_devices')).rows[0].n, 1);
        assert.equal((await devices.identity(token)).id, deviceId);
    });
    await check('Старый протокол подключения остаётся одноразовым', async () => {
        const legacy = await devices.start({ name: 'Старый тестовый мост', fingerprint: 'b'.repeat(64) }); await devices.approve(actor, legacy.userCode);
        const identity = await devices.poll(legacy.deviceCode); assert.ok(identity.token);
        await assert.rejects(devices.poll(legacy.deviceCode), error => error.status === 409);
        await assert.rejects(jobs.create(actor, { deviceId: identity.deviceId, projectId: 'fixture', requestKey: randomUUID(), kind: 'install', assetKind: 'mcp', assetId: 'fixture-mcp', version: 1 }), error => error.status === 409);
        await assert.rejects(jobs.create(actor, { deviceId: identity.deviceId, requestKey: randomUUID(), kind: 'choose-root' }), error => error.status === 409);
    });
    server = http.createServer(async (request, response) => {
        try {
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            if (request.url === '/internal/events') { response.end('{}'); return; }
            const current = await devices.identity(String(request.headers.authorization || '').replace(/^Bearer /, ''));
            const route = request.url.slice('/api/device-channel/'.length);
            let data;
            if (route === 'identity') data = { id: current.id, email: current.email, role: current.role };
            else if (route === 'heartbeat') data = await devices.heartbeat(current, body);
            else if (route === 'jobs/claim') data = await jobs.claim(current);
            else if (route === 'worker/pause') data = await devices.pause(current);
            else if (route === 'worker/resume') data = await devices.resume(current);
            else if (/^jobs\/[^/]+\/authorize$/.test(route)) data = await jobs.authorize(current, route.split('/')[1], body.lease);
            else if (/^jobs\/[^/]+\/progress$/.test(route)) { requestStates.push(body.state); data = await jobs.update(current, route.split('/')[1], body); }
            else if (/^jobs\/[^/]+\/complete$/.test(route)) {
                if (hold === 'before') { dropped++; request.socket.destroy(); return; }
                data = await completeDeviceJob(devices.pool, current.id, route.split('/')[1], body);
                if (hold === 'after') { dropped++; request.socket.destroy(); return; }
            } else { response.writeHead(404).end('{}'); return; }
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        } catch (error) { response.writeHead(error.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.NEUROCENTER_URL = origin; process.env.API_GATEWAY_URL = origin;
    const { writeState, stateDir } = await load('mcp/neurocenter-asset-sync/dist/bridge/state.js');
    const { setRoot, bindProject, projectBindingId } = await load('mcp/neurocenter-asset-sync/dist/bridge/workspace.js');
    const { assetBase } = await load('mcp/neurocenter-asset-sync/dist/bridge/installation-receipt.js');
    const { pendingCompletions } = await load('mcp/neurocenter-asset-sync/dist/bridge/completions.js');
    const { ensureCurrentWorker } = await load('mcp/neurocenter-asset-sync/dist/bridge/worker-upgrade.js');
    await writeState('credentials', { token, deviceId, email: actor.email });
    const project = path.join(temporary, 'проекты', 'имя отличается от серверного'); await fs.mkdir(project, { recursive: true });
    await setRoot(path.dirname(project)); await bindProject('fixture', path.basename(project));
    startWorker();
    await waitFor(async () => (await devices.list(actor)).find(item => item.id === deviceId)?.report.protocolVersion === 2, 'heartbeat нового моста');
    await check('Подготовленная версия требует реального решения админа и сохраняет событие одобрения', async () => {
        for (const version of [1,2,3]) {
            await pinInstallationPackage(devices.pool,'fixture',manifests.get('fixture-mcp:'+version),actor);
            const plan = await plans.prepare(actor,{projectId:'fixture',assetKind:'mcp',assetId:'fixture-mcp',version});
            assert.equal(plan.status,'pending');
            await assert.rejects(jobs.create(actor,{deviceId,projectId:'fixture',kind:'install',assetKind:'mcp',assetId:'fixture-mcp',version,planId:plan.id,planRevision:plan.revision,requestKey:randomUUID()}),error=>error.status===409);
            const decision={expectedManifest:plan.manifest,expectedRevision:plan.revision};
            await assert.rejects(plans.decide({...actor,activeRole:'Разработчик'},plan.id,decision,'approved'),error=>error.status===403);
            const approved=await plans.decide(actor,plan.id,decision,'approved');
            assert.equal(approved.status,'approved'); approvedPlans.set(version,approved);
            await assert.rejects(plans.decide(actor,plan.id,decision,'revoked'),error=>error.status===409);
        }
        assert.equal((await devices.pool.query("SELECT count(*)::int AS n FROM security_events WHERE action='installation.approved'")).rows[0].n,3);
    });
    const create = async version => {
        await pinInstallationPackage(devices.pool,'fixture',manifests.get('fixture-mcp:'+version),actor);
        const plan=approvedPlans.get(version); assert.ok(plan,'Версия одобрена до отправки задания');
        return jobs.create(actor, { deviceId, projectId: 'fixture', kind: 'install', assetId: 'fixture-mcp', assetKind: 'mcp', version, planId:plan.id,planRevision:plan.revision,requestKey: randomUUID() });
    };
    const state = async id => (await devices.pool.query('SELECT * FROM bridge_jobs WHERE id=$1', [id])).rows[0];
    const file = path.join(project, assetBase(makePackage(1)), 'index.mjs');
    for (const [version, failure] of [[1, 'before'], [2, 'after']]) {
        await check(failure === 'before' ? 'Обрыв до серверной фиксации: сверка завершает установку без повторной записи' : 'Потерянный ответ после фиксации: повтор подтверждения идемпотентен', async () => {
            hold = failure; dropped = 0; const job = await create(version);
            await waitFor(() => dropped > 0, 'потерянного подтверждения', 22000);
            await stopWorker();
            assert.equal((await pendingCompletions())[0]?.state, 'succeeded');
            const before = (await fs.stat(file)).mtimeMs;
            if (failure === 'before') {
                await devices.pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
                await jobs.list(actor); assert.equal((await state(job.id)).state, 'reconciling');
            }
            hold = undefined; startWorker();
            await waitFor(async () => (await state(job.id)).state === 'succeeded' && (await pendingCompletions()).length === 0, 'сверки результата');
            assert.equal((await fs.stat(file)).mtimeMs, before);
            assert.equal((await devices.pool.query('SELECT state FROM operations WHERE operation_id=$1', ['bridge-' + job.id])).rows[0].state, 'SUCCEEDED');
            assert.equal((await installations.list(actor)).find(item => item.assetId === 'fixture-mcp').version, version);
        });
    }
    await check('Устаревший worker обновляется после паузы выдачи, без чужих процессов', async () => {
        const old = worker; await fs.rm(path.join(stateDir(), 'worker-version.json'));
        await ensureCurrentWorker();
        await waitFor(() => old.exitCode !== null || old.signalCode !== null, 'остановки своего worker');
        worker = undefined; startWorker();
        await waitFor(async () => {
            const marker = await fs.readFile(path.join(stateDir(), 'worker-version.json'), 'utf8').catch(error => {
                if (error.code === 'ENOENT') return '{}'; throw error;
            });
            return JSON.parse(marker).pid === worker.pid;
        }, 'новой версии worker');
        const same = worker.pid; await ensureCurrentWorker(); assert.equal(worker.pid, same);
        assert.equal((await devices.pool.query('SELECT paused_until FROM bridge_devices WHERE id=$1', [deviceId])).rows[0].paused_until, null);
    });
    await check('Потерянный отчёт привязки папки восстанавливается после аренды без повторного диалога', async () => {
        hold = 'before'; dropped = 0;
        const job = await jobs.create(actor, { deviceId, projectId: 'fixture', kind: 'bind-project', folderName: path.basename(project), requestKey: randomUUID() });
        await waitFor(() => dropped > 0, 'потерянного результата привязки', 22000); await stopWorker();
        await devices.pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
        await jobs.list(actor); assert.equal((await state(job.id)).state, 'reconciling');
        hold = undefined; startWorker();
        await waitFor(async () => (await state(job.id)).state === 'succeeded' && (await pendingCompletions()).length === 0, 'сверки привязки');
        assert.equal((await state(job.id)).result.projectId, 'fixture');
    });
    await stopWorker();
    await check('Повторное одобрение заменяет только очередь прежней ревизии и не подменяет начатую установку', async () => {
        const assetId='approval-replacement'; makePackage(1,assetId);
        await pinInstallationPackage(devices.pool,'fixture',manifests.get(assetId+':1'),actor);
        let plan=await plans.prepare(actor,{projectId:'fixture',assetKind:'mcp',assetId,version:1});
        const decide=async status=>{
            plan=await plans.decide(actor,plan.id,{expectedManifest:plan.manifest,expectedRevision:plan.revision},status);
            return plan;
        };
        const enqueue=()=>jobs.create(actor,{deviceId,projectId:'fixture',kind:'install',assetKind:'mcp',assetId,version:1,planId:plan.id,planRevision:plan.revision,requestKey:randomUUID()});
        await decide('approved'); assert.equal(plan.revision,1);
        const original=await enqueue();
        await decide('revoked'); assert.equal(plan.revision,2);
        await decide('approved'); assert.equal(plan.revision,3);
        const replacement=await enqueue(); assert.notEqual(replacement.id,original.id);
        assert.equal((await state(original.id)).state,'cancelled');
        assert.equal((await state(replacement.id)).state,'queued');
        assert.equal((await state(replacement.id)).payload.planRevision,3);
        assert.equal((await devices.pool.query('SELECT state FROM operations WHERE operation_id=$1',['bridge-'+original.id])).rows[0].state,'CANCELLED');
        const current=await jobs.claim(await devices.identity(token));assert.equal(current.id,replacement.id);
        await decide('revoked'); await decide('approved'); assert.equal(plan.revision,5);
        await assert.rejects(jobs.authorize(await devices.identity(token),current.id,current.lease),error=>error.status===409);
        await assert.rejects(enqueue(),error=>error.status===409);
        assert.equal((await state(current.id)).state,'running');
        await devices.pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[current.id]);
        await jobs.list(actor);assert.equal((await state(current.id)).state,'reconciling');
        await assert.rejects(enqueue(),error=>error.status===409);
        const pkg=current.payload.package;
        await completeDeviceJob(devices.pool,deviceId,current.id,{lease:current.lease,state:'failed',message:'Синтетическая проверка без записи файлов',
            result:{projectId:'fixture',assetId,version:1,manifest:pkg.manifest.sha256,bindingId:current.payload.bindingId,unchanged:true}});
    });
    await check('Переподключение после срока ключа сохраняет ID и историю; чужой аккаунт не подтверждает его', async () => {
        await devices.pool.query("UPDATE bridge_devices SET expires_at=now()-interval '1 second' WHERE id=$1", [deviceId]);
        assert.equal((await devices.list(actor)).find(item => item.id === deviceId).requiresReconnect, true);
        assert.ok((await installations.list(actor)).some(item => item.deviceId === deviceId));
        const replacement = randomBytes(32).toString('hex');
        const pair = await devices.start({ name: 'Временный компьютер', fingerprint: 'c'.repeat(64), credentialHash: createHash('sha256').update(replacement).digest('hex') }, token);
        await assert.rejects(devices.approve({ ...actor, email: 'other@example.test' }, pair.userCode), error => error.status === 409);
        await devices.approve(actor, pair.userCode); const renewed = await devices.poll(pair.deviceCode);
        assert.equal(renewed.deviceId, deviceId); await assert.rejects(devices.identity(token), error => error.status === 401);
        token = replacement; assert.equal((await devices.identity(token)).id, deviceId);
        assert.ok((await installations.list(actor)).some(item => item.deviceId === deviceId));
    });
    await check('Восемь вкладок с разными ключами создают одно ожидающее изменение инструмента', async () => {
        const responses = await Promise.all(Array.from({ length: 8 }, () => create(3)));
        assert.equal(new Set(responses.map(item => item.id)).size, 1);
        const installed = (await installations.list(actor)).find(item => item.assetId === 'fixture-mcp');
        await assert.rejects(jobs.create(actor, { deviceId, projectId: 'fixture', kind: 'uninstall', assetId: 'fixture-mcp', assetKind: 'mcp', expectedBindingId: await projectBindingId('fixture'), expectedManifest: installed.manifest, requestKey: randomUUID() }), error => error.status === 409);
    });
    await check('Два worker не получают одновременно два разных задания одного компьютера', async () => {
        await jobs.create(actor, { deviceId, projectId: 'fixture', kind: 'bind-project', folderName: path.basename(project), requestKey: randomUUID() });
        const device = await devices.identity(token);
        const claims = await Promise.all([jobs.claim(device), jobs.claim(device)]);
        assert.equal(claims.filter(Boolean).length, 1);
    });
    await devices.pool.query("UPDATE bridge_jobs SET state='cancelled' WHERE state IN ('queued','running','reconciling')");
    await check('Две подтверждённые попытки продления не могут повторно заменить уже обновлённый ключ', async () => {
        const attempts = [];
        for (let i = 0; i < 2; i++) {
            const candidate = randomBytes(32).toString('hex');
            const pair = await devices.start({ name: 'Временный компьютер', fingerprint: 'd'.repeat(64), credentialHash: createHash('sha256').update(candidate).digest('hex') }, token);
            await devices.approve(actor, pair.userCode); attempts.push({ candidate, pair });
        }
        assert.equal((await devices.poll(attempts[0].pair.deviceCode)).deviceId, deviceId);
        token = attempts[0].candidate;
        await assert.rejects(devices.poll(attempts[1].pair.deviceCode), error => error.status === 409);
        assert.equal((await devices.identity(token)).id, deviceId);
    });
    await check('Перепривязка папки и обрыв отчёта: отказ до записи сверяется после истечения аренды', async () => {
        const pending = await create(3); const before = (await fs.stat(file)).mtimeMs;
        const other = path.join(path.dirname(project), 'другая копия проекта'); await fs.mkdir(other);
        await bindProject('fixture', path.basename(other));
        hold = 'before'; dropped = 0;
        await writeState('credentials', { token, deviceId, email: actor.email }); startWorker();
        await waitFor(() => dropped > 0, 'потерянного отказа после перепривязки', 22000);
        await stopWorker();
        await devices.pool.query("UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [pending.id]);
        await jobs.list(actor); assert.equal((await state(pending.id)).state, 'reconciling');
        hold = undefined; startWorker();
        await waitFor(async () => (await state(pending.id)).state === 'failed', 'сверки отказа без записи');
        await stopWorker(); assert.equal((await fs.stat(file)).mtimeMs, before);
        assert.equal((await state(pending.id)).result.unchanged, true);
        await assert.rejects(fs.access(path.join(other, '.opencode/mcp-bundles')), error => error.code === 'ENOENT');
        assert.equal((await installations.list(actor)).find(item => item.assetId === 'fixture-mcp').bindingChanged, true);
    });
    await check('Позднее подтверждение старой версии не вытесняет новую установку из истории', async () => {
        const history=[];

        const bindingId=await projectBindingId('fixture');
        for (const [version,started] of [[1,'2026-01-01'],[2,'2026-01-02']]) {
            makePackage(version,'order-test');await pinInstallationPackage(devices.pool,'fixture',manifests.get('order-test:'+version),actor);
            const plan=await plans.prepare(actor,{projectId:'fixture',assetKind:'mcp',assetId:'order-test',version});
            const approved=await plans.decide(actor,plan.id,{expectedManifest:plan.manifest,expectedRevision:plan.revision},'approved');
            const job=await jobs.create(actor,{deviceId,projectId:'fixture',kind:'install',assetKind:'mcp',assetId:'order-test',version,planId:approved.id,planRevision:approved.revision,requestKey:randomUUID()});
            // Подготавливаем две исторические записи, а не параллельную очередь установки.
            await devices.pool.query("UPDATE bridge_jobs SET state='cancelled',lease=id,lease_until=now()-interval '1 minute',started_at=$2 WHERE id=$1",[job.id,started]);
            history.push([job.id,version]);
        }
        await devices.pool.query("UPDATE bridge_jobs SET state='reconciling' WHERE id=ANY($1::text[])",[history.map(([id])=>id)]);
        for (const [id,version] of history.reverse()) await completeDeviceJob(devices.pool, deviceId, id, { lease: id, state: 'succeeded', message: 'Файлы записаны', result: { projectId: 'fixture', assetId: 'order-test', version, manifest: manifests.get('order-test:' + version).manifest.sha256,bindingId } });
        assert.equal((await installations.list(actor)).find(item => item.assetId === 'order-test').version, 2);
    });
    await check('Незавершённое задание видно после 120 записей истории; пауза запрещает claim', async () => {
        const pending = await jobs.create(actor, { deviceId, projectId: 'fixture', kind: 'bind-project', folderName: path.basename(project), requestKey: randomUUID() });
        for (let i = 0; i < 120; i++) { const id = randomUUID(); await devices.pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash,state) VALUES($1,$2,$3,$4,'choose-root','{}',$1,$1,'cancelled')", [id, deviceId, actor.email, actor.activeRole]); }
        assert.ok((await jobs.list(actor)).some(item => item.id === pending.id));
        const device = await devices.identity(token); await devices.pause(device); assert.equal(await jobs.claim(device), null); await devices.resume(device);
    });
    await devices.pool.query("UPDATE bridge_jobs SET state='cancelled' WHERE state IN ('queued','running','reconciling')");
    await check('Очередь ограничена сотней действий; ожидание больше суток отменяется явно', async () => {
        for (let i = 0; i < 100; i++) { const id = randomUUID(); await devices.pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash) VALUES($1,$2,$3,$4,'choose-root','{}',$1,$1)", [id, deviceId, actor.email, actor.activeRole]); }
        await assert.rejects(jobs.create(actor, { deviceId, projectId: 'fixture', kind: 'bind-project', folderName: path.basename(project), requestKey: randomUUID() }), error => error.status === 429);
        await devices.pool.query("UPDATE bridge_jobs SET created_at=now()-interval '2 days' WHERE state='queued'");
        assert.ok((await jobs.list(actor)).every(item => item.state !== 'queued'));
    });
    assert.ok(!requestStates.includes('failed'), 'Потеря подтверждения не порождает ложную ошибку записи');
} catch (error) { fatal = error.stack || String(error); console.error(fatal); process.exitCode = 1; }
finally {
    await stopWorker();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await devices?.onModuleDestroy();
    if (created) { await admin.query(`DROP DATABASE "${database}"`); droppedDatabase = true; }
    const afterDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const originalDatabasesPreserved = JSON.stringify(beforeDatabases) === JSON.stringify(afterDatabases);
    await admin.end(); await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ results, fatal: fatal || null, ownDatabaseDropped: droppedDatabase,
        temporaryWorkspaceRemoved: true, originalDatabasesPreserved, realDeviceCommandsCreated: false }, null, 2) + '\n');
    if (!originalDatabasesPreserved) process.exitCode = 1;
}
