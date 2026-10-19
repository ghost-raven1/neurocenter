// Сквозная проверка на собственном временном проекте; секреты не попадают в отчёт.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(new URL('../../', import.meta.url).pathname);
const require = createRequire(
    path.join(root, 'services/catalog-service/package.json'),
);
const { Pool } = require('pg');
const { io } = await import(
    path.join(
        root,
        'mcp/neurocenter-asset-sync/node_modules/socket.io-client/build/esm/index.js',
    )
);
const base = 'http://localhost:5173';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-live-'));
process.env.NEUROCENTER_BRIDGE_HOME = path.join(temp, 'bridge');
process.env.NEUROCENTER_URL = base;
const { writeState } = await import(
    path.join(root, 'mcp/neurocenter-asset-sync/dist/bridge/state.js')
);
const { setRoot } = await import(
    path.join(root, 'mcp/neurocenter-asset-sync/dist/bridge/workspace.js')
);
const pool = new Pool({
    connectionString:
        process.env.CATALOG_PG_URL ||
        'postgresql://rag:rag@localhost:5432/catalog',
});
const login = await fetch(base + '/auth/login', { redirect: 'manual' });
const cookie = login.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
let worker;
let project;
let device;
let token;
const plugins = [];
const results = [];
const events = [];
let socket;
let keep = false;
async function call(
    method,
    route,
    body,
    expected = 200,
    deviceRequest = false,
) {
    const response = await fetch(base + route, {
        method,
        headers: {
            'Content-Type': 'application/json', 'X-Neurocenter-Request': '1',
            ...(deviceRequest
                ? { Authorization: 'Bearer ' + token }
                : { Cookie: cookie }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(
        response.status,
        expected,
        JSON.stringify({ route, status: response.status, data }),
    );
    return data;
}
async function waitFor(predicate, label, timeout = 20000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        const value = await predicate();
        if (value) {
            return value;
        }
        await delay(180);
    }
    throw new Error('Не дождались: ' + label);
}
const jobs = () => call('GET', '/api/device-jobs');
async function job(input) {
    return call(
        'POST',
        '/api/device-jobs',
        {
            deviceId: device.id,
            projectId: project.id,
            requestKey: randomUUID(),
            ...input,
        },
        201,
    );
}
async function finished(id) {
    return waitFor(async () => {
        const found = (await jobs()).find((item) => item.id === id);
        return found && !['queued', 'running', 'reconciling'].includes(found.state)
            ? found
            : undefined;
    }, 'завершения задания ' + id);
}
function start() {
    worker = spawn(
        process.execPath,
        [
            path.join(root, 'mcp/neurocenter-asset-sync/dist/index.js'),
            '--worker',
        ],
        { env: process.env, stdio: 'ignore' },
    );
}
async function stop() {
    if (worker && worker.exitCode === null) {
        worker.kill('SIGTERM');
        await waitFor(
            () => worker.exitCode !== null || worker.signalCode,
            'остановки MCP',
            8000,
        );
    }
    worker = undefined;
}
try {
    const profile = await call('GET', '/auth/me');
    const email = profile.user.email;
    await call('POST', '/auth/switch-role', { role: 'Главный админ' });
    socket = io(base, {
        transports: ['websocket'],
        extraHeaders: { Cookie: cookie },
        reconnectionDelay: 200,
        reconnectionDelayMax: 500,
    });
    socket.on('section:changed', (payload) =>
        events.push({ type: 'section', ...payload }),
    );
    socket.on('bridge:changed', (payload) =>
        events.push({ type: 'bridge', ...payload }),
    );
    await waitFor(() => socket.connected, 'соединения браузера');
    project = await call(
        'POST',
        '/api/projects',
        { name: 'Проверка MCP ' + randomUUID().slice(0, 8) },
        201,
    );
    await call(
        'POST',
        `/api/projects/${project.id}/members`,
        { principalName: email, role: 'Разработчик' },
        201,
    );
    const pair = await call(
        'POST',
        '/api/device-channel/pair/start',
        {
            name: 'Проверочный MCP',
            fingerprint: randomBytes(32).toString('hex'),
        },
        201,
    );
    await call(
        'POST',
        '/api/device-channel/pair/poll',
        { deviceCode: pair.deviceCode },
        201,
    ).then((value) => assert.equal(value.state, 'pending'));
    await call('POST', `/api/device-pairs/${pair.userCode}/approve`, {}, 201);
    const connected = await call(
        'POST',
        '/api/device-channel/pair/poll',
        { deviceCode: pair.deviceCode },
        201,
    );
    device = { id: connected.deviceId };
    token = connected.token;
    await writeState('credentials', { token, deviceId: device.id, email });
    await call(
        'POST',
        '/api/device-channel/pair/poll',
        { deviceCode: pair.deviceCode },
        409,
    );
    await call(
        'POST',
        '/api/platform/users',
        { email: 'must-not-be-created@example.test' },
        403,
        true,
    );
    results.push({
        case: 'Личное подключение одноразовое; ключ MCP не управляет пользователями',
        ok: true,
    });
    const workspaces = path.join(temp, 'Общая папка');
    const local = path.join(workspaces, 'имя отличается от серверного');
    await fs.mkdir(local, { recursive: true });
    await setRoot(workspaces);
    start();
    await waitFor(async () => (await call('GET', '/api/devices')).find(item => item.id === device.id)?.report.protocolVersion === 2, 'отчёта протокола MCP');
    const bind = await job({
        kind: 'bind-project',
        folderName: path.basename(local),
    });
    assert.equal((await finished(bind.id)).state, 'succeeded');
    await waitFor(async () => (await call('GET', '/api/devices')).find(item => item.id === device.id)?.report.bindings?.some(binding => binding.projectId === project.id && binding.bindingId && binding.valid !== false), 'отчёта привязки папки');
    const binding = JSON.parse(
        await fs.readFile(
            path.join(local, '.opencode/neurocenter.json'),
            'utf8',
        ),
    );
    assert.equal(binding.projectId, project.id);
    results.push({
        case: 'MCP связывает папку с другим названием по серверному ID',
        ok: true,
    });
    const database =
        'nc_rag_' +
        createHash('sha256').update(project.id).digest('hex').slice(0, 32);
    const previousDatabases = JSON.parse(
        await fs
            .readFile(path.join(root, '.run/bridge-rag-databases.json'), 'utf8')
            .catch(() => '[]'),
    );
    await fs.writeFile(
        path.join(root, '.run/bridge-rag-databases.json'),
        JSON.stringify([...previousDatabases, { id: project.id, database }]),
    );
    await call(
        'POST',
        '/api/rag/sync',
        {
            projectKey: project.id,
            chunks: [
                {
                    id: 'bridge-fixture',
                    filePath: 'README.md',
                    content: 'Знания с сервера',
                    embedding: Array(2560).fill(0.1),
                },
            ],
        },
        201,
    );
    const restore = await job({ kind: 'restore-rag' });
    const restoreResult = await finished(restore.id);
    assert.equal(restoreResult.state, 'succeeded', restoreResult.message);
    const lanceRequire = createRequire(
        path.join(root, 'mcp/neurocenter-asset-sync/package.json'),
    );
    const lancedb = lanceRequire('@lancedb/lancedb');
    const localDb = await lancedb.connect(path.join(local, '.opencode/rag_db'));
    const table = await localDb.openTable('chunks');
    assert.equal(await table.countRows(), 1);
    await table.update({
        where: "id = 'bridge-fixture'",
        values: { content: 'Знания с компьютера' },
    });
    await call('POST', '/auth/switch-role', { role: 'Разработчик' });
    const sync = await job({ kind: 'sync-rag' });
    const syncResult = await finished(sync.id);
    assert.equal(syncResult.state, 'succeeded', syncResult.message);
    const chunks = await call(
        'GET',
        '/api/rag/chunks?projectKey=' + project.id,
    );
    assert.equal(chunks.chunks[0].content, 'Знания с компьютера');
    await call('POST', '/auth/switch-role', { role: 'Главный админ' });
    results.push({
        case: 'Реальная LanceDB скачивается из PostgreSQL и синхронизируется обратно ролью разработчика',
        ok: true,
    });
    const plugin = await call(
        'POST',
        '/api/ai-plugins',
        {
            publicationKey: randomUUID(),
            name: 'Проверочный MCP ' + randomUUID().slice(0, 8),
            kind: 'mcp',
            description: 'Пакет для временной проверки установки',
            config: {
                transport: 'stdio',
                command: 'node',
                entrypoint: 'server.mjs',
                args: ['два слова'],
                env: { KEY: '{env:KEY}' },
            },
            files: [
                {
                    path: 'server.mjs',
                    content: '// Проверочный сервер\nconsole.log("fixture")\n',
                },
            ],
        },
        201,
    );
    plugins.push(plugin.id);
    await call(
        'POST',
        `/api/projects/${project.id}/assets`,
        { assetId: plugin.id, assetKind: 'mcp' },
        201,
    );
    const input = {
        deviceId: device.id,
        projectId: project.id,
        kind: 'install',
        assetId: plugin.id,
        assetKind: 'mcp',
        version: 1,
        requestKey: randomUUID(),
    };
    const install = await call('POST', '/api/device-jobs', input, 201);
    const duplicate = await call('POST', '/api/device-jobs', input, 201);
    assert.equal(duplicate.id, install.id);
    await call('POST', '/api/device-jobs', { ...input, version: 2 }, 409);
    assert.equal((await finished(install.id)).state, 'succeeded');
    const hash = createHash('sha256')
        .update('mcp:' + plugin.id)
        .digest('hex')
        .slice(0, 24);
    const installed = path.join(
        local,
        '.opencode/mcp-bundles',
        hash,
        'server.mjs',
    );
    assert.match(await fs.readFile(installed, 'utf8'), /Проверочный сервер/);
    const repeat = await job({
        kind: 'install',
        assetId: plugin.id,
        assetKind: 'mcp',
        version: 1,
    });
    assert.equal((await finished(repeat.id)).state, 'succeeded');
    results.push({
        case: 'Одно задание и точная версия; повтор установки проверяет реальный файл',
        ok: true,
    });
    const skill = await call('GET', '/api/skills/ops/rag-index-monitor');
    await call(
        'POST',
        `/api/projects/${project.id}/assets`,
        { assetId: 'ops/rag-index-monitor', assetKind: 'skill' },
        201,
    );
    const skillJob = await job({
        kind: 'install',
        assetKind: 'skill',
        assetId: 'ops/rag-index-monitor',
        version: skill.meta.version,
    });
    const skillResult = await finished(skillJob.id);
    assert.equal(skillResult.state, 'succeeded', skillResult.message);
    const skillText = await fs.readFile(
        path.join(local, '.opencode/skills/rag-index-monitor/SKILL.md'),
        'utf8',
    );
    assert.match(skillText, /name: "rag-index-monitor"/);
    assert(skillText.includes(skill.body));
    results.push({
        case: 'Скилл rag-index-monitor устанавливается локально с корректным SKILL.md',
        ok: true,
    });
    const extension = await call(
        'POST',
        '/api/ai-plugins',
        {
            publicationKey: randomUUID(),
            name: 'Проверочный плагин ' + randomUUID().slice(0, 8),
            kind: 'plugin',
            description: 'Временный пакет плагина',
            config: { entrypoint: 'plugin.mjs' },
            files: [
                {
                    path: 'plugin.mjs',
                    content: 'export const Fixture = async () => ({})\n',
                },
            ],
        },
        201,
    );
    plugins.push(extension.id);
    await call(
        'POST',
        `/api/projects/${project.id}/assets`,
        { assetId: extension.id, assetKind: 'plugin' },
        201,
    );
    const extensionJob = await job({
        kind: 'install',
        assetKind: 'plugin',
        assetId: extension.id,
        version: 1,
    });
    const extensionResult = await finished(extensionJob.id);
    assert.equal(extensionResult.state, 'succeeded', extensionResult.message);
    const config = JSON.parse(
        await fs.readFile(path.join(local, 'opencode.json'), 'utf8'),
    );
    assert(
        config.plugin.some(
            (item) => item.startsWith('file:') && item.endsWith('/plugin.mjs'),
        ),
    );
    results.push({
        case: 'Плагин записывается отдельным пакетом и подключается через file URL',
        ok: true,
    });
    await fs.writeFile(installed, '// Моя ручная правка');
    const dirty = await job({
        kind: 'install',
        assetId: plugin.id,
        assetKind: 'mcp',
        version: 1,
    });
    const failed = await finished(dirty.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.message, /вручную/);
    assert.equal(await fs.readFile(installed, 'utf8'), '// Моя ручная правка');
    results.push({
        case: 'Ручная правка сохраняется; ошибка MCP приходит в постоянный статус',
        ok: true,
    });
    await stop();
    const offline = await job({
        kind: 'bind-project',
        folderName: path.basename(local),
    });
    assert.equal(
        (await jobs()).find((item) => item.id === offline.id).state,
        'queued',
    );
    start();
    assert.equal((await finished(offline.id)).state, 'succeeded');
    results.push({
        case: 'Очередь переживает отключение и перезапуск MCP',
        ok: true,
    });
    const before = events.length;
    socket.io.engine.close();
    await waitFor(() => socket.connected, 'reconnect браузера');
    await call('PATCH', `/api/projects/${project.id}`, { retention: 22 });
    await waitFor(
        () =>
            events
                .slice(before)
                .some(
                    (item) =>
                        item.type === 'section' &&
                        item.sections.includes('projects'),
                ),
        'инвалидации после reconnect',
    );
    assert(
        events.some(
            (item) => item.type === 'bridge' && item.deviceId === device.id,
        ),
    );
    assert(
        events
            .filter((item) => item.type === 'section')
            .every((item) =>
                Object.keys(item).every((key) =>
                    ['type', 'sections', 'at'].includes(key),
                ),
            ),
    );
    results.push({
        case: 'WS доставляет статусы владельцу и инвалидации разделов после reconnect',
        ok: true,
    });
    await stop();
    await call('POST', '/auth/switch-role', { role: 'Разработчик' });
    const activeSync=await job({kind:'sync-rag'});
    const claimedSync=await call('POST','/api/device-channel/jobs/claim',{},201,true);
    assert.equal(claimedSync.id,activeSync.id);
    const revoked = await job({
        kind: 'install',
        assetId: plugin.id,
        assetKind: 'mcp',
        version: 1,
    });
    await call('POST', '/auth/switch-role', { role: 'Главный админ' });
    const members = await call('GET', `/api/projects/${project.id}/members`);
    const member = members.find((item) => item.principalName === email);
    await call(
        'DELETE',
        `/api/projects/${project.id}/members/${encodeURIComponent(member.userId)}`,
        { expectedRole: member.role },
    );
    const deniedSync=await fetch(base+'/api/rag/chunks?projectKey='+project.id,{headers:{authorization:'Bearer '+token,'x-neurocenter-job-id':activeSync.id,'x-neurocenter-job-lease':claimedSync.lease}});
    assert.equal(deniedSync.status,403);
    await call('POST',`/api/device-channel/jobs/${activeSync.id}/progress`,{lease:claimedSync.lease,state:'failed',message:'Проверка: роль отозвана во время синхронизации'},201,true);
    results.push({case:'Каждая порция синхронизации проверяет исходную роль задания даже у MCP главного админа',ok:true});
    start();
    assert.equal((await finished(revoked.id)).state, 'failed');
    results.push({
        case: 'Отзыв роли между постановкой и исполнением запрещает установку',
        ok: true,
    });
    await call('DELETE', '/api/devices/' + device.id);
    await call('POST', '/api/device-channel/identity', {}, 401, true);
    results.push({
        case: 'Отзыв устройства немедленно закрывает HTTP-канал',
        ok: true,
    });
    await fs.writeFile(
        path.join(root, '.run/bridge-live-smoke.json'),
        JSON.stringify({ results, events: events.length }, null, 2),
    );
    console.log(
        JSON.stringify({
            passed: results.length,
            cases: results.map((item) => item.case),
        }),
    );
    if (process.env.KEEP_BRIDGE_FIXTURE === 'true') {
        keep = true;
        await fs.writeFile(
            path.join(root, '.run/bridge-live-fixture.json'),
            JSON.stringify(
                {
                    temp,
                    projectId: project.id,
                    pluginId: plugin.id,
                    deviceId: device.id,
                    local,
                },
                null,
                2,
            ),
        );
    }
} finally {
    socket?.disconnect();
    await stop();
    await call('POST', '/auth/switch-role', { role: 'Главный админ' }).catch(
        () => undefined,
    );
    if (!keep) {
        if (project) {
            await call('DELETE', '/api/projects/' + project.id).catch(
                () => undefined,
            );
        }
        for (const id of plugins) {
            await call('DELETE', '/api/ai-plugins/' + id).catch(
                () => undefined,
            );
        }
        if (device) {
            await pool.query(
                "DELETE FROM operations WHERE operation_id IN (SELECT 'bridge-'||id FROM bridge_jobs WHERE device_id=$1)",
                [device.id],
            );
            await pool.query('DELETE FROM bridge_jobs WHERE device_id=$1', [
                device.id,
            ]);
            await pool.query('DELETE FROM bridge_devices WHERE id=$1', [
                device.id,
            ]);
        }
        await fs.rm(temp, { recursive: true, force: true });
    }
    await pool.end();
}
