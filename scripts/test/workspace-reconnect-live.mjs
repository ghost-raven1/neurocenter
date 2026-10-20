// Настоящий Gateway и worker, только одноразовые проект, устройство и папка.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = new URL(process.env.NEUROCENTER_TEST_URL || 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Проверка разрешена только на локальном стенде');
assert.ok(!base.username && !base.password && base.pathname === '/', 'Нужен корневой URL без credentials');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-reconnect-'));
const folder = path.join(temporary, 'Рабочая папка', 'Проект с пробелами');
await fs.mkdir(folder, { recursive: true });
process.env.NEUROCENTER_URL = base.origin;
process.env.NEUROCENTER_BRIDGE_HOME = path.join(temporary, 'bridge-state');
const { writeState, readState } = await import(new URL('../../mcp/neurocenter-asset-sync/dist/bridge/state.js', import.meta.url));
const { setRoot } = await import(new URL('../../mcp/neurocenter-asset-sync/dist/bridge/workspace.js', import.meta.url));
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog' });
let cookie = '', project, deviceId, worker, pairHash;
const cases = [], cleanupErrors = [];

async function call(method, route, body, expected = 200) {
    const response = await fetch(new URL(route, base), { method, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Neurocenter-Request': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    // Ответы подключения содержат токен: их содержимое никогда не включается в диагностику.
    assert.equal(response.status, expected, `${method} ${route}: HTTP ${response.status}`);
    return value;
}
async function waitFor(read, label) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const value = await read(); if (value) return value;
        await delay(250);
    }
    throw new Error(`Не дождались: ${label}`);
}
async function device() { return (await call('GET', '/api/devices')).find(item => item.id === deviceId); }
async function runJob(kind, extra = {}) {
    const input = { deviceId, projectId: project.id, folderName: path.basename(folder), bindingMode: 'new', requestKey: randomUUID(), kind, ...extra };
    const queued = await call('POST', '/api/device-jobs', input, 201);
    const repeated = await call('POST', '/api/device-jobs', input, 201);
    assert.equal(repeated.id, queued.id, 'Повтор POST должен вернуть то же задание');
    return waitFor(async () => {
        const job = (await call('GET', '/api/device-jobs')).find(item => item.id === queued.id);
        return job && !['queued', 'running', 'reconciling'].includes(job.state) ? job : undefined;
    }, kind);
}
async function reconnect() {
    const prepared = await runJob('prepare-bind-project');
    assert.equal(prepared.state, 'succeeded', 'Проверка папки должна завершиться успешно');
    const committed = await runJob('bind-project', { preparationJobId: prepared.id, expectedPreparation: prepared.result.preparation });
    assert.equal(committed.state, 'succeeded', 'Привязка должна завершиться успешно');
    await waitFor(async () => (await device())?.report.bindings?.find(item => item.projectId === project.id && item.valid), 'подтверждённого отчёта');
    return committed.result;
}

