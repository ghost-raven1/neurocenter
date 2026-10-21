import {seedInstallationProjects,pinInstallationPackage} from './installation-catalog.fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const evidence = process.env.RELIABLE_INSTALLATION_EVIDENCE_DIR || path.join(repository, '.run/reliable-installation-20261017');
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const actor = { email: 'reliable-worker-fixture@example.test', activeRole: 'Главный админ' };
export const projectId = 'reliable-fixture';
export const legacyProjectId = 'legacy-fixture';
export const assetId = 'ai-plug-reliable-worker-fixture';
const require = createRequire(path.join(repository, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const sourceRequire = createRequire(path.join(repository, 'mcp/neurocenter-asset-sync/package.json'));
const load = file => import(pathToFileURL(path.join(repository, file)).href);

export async function waitFor(predicate, label, timeout = 25_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await predicate()) return; await delay(40); }
    throw new Error('Не дождались: ' + label);
}
export async function snapshot(root) {
    const result = {};
    const walk = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(file);
            else { assert.ok(entry.isFile()); const stat = await fs.stat(file); result[path.relative(root, file)] = { sha256: digest(await fs.readFile(file)), mtimeMs: stat.mtimeMs }; }
        }
    };
    await walk(root); return result;
}

/** Один собственный PostgreSQL и один source worker, без personal MCP, native picker и OS opener. */
export async function createWorkerFixture() {
    await fs.mkdir(evidence, { recursive: true });
    const database = 'nc_install_test_' + randomBytes(8).toString('hex');
    const adminUrl = process.env.RELIABLE_INSTALLATION_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
    const admin = new Pool({ connectionString: adminUrl });
    const beforeDatabases = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-reliable-worker-')));
    const openerBin = path.join(temporary, 'bin'); const openerLog = path.join(temporary, 'report-opener.jsonl');
    await fs.mkdir(openerBin);
    // Подменяем только PATH дочернего worker: отчёт остаётся локальным, системный браузер не запускается.
    await fs.writeFile(path.join(openerBin, process.platform === 'darwin' ? 'open' : 'xdg-open'), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const args = process.argv.slice(2); const scope = crypto.createHash('sha256').update(new URL(process.env.NEUROCENTER_URL).origin).digest('hex').slice(0, 20);
const directory = path.join(${JSON.stringify(temporary)}, 'bridge', scope, 'local-change-plans');
if (args.length !== 1 || path.dirname(args[0]) !== directory || !/^[a-f0-9-]{36}\\.html$/.test(path.basename(args[0])) || fs.realpathSync(args[0]) !== args[0]) process.exit(64);
fs.appendFileSync(${JSON.stringify(openerLog)}, JSON.stringify({ args, sha256: crypto.createHash('sha256').update(fs.readFileSync(args[0])).digest('hex') }) + '\\n', { mode: 0o600 });
`, { mode: 0o700 });
    const openerInvocations = async () => (await fs.readFile(openerLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const cleanup = { ownDatabaseDropped: false, temporaryWorkspaceRemoved: false, workerStopped: false, originalDatabasesPreserved: false, originalCatalogDataPreserved: false };
    const dev = new URL(adminUrl); dev.pathname = '/catalog';
    const devPool = beforeDatabases.some(row => row.datname === 'catalog') ? new Pool({ connectionString: dev.href }) : undefined;
    const devSnapshot = async () => {
        if (!devPool) return null;
        const result = {};
        for (const name of ['projects', 'bridge_devices', 'bridge_jobs', 'device_install_plans', 'bridge_instance_events', 'bridge_local_change_plans']) {
            if (!(await devPool.query('SELECT to_regclass($1) AS name', ['public.' + name])).rows[0].name) continue;
            const value = name === 'bridge_devices' ? "(to_jsonb(t)-'last_seen'-'report')" : 'to_jsonb(t)';
            result[name] = (await devPool.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(${value}::text),'' ORDER BY md5(${value}::text)),'')) AS fingerprint FROM public.${name} t`)).rows[0];
        }
        return result;
    };
    const devBefore = await devSnapshot();
    let created = false, devices, jobs, installations, plans, server, worker, unregister;
    let workerSequence = 0, origin, token, deviceId, pkg;
    const hooks = new Map(); const authorizeCounts = new Map(); const completions = [];
    const lostAcks = new Set(); const committedAcks = new Set();
    const log = createWriteStream(path.join(evidence, 'worker.log'), { flags: 'a' });
    const state = async id => (await devices.pool.query('SELECT * FROM bridge_jobs WHERE id=$1', [id])).rows[0];
    const stopWorker = async () => {
        if (worker && worker.exitCode === null && worker.signalCode === null) {
            const child = worker; const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM');
            await Promise.race([exited, delay(3000)]);
            if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        }
        worker = undefined;
    };
    const startWorker = () => {
        assert.equal(worker, undefined); log.write(`\nЗапуск source worker ${++workerSequence}\n`);
        worker = spawn(process.execPath, ['--import', 'tsx', path.join(repository, 'mcp/neurocenter-asset-sync/src/index.ts'), '--worker'], {
            cwd: path.join(repository, 'mcp/neurocenter-asset-sync'), stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: path.join(temporary, 'home'), USERPROFILE: path.join(temporary, 'home'),
                PATH: openerBin + path.delimiter + (process.env.PATH ?? ''),
                XDG_CONFIG_HOME: path.join(temporary, 'home/config'), XDG_DATA_HOME: path.join(temporary, 'home/data'),
                XDG_CACHE_HOME: path.join(temporary, 'home/cache'), XDG_STATE_HOME: path.join(temporary, 'home/state'),
                NEUROCENTER_BRIDGE_HOME: path.join(temporary, 'bridge'), NEUROCENTER_URL: origin },
        });
        worker.stdout.pipe(log, { end: false }); worker.stderr.pipe(log, { end: false });
    };
    const close = async () => {
        await stopWorker(); cleanup.workerStopped = true;
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await devices?.onModuleDestroy();
        if (created) { await admin.query(`DROP DATABASE "${database}"`); cleanup.ownDatabaseDropped = !(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount; }
        const after = (await admin.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
        cleanup.originalDatabasesPreserved = JSON.stringify(beforeDatabases) === JSON.stringify(after);
        cleanup.originalCatalogDataPreserved = JSON.stringify(devBefore) === JSON.stringify(await devSnapshot());
        await devPool?.end(); await admin.end(); await unregister?.();
        await fs.rm(temporary, { recursive: true, force: true }); cleanup.temporaryWorkspaceRemoved = true;
        await new Promise(resolve => log.end(resolve));
        return cleanup;
    };
    try {
        await admin.query(`CREATE DATABASE "${database}"`); created = true;
        const url = new URL(adminUrl); url.pathname = '/' + database; process.env.CATALOG_PG_URL = url.href;
        process.env.NEUROCENTER_BRIDGE_HOME = path.join(temporary, 'bridge');
        process.env.HOME = path.join(temporary, 'home');
        unregister = sourceRequire('tsx/esm/api').register();
        const { DeviceStore } = await load('services/catalog-service/dist/devices/device-store.js');
        const { DeviceJobs } = await load('services/catalog-service/dist/devices/device-jobs.js');
        const { DeviceInstallations } = await load('services/catalog-service/dist/devices/device-installations.js');
        const { InstallPlans } = await load('services/catalog-service/dist/devices/install-plans.js');
        const { completeDeviceJob } = await load('services/catalog-service/dist/devices/device-completion.js');
        const { buildPackage } = await load('services/catalog-service/dist/catalog/bundle-package.js');
        const claims = async email => ({ email, userRoles: ['Главный админ', 'Разработчик', 'Наблюдатель'], projects: [projectId, legacyProjectId].map(id => ({ projectId: id, projectName: id, role: 'Админ проекта' })) });
        devices = new DeviceStore({ claims }); await devices.onModuleInit();
        assert.equal((await devices.pool.query('SELECT current_database() AS name')).rows[0].name, database);
        await seedInstallationProjects(devices.pool,[projectId,legacyProjectId],actor);

        pkg = buildPackage({ kind: 'mcp', id: assetId, name: 'reliable-worker-fixture', version: 1 },
            [{ path: 'index.mjs', content: '// Одобренная версия; при установке и восстановлении код не запускается.\nexport default {};\n' }], 'now', { transport: 'stdio', command: 'node', entrypoint: 'index.mjs' });
        const artifacts = { build: async (kind, id, version) => { assert.equal(kind, 'mcp'); assert.equal(id, assetId); assert.equal(version, 1); return pkg; } };
        installations = new DeviceInstallations(devices); plans = new InstallPlans(devices, artifacts); jobs = new DeviceJobs(devices, artifacts, installations, plans);
        for (const id of [projectId,legacyProjectId]) await pinInstallationPackage(devices.pool,id,pkg,actor);
        const credential = randomBytes(32).toString('hex');
        const pair = await devices.start({ name: 'Проверка надежных установок', fingerprint: '7'.repeat(64), credentialHash: digest(credential) });
        await devices.approve(actor, pair.userCode); const connected = await devices.poll(pair.deviceCode); token = credential; deviceId = connected.deviceId;
        server = http.createServer(async (request, response) => {
            try {
                const chunks = []; for await (const chunk of request) { chunks.push(chunk); assert.ok(chunks.reduce((n, value) => n + value.length, 0) < 32 * 1024 * 1024); }
                const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                if (request.url === '/internal/events') { response.end('{}'); return; }
                if (!request.url.startsWith('/api/device-channel/')) { response.writeHead(404).end('{}'); return; }
                let device = await devices.identity(String(request.headers.authorization || '').replace(/^Bearer /, ''));
                const route = request.url.slice('/api/device-channel/'.length); const id = route.split('/')[1]; let result;
                if (route === 'identity') result = { id: device.id, email: device.email, role: device.role };
                else if (route === 'heartbeat') result = await devices.heartbeat(device, body);
                else if (route === 'jobs/claim') result = await jobs.claim(device);
                else if (/^jobs\/[^/]+\/authorize$/.test(route)) {
                    const count = (authorizeCounts.get(id) ?? 0) + 1; authorizeCounts.set(id, count);
                    await hooks.get(id)?.(count, device); device = await devices.identity(token);
                    result = await jobs.authorize(device, id, body.lease);
                } else if (/^jobs\/[^/]+\/progress$/.test(route)) result = await jobs.update(device, id, body);
                else if (/^jobs\/[^/]+\/complete$/.test(route)) {
                    if (lostAcks.has(id) && committedAcks.has(id)) { response.writeHead(503).end('{}'); return; }
                    result = await completeDeviceJob(devices.pool, device.id, id, body); completions.push({ id, repeated: result.repeated });
                    if (lostAcks.has(id)) { committedAcks.add(id); response.destroy(); return; }
                } else { response.writeHead(404).end('{}'); return; }
                response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
            } catch (error) { response.writeHead(error.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: error.message })); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${server.address().port}`; process.env.NEUROCENTER_URL = origin; process.env.API_GATEWAY_URL = origin;
        const stateModule = await load('mcp/neurocenter-asset-sync/src/bridge/state.ts');
        const workspace = await load('mcp/neurocenter-asset-sync/src/bridge/workspace.ts');
        const receipts = await load('mcp/neurocenter-asset-sync/src/bridge/installation-receipt.ts');
        const { inspectInstallation } = await load('mcp/neurocenter-asset-sync/src/bridge/installation-inspection.ts');
        const { pendingCompletions } = await load('mcp/neurocenter-asset-sync/src/bridge/completions.ts');
        const parse = sourceRequire('jsonc-parser').parse;
        const parent = path.join(temporary, 'проекты'); const folderA = path.join(parent, 'Папка А'); const legacyFolder = path.join(parent, 'Старая папка');
        await fs.mkdir(folderA, { recursive: true }); await fs.mkdir(legacyFolder, { recursive: true });
        await stateModule.writeState('credentials', { token, deviceId, email: actor.email }); await workspace.setRoot(parent);
        const heartbeat = () => workspace.workspaceReport().then(report => devices.heartbeat({ id: deviceId, email: actor.email, role: actor.activeRole }, report));
        await heartbeat();
        const request = async (kind, extra = {}, project = projectId) => ({ deviceId, projectId: project, kind, assetKind: 'mcp', assetId,
            expectedManifest: pkg.manifest.sha256, expectedBindingId: extra.expectedBindingId ?? await workspace.projectBindingId(project), requestKey: randomUUID(), ...extra });
        const create = async (kind, extra = {}, project = projectId) => jobs.create(actor, await request(kind, extra, project));
        const run = async (job, expected = 'succeeded') => {
            startWorker();
            try { await waitFor(async () => ['succeeded', 'failed'].includes((await state(job.id)).state), `задания ${job.kind} ${job.id}`); }
            finally { await stopWorker(); }
            const completed = await state(job.id); assert.equal(completed.state, expected, completed.message); return completed;
        };
        const approved = async project => {
            const pending = await plans.prepare(actor, { projectId: project, assetKind: 'mcp', assetId, version: 1 });
            return plans.decide(actor, pending.id, { expectedManifest: pending.manifest, expectedRevision: pending.revision }, 'approved');
        };
        const initialBind = (project, folder) => jobs.create(actor, { deviceId, projectId: project, kind: 'bind-project', bindingMode: 'new', folderName: path.basename(folder), requestKey: randomUUID() });
        const prepare = async (project = projectId) => (await run(await create('prepare-local-change', {}, project))).result;
        const apply = (plan, project = projectId) => create('apply-local-change', { changePlanId: plan.planId, changePlanRevision: plan.revision, expectedChangeDigest: plan.digest }, project);
        const prepareBinding = async (mode, folder, expectedBindingId, expectedInstanceId, project = projectId) => {
            const input = { deviceId, projectId: project, bindingMode: mode, folderName: path.basename(folder), expectedBindingId,
                ...(expectedInstanceId ? { expectedInstanceId } : {}) };
            const preparedJob = await jobs.create(actor, { ...input, kind: 'prepare-bind-project', requestKey: randomUUID() });
            const prepared = (await run(preparedJob)).result;
            return { prepared, create: () => jobs.create(actor, { ...input, kind: 'bind-project', preparationJobId: preparedJob.id, expectedPreparation: prepared.preparation, requestKey: randomUUID() }) };
        };
        return { temporary, database, cleanup, devices, jobs, installations, plans, pkg, deviceId, token, origin, folderA, legacyFolder, parent,
            workspace, receipts, inspectInstallation, stateModule, pendingCompletions, parse, state, request, create, run, approved, initialBind, prepare, apply,
            heartbeat, hooks, authorizeCounts, lostAcks, committedAcks, completions, startWorker, stopWorker, prepareBinding, openerInvocations, close };
    } catch (error) { error.cleanup = await close(); throw error; }
}
