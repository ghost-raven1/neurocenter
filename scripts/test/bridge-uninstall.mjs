// Проверяет удаление только в собственном временном проекте, не затрагивая файлы пользователя.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(new URL('../../', import.meta.url).pathname);
const base = process.env.NEUROCENTER_TEST_URL || 'http://localhost:5173';
const fixtureFile = path.join(root, '.run/uninstall-fixture.json');
const cleanupOnly = process.argv.includes('--cleanup');
let fixture = cleanupOnly ? JSON.parse(await fs.readFile(fixtureFile, 'utf8')) : {};
const temp =
    fixture.temp ||
    (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-uninstall-live-'))));
process.env.NEUROCENTER_BRIDGE_HOME = path.join(temp, 'private');
process.env.NEUROCENTER_URL = base;
const { writeState } = await import(
    path.join(root, 'mcp/neurocenter-asset-sync/dist/bridge/state.js')
);
const { setRoot } = await import(
    path.join(root, 'mcp/neurocenter-asset-sync/dist/bridge/workspace.js')
);
const require = createRequire(path.join(root, 'services/catalog-service/package.json'));
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
});
const { io } = await import(
    path.join(root, 'mcp/neurocenter-asset-sync/node_modules/socket.io-client/build/esm/index.js')
);
const login = await fetch(base + '/auth/login', { redirect: 'manual' });
const cookie = login.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
let project = fixture.project;
let deviceId = fixture.deviceId;
let pairHash = fixture.pairHash;
let worker;
let socket;
let keep = false;
const plugins = fixture.plugins || [];
const cases = [];
const events = [];
async function call(method, route, body, expected = 200) {
    const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Neurocenter-Request': '1', Cookie: cookie },
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
async function waitFor(action, label, timeout = 20000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        const value = await action();
        if (value) {
            return value;
        }
        await delay(150);
    }
    throw new Error('Не дождались: ' + label);
}
const jobs = () => call('GET', '/api/device-jobs');
const installations = () => call('GET', '/api/device-installations');
const createJob = (input, expected = 201) =>
    call(
        'POST',
        '/api/device-jobs',
        { deviceId, projectId: project.id, requestKey: randomUUID(), ...input },
        expected,
    );
