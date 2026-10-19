import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {readFile} from 'node:fs/promises';
const bridgeVersion=JSON.parse(await readFile(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url),'utf8')).version;

/** Проверяет новые маршруты через настоящий HTTPS gateway в одноразовом production-стеке. */
export async function verifyProductionBridge({ check, request, query }) {
    const channel = (route, body = {}, token) => request('/api/device-channel/' + route, {
        method: 'POST', body, headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    const hash = value => createHash('sha256').update(value).digest('hex');
    const token = randomBytes(32).toString('hex'); let deviceId;
    await check('Автономный архив MCP доступен по HTTPS с SHA256; неизвестная платформа даёт 404', async () => {
        const file = `/api/bridge/runtime/neurocenter-asset-sync-darwin-arm64-${bridgeVersion}.tgz`;
        const manifest = await request(file + '.json'); assert.equal(manifest.status, 200);
        const sha = await request(file + '.sha256'); assert.equal(sha.status, 200); assert.equal(sha.data.trim(), manifest.data.sha256);
        const archive = await request(file, { method: 'HEAD' }); assert.equal(archive.status, 200);
        assert.equal(Number(archive.headers['content-length']), manifest.data.bytes); assert.equal(archive.headers['cache-control'], 'no-store');
        assert.equal((await request(file.replace('darwin-arm64', 'unsupported'))).status, 404);
        const script = await request('/api/bridge/install.sh?reconnect=1'); assert.equal(script.status, 200);
        assert.ok(script.data.includes("RECONNECT='1'")); assert.ok(script.data.includes("VERSION='"+bridgeVersion+"'")); assert.ok(script.data.includes('https://panel.test/api/bridge'));
        assert.equal(script.data.includes('__BASE_URL__'), false); assert.equal(script.data.includes('__RECONNECT__'), false);
    });
    await check('Новый протокол подключения проходит HTTPS и повторяет ответ без нового устройства или секретов', async () => {
        const pair = await channel('pair/start', { name: 'Изолированная проверка MCP', fingerprint: 'a'.repeat(64), credentialHash: hash(token) });
        assert.equal(pair.status, 201); assert.equal((await channel('pair/poll', { deviceCode: pair.data.deviceCode })).data.state, 'pending');
        assert.equal((await request('/api/device-pairs/' + pair.data.userCode + '/approve', { method: 'POST', body: {} })).status, 201);
        const connected = await channel('pair/poll', { deviceCode: pair.data.deviceCode }); assert.equal(connected.status, 201); deviceId = connected.data.deviceId;
        assert.ok(deviceId); assert.equal(connected.data.token, undefined);
        assert.equal((await channel('pair/poll', { deviceCode: pair.data.deviceCode })).data.deviceId, deviceId);
        assert.equal((await channel('identity', {}, token)).data.id, deviceId);
        assert.equal((await request('/api/devices')).data.length, 1);
    });
    await check('Новые heartbeat, пауза и продолжение доступны только устройству; повреждённый отчёт отклоняется', async () => {
        assert.equal((await channel('worker/pause')).status, 401);
        assert.equal((await channel('heartbeat', { bindings: 'повреждено' }, token)).status, 400);
        assert.equal((await channel('heartbeat', { root: null, folders: [], bindings: [], protocolVersion: 2,
            bridgeVersion: '0.2.0', capabilities: ['durable-completions', 'managed-installations'] }, token)).status, 201);
        const paused = await channel('worker/pause', {}, token); assert.equal(paused.status, 201); assert.equal(paused.data.activeJobs, 0);
        assert.equal((await channel('worker/resume', {}, token)).status, 201);
        assert.equal((await channel('worker/delete-all', {}, token)).status, 404);
    });
    let jobId;
    await check('Поздний результат выбора папки через HTTPS сверяется, проверяет аренду и обновляет журнал', async () => {
        const queued = await request('/api/device-jobs', { method: 'POST', body: { deviceId, kind: 'choose-root', requestKey: randomUUID() } });
        assert.equal(queued.status, 201); jobId = queued.data.id;
        const claimed = await channel('jobs/claim', {}, token); assert.equal(claimed.status, 201); assert.equal(claimed.data.id, jobId);
        const body = { lease: claimed.data.lease, state: 'succeeded', message: 'Проверка без доступа к компьютеру', result: { root: '/fixture' } };
        query('catalog', `UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id='${jobId}'`);
        assert.equal((await request('/api/device-jobs')).data.find(item => item.id === jobId).state, 'reconciling');
        assert.equal((await channel(`jobs/${jobId}/complete`, { ...body, lease: randomUUID() }, token)).status, 409);
        assert.equal((await channel(`jobs/${jobId}/complete`, body, token)).data.repeated, false);
        assert.equal((await channel(`jobs/${jobId}/complete`, body, token)).data.repeated, true);
        assert.equal(query('catalog', `SELECT state FROM operations WHERE operation_id='bridge-${jobId}'`), 'SUCCEEDED');
    });
    await check('Продление истёкшего подключения через gateway сохраняет ID и журнал, старый ключ больше не действует', async () => {
        query('catalog', `UPDATE bridge_devices SET expires_at=now()-interval '1 second' WHERE id='${deviceId}'`);
        assert.equal((await request('/api/devices')).data[0].requiresReconnect, true);
        const candidate = randomBytes(32).toString('hex');
        const pair = await channel('pair/start', { name: 'Изолированная проверка MCP', fingerprint: 'a'.repeat(64), credentialHash: hash(candidate) }, token);
        assert.equal(pair.status, 201);
        assert.equal((await request('/api/device-pairs/' + pair.data.userCode + '/approve', { method: 'POST', body: {} })).status, 201);
        assert.equal((await channel('pair/poll', { deviceCode: pair.data.deviceCode })).data.deviceId, deviceId);
        assert.equal((await channel('identity', {}, token)).status, 401);
        assert.equal((await channel('identity', {}, candidate)).data.id, deviceId);
        assert.equal((await request('/api/device-jobs')).data.find(item => item.id === jobId).state, 'succeeded');
        assert.equal((await request('/api/devices')).data.length, 1);
    });
}
