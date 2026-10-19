import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Настоящие HTTPS/SSO/PG проверяют одобрение графа; устройство имитируется без записи на компьютер. */
export async function verifyProductionDependencies({ check, request, projectId }) {
    const token = randomBytes(32).toString('hex');
    const channel = (route, body = {}) => request('/api/device-channel/' + route,
        { method: 'POST', body, headers: { Authorization: 'Bearer ' + token } });
    const post = (url, body) => request(url, { method: 'POST', body });
    const pin = pkg => ({ kind: pkg.plugin.kind, id: pkg.plugin.id, version: pkg.plugin.version, manifest: pkg.manifest.sha256 });
    const selection = (ref, method = 'POST') => request('/api/projects/' + projectId + '/assets',
        { method, body: { assetKind: ref.kind, assetId: ref.id } });
    const bindingId = 'd'.repeat(64);
    const report = { root: '/fixture', folders: ['project'], bindings: [{ projectId, folderName: 'project', valid: true, bindingId }],
        protocolVersion: 2, bridgeVersion: '0.5.0', capabilities: ['durable-completions', 'managed-installations', 'package-v3', 'package-v4', 'install-set-v1'] };
    let dependency, plugin, plan, deviceId, claimed;
    const rootId = 'common/dependency-set-fixture';
    const job = () => ({ kind: 'install', deviceId, projectId, assetKind: 'skill', assetId: rootId, version: 1,
        planId: plan.id, planRevision: plan.revision, requestKey: randomUUID() });
    await check('HTTPS-план закрепляет транзитивный граф и показывает код всех инструментов', async () => {
        const created = await post('/api/ai-plugins', { name: 'Зависимость комплекта', kind: 'mcp', description: 'Проверка точной версии',
            config: { transport: 'remote', url: 'https://example.test/mcp-v1' }, publicationKey: randomUUID() });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        dependency = (await request('/api/ai-plugins/' + created.data.id + '/package?version=1')).data;
        const member = await post('/api/ai-plugins', { name: 'Плагин комплекта', kind: 'plugin', description: 'Транзитивная зависимость',
            files: [{ path: 'index.mjs', content: 'export default async () => ({});\n' }], config: { entrypoint: 'index.mjs' }, dependencies: [pin(dependency)], publicationKey: randomUUID() });
        assert.equal(member.status, 201, JSON.stringify(member.data));
        plugin = (await request('/api/ai-plugins/' + member.data.id + '/package?version=1')).data;
        const skill = await post('/api/skills', { path: 'common', slug: 'dependency-set-fixture', name: 'Скилл с комплектом',
            body: 'Инструкция комплекта', meta: { description: 'Проверка установки закреплённого комплекта', dependencies: [pin(plugin), pin(dependency)] } });
        assert.equal(skill.status, 201, JSON.stringify(skill.data));
        for (const ref of [pin(dependency), pin(plugin), { kind: 'skill', id: rootId }]) { assert.equal((await selection(ref)).status, 201); }
        const prepared = await post('/api/device-install-plans', { projectId, assetKind: 'skill', assetId: rootId, version: 1 });
        assert.equal(prepared.status, 201, JSON.stringify(prepared.data)); plan = prepared.data;
        assert.equal(plan.packages.length, 3); assert.equal(plan.status, 'pending');
        assert.equal(plan.packages.find(item => item.kind === 'plugin').files[0].content, 'export default async () => ({});\n');
        assert.notEqual(plan.manifest, plan.packages.find(item => item.kind === 'skill').manifest);
    });
    await check('Потеря выбора зависимости запрещает одобрение; новый head не меняет сохранённую версию', async () => {
        assert.equal((await selection(pin(dependency), 'DELETE')).status, 200);
        const decision = { expectedManifest: plan.manifest, expectedRevision: plan.revision };
        assert.equal((await post('/api/device-install-plans/' + plan.id + '/approve', decision)).status, 403);
        assert.equal((await selection(pin(dependency))).status, 201);
        const changed = await request('/api/ai-plugins/' + dependency.plugin.id, { method: 'PATCH',
            body: { expectedVersion: 1, config: { transport: 'remote', url: 'https://example.test/mcp-v2' } } });
        assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(changed.data.version, 2);
        const approved = await post('/api/device-install-plans/' + plan.id + '/approve', decision);
        assert.equal(approved.status, 201); plan = approved.data;
        const frozen = plan.packages.find(item => item.id === dependency.plugin.id);
        assert.equal(frozen.version, 1); assert.equal(frozen.config.url, 'https://example.test/mcp-v1');
    });
    await check('Мост без install-set-v1 не получает даже одиночную установку нового формата владения', async () => {
        const pair = await channel('pair/start', { name: 'Проверка комплектов', fingerprint: 'd'.repeat(64), credentialHash: createHash('sha256').update(token).digest('hex') });
        assert.equal(pair.status, 201); assert.equal((await post('/api/device-pairs/' + pair.data.userCode + '/approve', {})).status, 201);
        deviceId = (await channel('pair/poll', { deviceCode: pair.data.deviceCode })).data.deviceId;
        assert.equal((await channel('heartbeat', { ...report, capabilities: report.capabilities.filter(value => value !== 'install-set-v1') })).status, 201);
        const single = await post('/api/device-install-plans', { projectId, assetKind: 'mcp', assetId: dependency.plugin.id, version: 1 });
        assert.equal(single.status, 201);
        const approved = await post('/api/device-install-plans/' + single.data.id + '/approve', { expectedManifest: single.data.manifest, expectedRevision: single.data.revision });
        assert.equal(approved.status, 201);
        const queued = await post('/api/device-jobs', { ...job(), assetKind: 'mcp', assetId: dependency.plugin.id,
            planId: approved.data.id, planRevision: approved.data.revision });
        assert.equal(queued.status, 409); assert.ok(queued.data.message.includes('Обновите'));
        assert.equal((await post('/api/device-jobs', job())).status, 409);
    });
    await check('HTTPS-очередь передаёт точный комплект и не принимает подменённую квитанцию', async () => {
        assert.equal((await channel('heartbeat', report)).status, 201);
        const queued = await post('/api/device-jobs', job()); assert.equal(queued.status, 201, JSON.stringify(queued.data));
        claimed = (await channel('jobs/claim')).data; assert.equal(claimed.id, queued.data.id);
        const set = claimed.payload.installSet; assert.equal(set.manifest, plan.manifest); assert.equal(set.packages.length, 3);
        const frozen = set.packages.find(item => item.plugin.id === dependency.plugin.id);
        assert.deepEqual(pin(frozen), pin(dependency)); assert.deepEqual(frozen.files, dependency.files); assert.deepEqual(frozen.config, dependency.config);
        assert.equal((await channel('jobs/' + claimed.id + '/authorize', { lease: claimed.lease })).status, 201);
        const result = { projectId, assetId: rootId, version: 1, manifest: set.manifest, bindingId, unchanged: true,
            packages: set.packages.map(pin).sort((a, b) => (a.kind + ':' + a.id) < (b.kind + ':' + b.id) ? -1 : 1) };
        const body = { lease: claimed.lease, state: 'failed', message: 'Проверка без записи файлов', result };
        for (const changed of [{ ...result, manifest: claimed.payload.package.manifest.sha256 }, { ...result, packages: result.packages.slice(1) }]) {
            assert.equal((await channel('jobs/' + claimed.id + '/complete', { ...body, result: changed })).status, 409);
        }
        assert.equal((await channel('jobs/' + claimed.id + '/complete', body)).status, 201);
        assert.equal((await channel('jobs/' + claimed.id + '/complete', body)).data.repeated, true);
    });
    await check('Отзыв одобрения всего комплекта проверяется перед записью и допускает честный отказ', async () => {
        assert.equal((await post('/api/device-jobs', job())).status, 201);
        claimed = (await channel('jobs/claim')).data;
        assert.equal((await post('/api/device-install-plans/' + plan.id + '/revoke', { expectedManifest: plan.manifest, expectedRevision: plan.revision })).status, 201);
        assert.equal((await channel('jobs/' + claimed.id + '/authorize', { lease: claimed.lease })).status, 409);
        const set = claimed.payload.installSet;
        const completed = await channel('jobs/' + claimed.id + '/complete', { lease: claimed.lease, state: 'failed', message: 'Комплект отозван до записи',
            result: { projectId, assetId: rootId, version: 1, manifest: set.manifest, bindingId, unchanged: true,
                packages: set.packages.map(pin).sort((a, b) => (a.kind + ':' + a.id) < (b.kind + ':' + b.id) ? -1 : 1) } });
        assert.equal(completed.status, 201, JSON.stringify(completed.data));
    });
}