try {
    const login = await fetch(new URL('/auth/login', base), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    const { user } = await call('GET', '/auth/me');
    assert.equal(user.activeRole, 'Главный админ', 'Нужен локальный профиль главного админа');
    project = await call('POST', '/api/projects', { name: 'QA reconnect ' + randomUUID().slice(0, 8) }, 201);
    await call('POST', `/api/projects/${project.id}/members`, { principalName: user.email, role: 'Разработчик' }, 201);
    const token = randomBytes(32).toString('hex');
    const pair = await call('POST', '/api/device-channel/pair/start', { name: 'QA · повторная привязка папки', fingerprint: randomBytes(32).toString('hex'),
        credentialHash: createHash('sha256').update(token).digest('hex') }, 201);
    pairHash = createHash('sha256').update(pair.deviceCode).digest('hex');
    await call('POST', `/api/device-pairs/${pair.userCode}/approve`, {}, 201);
    const connected = await call('POST', '/api/device-channel/pair/poll', { deviceCode: pair.deviceCode }, 201);
    deviceId = connected.deviceId;
    assert.ok(deviceId); assert.equal(connected.token, undefined);
    await writeState('credentials', { deviceId, token, email: user.email });
    const credentials = await readState('credentials');
    await setRoot(path.dirname(folder));
    worker = spawn(process.execPath, [path.join(root, 'mcp/neurocenter-asset-sync/dist/index.js'), '--worker'],
        { env: process.env, stdio: 'ignore' });
    await waitFor(async () => (await device())?.online, 'запуска одноразового worker');
    const original = await reconnect();
    const marker = path.join(folder, '.opencode/neurocenter.json');
    const markerText = await fs.readFile(marker, 'utf8');
    cases.push('Первичная prepare/commit привязка через Gateway, повторы POST идемпотентны');
    for (const removeAll of [true, false]) {
        if (removeAll) await fs.rm(path.join(folder, '.opencode'), { recursive: true });
        else {
            await fs.writeFile(path.join(folder, '.opencode/user-settings.json'), '{"theme":"dark"}');
            await fs.rm(marker);
        }
        const restored = await reconnect();
        assert.equal(restored.instanceId, original.instanceId); assert.equal(restored.bindingId, original.bindingId);
        assert.equal(await fs.readFile(marker, 'utf8'), markerText);
        assert.deepEqual(await readState('credentials'), credentials);
        assert.equal((await device()).id, deviceId);
        if (!removeAll) assert.equal(await fs.readFile(path.join(folder, '.opencode/user-settings.json'), 'utf8'), '{"theme":"dark"}');
        cases.push(removeAll ? 'Полное удаление .opencode: прежние device/instance/binding/credentials восстановлены' : 'Удалён только marker: настройки пользователя сохранены');
    }
    const repeated = await reconnect();
    assert.equal(repeated.bindingId, original.bindingId);
    cases.push('Повторная привязка после восстановления не создаёт новый экземпляр');
} finally {
    if (worker && worker.exitCode === null) {
        const exited = new Promise(resolve => worker.once('exit', resolve));
        worker.kill('SIGTERM');
        await Promise.race([exited, delay(5000)]);
        if (worker.exitCode === null) { worker.kill('SIGKILL'); await exited; }
    }
    if (project) {
        try { await call('DELETE', '/api/projects/' + project.id); }
        catch { cleanupErrors.push('Не удалён временный проект ' + project.id); }
    }
    const cleanup = await pool.connect();
    try {
        await cleanup.query('BEGIN');
        if (deviceId) {
            await cleanup.query('DELETE FROM bridge_instance_events WHERE device_id=$1', [deviceId]);
            await cleanup.query('DELETE FROM bridge_local_change_plans WHERE device_id=$1', [deviceId]);
            await cleanup.query("DELETE FROM operations WHERE operation_id IN (SELECT 'bridge-'||id FROM bridge_jobs WHERE device_id=$1)", [deviceId]);
            await cleanup.query('DELETE FROM bridge_jobs WHERE device_id=$1', [deviceId]);
            await cleanup.query('DELETE FROM bridge_devices WHERE id=$1', [deviceId]);
        }
        if (pairHash) await cleanup.query('DELETE FROM bridge_pairs WHERE code_hash=$1', [pairHash]);
        await cleanup.query('COMMIT');
    } catch { await cleanup.query('ROLLBACK'); cleanupErrors.push('Не очищены строки временного устройства'); }
    finally { cleanup.release(); }
    await pool.end();
    await fs.rm(temporary, { recursive: true, force: true });
    const report = { ok: cases.length === 4 && cleanupErrors.length === 0, passed: cases.length, cases, cleanupErrors,
        fixture: { projectId: project?.id, deviceId }, userDevicesChanged: false };
    await fs.mkdir(path.join(root, 'output/browser-feedback'), { recursive: true });
    await fs.writeFile(path.join(root, 'output/browser-feedback/workspace-reconnect-live.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    if (cleanupErrors.length) process.exitCode = 1;
}