async function done(id) {
    return waitFor(async () => {
        const item = (await jobs()).find((item) => item.id === id);
        return item && !['queued', 'running', 'reconciling'].includes(item.state) ? item : undefined;
    }, 'завершения ' + id);
}
async function success(input) {
    const job = await createJob(input);
    const result = await done(job.id);
    assert.equal(result.state, 'succeeded', result.message);
    return result;
}
async function stop() {
    if (worker && worker.exitCode === null) {
        worker.kill('SIGTERM');
        await waitFor(
            () => worker.exitCode !== null || worker.signalCode,
            'остановки worker',
            8000,
        );
    }
    worker = undefined;
}
function start() {
    worker = spawn(
        process.execPath,
        [path.join(root, 'mcp/neurocenter-asset-sync/dist/index.js'), '--worker'],
        {
            env: process.env,
            stdio: 'ignore',
            ...(process.argv.includes('--keep') ? { detached: true } : {}),
        },
    );
}
async function cleanup() {
    if (cleanupOnly && fixture.workerPid) {
        try {
            process.kill(fixture.workerPid, 'SIGTERM');
            await delay(250);
        } catch (error) {
            if (error.code !== 'ESRCH') {
                throw error;
            }
        }
    }
    await call('POST', '/auth/switch-role', { role: 'Главный админ' });
    if (deviceId) {
        await call('DELETE', '/api/devices/' + deviceId).catch(() => undefined);
    }
    if (project) {
        await call('DELETE', '/api/projects/' + project.id);
    }
    for (const id of plugins) {
        await call('DELETE', '/api/ai-plugins/' + id).catch(() => undefined);
    }
    if (deviceId) {
        await pool.query(
            "DELETE FROM operations WHERE operation_id IN (SELECT 'bridge-'||id FROM bridge_jobs WHERE device_id=$1)",
            [deviceId],
        );
        await pool.query('DELETE FROM bridge_jobs WHERE device_id=$1', [deviceId]);
        await pool.query('DELETE FROM bridge_devices WHERE id=$1', [deviceId]);
    }
    if (pairHash) {
        await pool.query('DELETE FROM bridge_pairs WHERE code_hash=$1', [pairHash]);
    }
    await fs.rm(temp, { recursive: true, force: true });
    await fs.rm(fixtureFile, { force: true });
}
try {
    if (cleanupOnly) {
        await cleanup();
        console.log(JSON.stringify({ cleaned: true }));
    } else {
        const profile = await call('GET', '/auth/me');
        const email = profile.user.email;
        await call('POST', '/auth/switch-role', { role: 'Главный админ' });
        socket = io(base, {
            transports: ['websocket'],
            extraHeaders: { Cookie: cookie },
        });
        socket.on('bridge:changed', (payload) => events.push(payload));
        await waitFor(() => socket.connected, 'соединения WebSocket');
        project = await call(
            'POST',
            '/api/projects',
            { name: 'Проверка удаления MCP ' + randomUUID().slice(0, 6) },
            201,
        );
        const database =
            'nc_rag_' + createHash('sha256').update(project.id).digest('hex').slice(0, 32);
        const trackedFile = path.join(root, '.run/uninstall-rag-databases.json');
        const tracked = JSON.parse(await fs.readFile(trackedFile, 'utf8').catch(() => '[]'));
        await fs.writeFile(trackedFile, JSON.stringify([...tracked, { id: project.id, database }]));
        const membership = await call(
            'POST',
            `/api/projects/${project.id}/members`,
            { principalName: email, role: 'Разработчик' },
            201,
        );
        const pair = await call(
            'POST',
            '/api/device-channel/pair/start',
            {
                name: 'Этот Mac · проверка удаления',
                fingerprint: randomBytes(32).toString('hex'),
            },
            201,
        );
        pairHash = createHash('sha256').update(pair.deviceCode).digest('hex');
        await call('POST', `/api/device-pairs/${pair.userCode}/approve`, {}, 201);
        const connected = await call(
            'POST',
            '/api/device-channel/pair/poll',
            { deviceCode: pair.deviceCode },
            201,
        );
        deviceId = connected.deviceId;
        await writeState('credentials', {
            token: connected.token,
            deviceId,
            email,
        });
        const workspace = path.join(temp, 'Общая папка');
        const local = path.join(workspace, 'Имя отличается от серверного');
        await fs.mkdir(local, { recursive: true });
        await setRoot(workspace);
        start();
        await waitFor(async () => (await call('GET', '/api/devices')).find(item => item.id === deviceId)?.report.protocolVersion === 2, 'отчёта протокола MCP');
        await success({
            kind: 'bind-project',
            folderName: path.basename(local),
        });
        await waitFor(async () => (await call('GET', '/api/devices')).find(item => item.id === deviceId)?.report.bindings?.some(binding => binding.projectId === project.id && binding.bindingId && binding.valid !== false), 'отчёта привязки папки');
        const configFile = path.join(local, 'opencode.jsonc');
        await fs.writeFile(
            configFile,
            '// Личные настройки\n{"model":"local/test","mcp":{"personal":{"type":"remote","url":"https://example.test/mcp"}},"plugin":["personal-plugin"]}\n',
            { mode: 0o600 },
        );
        for (const kind of ['mcp', 'plugin']) {
            const plugin = await call(
                'POST',
                '/api/ai-plugins',
                {
                    publicationKey: randomUUID(),
                    name: 'Проверка удаления ' + kind + ' ' + randomUUID().slice(0, 5),
                    kind,
                    description: 'Временный текстовый пакет',
                    config:
                        kind === 'plugin'
                            ? { entrypoint: 'index.mjs' }
                            : {
                                  transport: 'stdio',
                                  command: 'node',
                                  entrypoint: 'index.mjs',
                              },
                    files: [
                        {
                            path: 'index.mjs',
                            content: '// Тестовый пакет\nexport default async () => ({})\n',
                        },
                    ],
                },
                201,
            );
            plugins.push(plugin.id);
            await call(
                'POST',
                `/api/projects/${project.id}/assets`,
                { assetId: plugin.id, assetKind: kind },
                201,
            );
            await success({
                kind: 'install',
                assetId: plugin.id,
                assetKind: kind,
                version: 1,
            });
            const installed = (await installations()).find((item) => item.assetId === plugin.id);
            assert.ok(installed);
            assert.equal(installed.deviceId, deviceId);
            assert.equal(installed.version, 1);
            const key = createHash('sha256')
                .update(kind + ':' + plugin.id)
                .digest('hex')
                .slice(0, 24);
            const installedFile = path.join(local, `.opencode/${kind}-bundles/${key}/index.mjs`);
            await fs.writeFile(
                path.join(path.dirname(installedFile), 'личная заметка.txt'),
                'сохранить',
            );
            const removal = {
                kind: 'uninstall',
                assetId: plugin.id,
                assetKind: kind,
                expectedManifest: installed.manifest,
            };
            await createJob({ ...removal, expectedManifest: '0'.repeat(64) }, 409);
            await call(
                'PATCH',
                `/api/projects/${project.id}/members/${encodeURIComponent(membership.userId)}`,
                { role: 'Наблюдатель', expectedRole: 'Разработчик' },
            );
            await call('POST', '/auth/switch-role', { role: 'Наблюдатель' });
            await createJob(removal, 403);
            await call('POST', '/auth/switch-role', { role: 'Главный админ' });
            await call(
                'PATCH',
                `/api/projects/${project.id}/members/${encodeURIComponent(membership.userId)}`,
                { role: 'Разработчик', expectedRole: 'Наблюдатель' },
            );
            await call('POST', '/auth/switch-role', { role: 'Разработчик' });
            await createJob({ ...removal, projectId: 'prj-example-project' }, 403);
            await call('POST', '/auth/switch-role', { role: 'Главный админ' });
            if (kind === 'mcp') {
                await call('DELETE', `/api/projects/${project.id}/assets`, {
                    assetId: plugin.id,
                    assetKind: kind,
                });
                await call('DELETE', '/api/ai-plugins/' + plugin.id);
            } else {
                await stop();
                const queued = await createJob(removal);
                assert.equal(queued.state, 'queued');
                assert.ok((await installations()).find((item) => item.assetId === plugin.id));
                await call('DELETE', '/api/device-jobs/' + queued.id);
                start();
                await delay(250);
                assert.ok(await fs.readFile(installedFile, 'utf8'));
                cases.push({
                    case: 'Удаление ждёт отключённый MCP и отменяется до начала',
                    ok: true,
                });
            }
            const requestKey = randomUUID();
            const queued = await createJob({ ...removal, requestKey });
            const result = await done(queued.id);
            assert.equal(result.state, 'succeeded', result.message);
            assert.equal((await createJob({ ...removal, requestKey })).id, queued.id);
            await createJob(removal, 409);
            await assert.rejects(fs.access(installedFile));
            await assert.rejects(
                fs.access(path.join(local, '.opencode/neurocenter/receipts', key + '.json')),
            );
            assert.equal(
                await fs.readFile(
                    path.join(path.dirname(installedFile), 'личная заметка.txt'),
                    'utf8',
                ),
                'сохранить',
            );
            const backup = JSON.parse(await fs.readFile(result.result.recoveryPath, 'utf8'));
            assert.equal(backup.action, 'uninstall');
            assert.ok(backup.changes.some((change) => change.before?.includes('Тестовый пакет')));
            assert.equal(
                (await installations()).some((item) => item.assetId === plugin.id),
                false,
            );
            await waitFor(
                () => events.some((event) => event.jobId === queued.id),
                'статуса удаления по WebSocket',
            );
            cases.push({
                case:
                    kind === 'mcp'
                        ? 'MCP удаляется по исходному пакету после удаления карточки из общего и проектного каталогов'
                        : 'Плагин удаляется без посторонних файлов и подключений',
                ok: true,
            });
        }
        const config = await fs.readFile(configFile, 'utf8');
        assert.ok(config.includes('// Личные настройки'));
        assert.ok(config.includes('personal-plugin'));
        assert.ok(config.includes('https://example.test/mcp'));
        assert.equal(config.includes('neurocenter_'), false);
        cases.push({
            case: 'JSONC-комментарии, модель, чужой MCP и чужой плагин сохраняются',
            ok: true,
        });
        cases.push({
            case: 'Наблюдатель, чужой проект и устаревшая квитанция отклоняются сервером',
            ok: true,
        });
        const skill = await call('GET', '/api/skills/ops/rag-index-monitor');
        await call(
            'POST',
            `/api/projects/${project.id}/assets`,
            { assetId: 'ops/rag-index-monitor', assetKind: 'skill' },
            201,
        );
        await success({
            kind: 'install',
            assetId: 'ops/rag-index-monitor',
            assetKind: 'skill',
            version: skill.meta.version,
        });
        const installedSkill = (await installations()).find(
            (item) => item.assetId === 'ops/rag-index-monitor',
        );
        assert.ok(installedSkill);
        const skillFile = path.join(local, '.opencode/skills', skill.meta.slug, 'SKILL.md');
        const original = await fs.readFile(skillFile, 'utf8');
        await fs.writeFile(skillFile, original + '\nМоя правка');
        const removal = {
            kind: 'uninstall',
            assetId: 'ops/rag-index-monitor',
            assetKind: 'skill',
            expectedManifest: installedSkill.manifest,
        };
        const dirty = await createJob(removal);
        const failure = await done(dirty.id);
        assert.equal(failure.state, 'failed');
        assert.ok(failure.message.includes('вручную'));
        assert.ok((await installations()).find((item) => item.assetId === 'ops/rag-index-monitor'));
        assert.ok((await fs.readFile(skillFile, 'utf8')).includes('Моя правка'));
        await fs.writeFile(skillFile, original);
        await success(removal);
        assert.equal((await installations()).length, 0);
        cases.push({
            case: 'Ручная правка скилла блокирует удаление; установка остаётся в списке до успешного повтора',
            ok: true,
        });
        await fs.writeFile(
            path.join(root, '.run/bridge-uninstall-smoke.json'),
            JSON.stringify({ cases, events: events.length }, null, 2),
        );
        console.log(
            JSON.stringify({
                passed: cases.length,
                cases: cases.map((item) => item.case),
            }),
        );
        if (process.argv.includes('--keep')) {
            await success({
                kind: 'install',
                assetId: 'ops/rag-index-monitor',
                assetKind: 'skill',
                version: skill.meta.version,
            });
            keep = true;
            fixture = {
                temp,
                project,
                deviceId,
                pairHash,
                local,
                plugins,
                workerPid: worker.pid,
            };
            await fs.writeFile(fixtureFile, JSON.stringify(fixture), {
                mode: 0o600,
            });
            worker.unref();
            console.log(
                JSON.stringify({
                    reviewUrl: base + '/store?p=' + encodeURIComponent(project.name),
                }),
            );
        }
    }
} finally {
    socket?.disconnect();
    if (!keep) {
        await stop();
        if (!cleanupOnly) {
            await cleanup();
        }
    }
    await pool.end();
}
