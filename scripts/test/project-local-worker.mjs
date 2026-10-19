import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
process.env.RELIABLE_INSTALLATION_EVIDENCE_DIR ||= path.join(repository, '.run/installation-inventory-20261018');
const { actor, createWorkerFixture, digest, evidence, projectId, snapshot } = await import('./reliable-installation-worker.fixture.mjs');
const results = []; let fixture, fatal, cleanup;
const check = async (name, action) => {
    try { await action(); results.push({ case: name, ok: true }); console.log(name); }
    catch (error) { results.push({ case: name, ok: false, error: error.message }); throw error; }
};
const summaryInput = summary => ({ changePlanId: summary.planId, changePlanRevision: summary.revision, expectedChangeDigest: summary.digest });
try {
    fixture = await createWorkerFixture(); const f = fixture; const folder = f.folderA;
    const entry = () => path.join(folder, f.receipts.assetBase(f.pkg), 'index.mjs');
    const countJobs = async () => (await f.devices.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count;
    const noSecrets = async (...secrets) => {
        const jobs = (await f.devices.pool.query('SELECT payload,result,message FROM bridge_jobs')).rows;
        const summaries = (await f.devices.pool.query('SELECT summary FROM bridge_local_change_plans')).rows;
        for (const secret of secrets) { assert.ok(!JSON.stringify({ jobs, summaries }).includes(secret), 'Локальные данные не должны попасть на сервер'); }
    };
    const scan = async (role = actor) => {
        const job = await f.jobs.create(role, await f.request('scan-project-inventory'));
        return { job, result: (await f.run(job)).result };
    };
    let approval, inventory, candidate, adopt, adoptedJob, backupId, restore;
    const adoptionInput = () => ({ version: 1, planId: approval.id, planRevision: approval.revision,
        inventoryJobId: inventory.job.id, scanId: inventory.result.scanId, candidateId: candidate.candidateId, expectedInventoryDigest: inventory.result.digest });
    const prepareAdoption = async () => {
        inventory = await scan(); candidate = inventory.result.entries.find(row => row.path === f.receipts.assetBase(f.pkg)); assert.equal(candidate.state, 'unmanaged');
        return (await f.run(await f.create('prepare-adopt-installation', adoptionInput()))).result;
    };
    const applyAdoption = summary => f.create('apply-adopt-installation', summaryInput(summary));
    const variants = async (role = actor) => (await f.run(await f.jobs.create(role, await f.request('list-local-variants')))).result;
    const restorePreview = async recoveryId => (await f.run(await f.create('prepare-local-restore', { recoveryId }))).result;
    await check('Изолированный worker связывает проект; canonical файлы заранее существуют без install задания сервера', async () => {
        await f.run(await f.initialBind(projectId, folder)); await f.heartbeat(); approval = await f.approved(projectId);
        const { install } = await import(pathToFileURL(path.join(repository, 'mcp/neurocenter-asset-sync/src/bridge/installer.ts')).href);
        await install(projectId, f.pkg, async () => undefined, async () => undefined);
        // Только собственная фикстура: моделируем ручную canonical установку без доверенных metadata.
        await fs.unlink(path.join(folder, f.receipts.receiptPath(f.pkg))); await fs.unlink(path.join(folder, '.opencode/neurocenter/installations.json'));
        assert.equal((await f.devices.pool.query("SELECT count(*)::int AS count FROM bridge_jobs WHERE kind='install'")).rows[0].count, 0);
        assert.equal((await f.installations.list(actor)).filter(row => row.projectId === projectId).length, 0);
    });
    await check('Наблюдатель получает project inventory без команд, содержимого и абсолютных путей', async () => {
        const before = await snapshot(folder); inventory = await scan({ ...actor, activeRole: 'Наблюдатель' }); candidate = inventory.result.entries.find(row => row.path === f.receipts.assetBase(f.pkg));
        assert.equal(inventory.result.complete, true); assert.equal(candidate.state, 'unmanaged'); assert.equal(candidate.kind, 'mcp');
        assert.ok(!JSON.stringify(inventory.result).includes(folder)); assert.ok(!JSON.stringify(inventory.result).includes(f.pkg.files[0].content));
        assert.ok(!JSON.stringify(inventory.result).includes(process.execPath)); assert.deepEqual(await snapshot(folder), before);
    });
    await check('Чужая binding, digest и candidate не попадают в очередь принятия', async () => {
        const before = await countJobs();
        for (const extra of [{ expectedBindingId: '0'.repeat(64) }, { expectedInventoryDigest: '0'.repeat(64) }, { candidateId: '11111111-1111-4111-8111-111111111111' }]) {
            await assert.rejects(f.create('prepare-adopt-installation', { ...adoptionInput(), ...extra }), error => error.status === 409);
        }
        assert.equal(await countJobs(), before);
    });
    await check('Наблюдатель не может подготовить принятие или восстановление', async () => {
        const before = await countJobs();
        for (const kind of ['prepare-adopt-installation', 'prepare-local-restore', 'apply-adopt-installation', 'apply-local-restore']) {
            await assert.rejects(f.jobs.create({ ...actor, activeRole: 'Наблюдатель' }, await f.request(kind, adoptionInput())), error => error.status === 403);
        }
        assert.equal(await countJobs(), before);
    });
    await check('Одобренный точный пакет создаёт отдельный adopt plan без изменения исходников и config', async () => {
        const before = await snapshot(folder); adopt = (await f.run(await f.create('prepare-adopt-installation', adoptionInput()))).result;
        assert.deepEqual(await snapshot(folder), before); assert.equal(adopt.manifest, f.pkg.manifest.sha256);
        assert.ok(adopt.files.length > 0); assert.ok(adopt.files.every(file => file.path.startsWith('.opencode/neurocenter/')));
        const row = (await f.devices.pool.query('SELECT purpose,summary FROM bridge_local_change_plans WHERE id=$1', [adopt.planId])).rows[0];
        assert.equal(row.purpose, 'adopt'); assert.deepEqual(row.summary, adopt);
    });
    await check('Назначение плана нельзя поменять на repair или restore endpoint', async () => {
        const before = await countJobs();
        for (const kind of ['apply-local-change', 'apply-local-restore']) { await assert.rejects(f.create(kind, summaryInput(adopt)), error => error.status === 409); }
        assert.equal(await countJobs(), before);
    });
    await check('Изменение после adopt preview сохраняется; CAS не создаёт квитанцию и не отмечает план применённым', async () => {
        const dirty = '// ПРАВКА_ПОСЛЕ_ADOPT_PREVIEW'; await fs.writeFile(entry(), dirty); const before = await snapshot(folder);
        const job = await f.run(await applyAdoption(adopt), 'failed'); assert.equal(job.result.unchanged, true); assert.deepEqual(await snapshot(folder), before);
        await assert.rejects(fs.access(path.join(folder, f.receipts.receiptPath(f.pkg))));
        assert.equal((await f.devices.pool.query('SELECT applied_job_id FROM bridge_local_change_plans WHERE id=$1', [adopt.planId])).rows[0].applied_job_id, null);
        await noSecrets(dirty); await fs.writeFile(entry(), f.pkg.files[0].content);
    });
    await check('Повторный scan и отдельное apply принимают metadata; потерянный ACK не отменяет серверную запись', async () => {
        adopt = await prepareAdoption(); const before = await snapshot(folder); const configBefore = Object.fromEntries(Object.entries(before).filter(([name]) => name === 'opencode.json' || name.endsWith('index.mjs')));
        adoptedJob = await applyAdoption(adopt); f.lostAcks.add(adoptedJob.id); const completed = await f.run(adoptedJob);
        assert.equal(completed.result.changePlanId, adopt.planId); assert.equal(completed.result.readiness, 'unverified'); assert.ok(f.committedAcks.has(adoptedJob.id));
        const after = await snapshot(folder); for (const [name, value] of Object.entries(configBefore)) { assert.deepEqual(after[name], value); }
        assert.ok((await f.pendingCompletions()).some(row => row.id === adoptedJob.id));
        const rows = (await f.installations.list(actor)).filter(row => row.projectId === projectId); assert.equal(rows.length, 1); assert.equal(rows[0].isCurrentBinding, true);
        assert.equal(rows[0].manifest, f.pkg.manifest.sha256);
        const stored = await f.state(adoptedJob.id); assert.equal(stored.payload.package.manifest.sha256, f.pkg.manifest.sha256);
    });
    await check('Рестарт доставляет прежний ACK без записи файлов и выполняет следующее inspection задание', async () => {
        const before = await snapshot(folder); f.lostAcks.delete(adoptedJob.id); const inspected = await f.run(await f.create('inspect-installation'));
        assert.equal(inspected.result.status, 'synced'); assert.ok(!(await f.pendingCompletions()).some(row => row.id === adoptedJob.id));
        assert.ok(f.completions.some(row => row.id === adoptedJob.id && row.repeated)); assert.deepEqual(await snapshot(folder), before);
        await assert.rejects(applyAdoption(adopt), error => error.status === 409);
    });
    const manual = '// РУЧНОЙ_ВАРИАНТ_ДЛЯ_ВОЗВРАТА\nexport default { local: true };\n';
    await check('Обычный repair сохраняет ручной вариант только в приватном recovery journal', async () => {
        await fs.writeFile(entry(), manual); const before = await snapshot(folder); const plan = await f.prepare(); assert.deepEqual(await snapshot(folder), before);
        await f.run(await f.apply(plan)); assert.equal(await fs.readFile(entry(), 'utf8'), f.pkg.files[0].content);
        const history = path.join(f.stateModule.stateDir(), 'file-changes', digest(folder), 'history');
        for (const name of await fs.readdir(history)) {
            const value = JSON.parse(await fs.readFile(path.join(history, name), 'utf8'));
            if (value.result?.changePlanId === plan.planId) { backupId = value.id; const change = value.changes.find(row => row.relative.endsWith('index.mjs')); assert.equal(Buffer.from(change.before, change.encoding ?? 'utf8').toString(), manual); }
        }
        assert.ok(backupId); await noSecrets(manual);
    });
    await check('Наблюдатель видит ограниченный список вариантов, включая подходящий backup, без его текста', async () => {
        const before = await snapshot(folder); const listed = await variants({ ...actor, activeRole: 'Наблюдатель' });
        assert.equal(listed.complete, true); assert.ok(listed.entries.some(row => row.recoveryId === backupId && row.eligible));
        assert.ok(!JSON.stringify(listed).includes(manual)); assert.ok(!JSON.stringify(listed).includes(folder)); assert.deepEqual(await snapshot(folder), before);
    });
    await check('Restore preview фиксирует возвращаемые хэши без применения и не работает через repair endpoint', async () => {
        const before = await snapshot(folder); restore = await restorePreview(backupId); assert.deepEqual(await snapshot(folder), before);
        assert.ok(restore.files.some(row => row.path.endsWith('index.mjs') && row.afterSha256 === digest(manual)));
        assert.equal((await f.devices.pool.query('SELECT purpose FROM bridge_local_change_plans WHERE id=$1', [restore.planId])).rows[0].purpose, 'restore-local');
        await assert.rejects(f.create('apply-local-change', summaryInput(restore)), error => error.status === 409);
        await assert.rejects(f.create('apply-adopt-installation', summaryInput(restore)), error => error.status === 409); await noSecrets(manual);
    });
    await check('Отдельное apply restore возвращает ручные байты, сохраняя квитанцию одобренного пакета', async () => {
        const receipt = path.join(folder, f.receipts.receiptPath(f.pkg)); const before = await fs.readFile(receipt); const stat = await fs.stat(receipt);
        const completed = await f.run(await f.create('apply-local-restore', summaryInput(restore)));
        assert.equal(completed.result.readiness, 'unverified'); assert.equal(completed.result.changePlanId, restore.planId);
        assert.equal(await fs.readFile(entry(), 'utf8'), manual); assert.deepEqual(await fs.readFile(receipt), before); assert.equal((await fs.stat(receipt)).mtimeMs, stat.mtimeMs); await noSecrets(manual);
    });
    await check('Inspection после возврата честно сообщает modified и не заявляет готовность к запуску', async () => {
        const inspected = await f.run(await f.create('inspect-installation')); assert.equal(inspected.result.status, 'modified'); assert.equal(inspected.result.readiness, 'unverified');
        const rows = (await f.installations.list(actor)).filter(row => row.projectId === projectId); assert.equal(rows.length, 1); assert.equal(rows[0].inspection.status, 'modified');
    });
    await check('CAS restore сохраняет новую правку после preview и оставляет план неприменённым', async () => {
        // Сначала снова восстанавливаем одобренный пакет, чтобы возврат выбранного backup был реальным diff.
        await f.run(await f.apply(await f.prepare())); const plan = await restorePreview(backupId);
        const later = '// НОВАЯ_ПРАВКА_ПОСЛЕ_RESTORE_PREVIEW'; await fs.writeFile(entry(), later); const before = await snapshot(folder);
        const completed = await f.run(await f.create('apply-local-restore', summaryInput(plan)), 'failed'); assert.equal(completed.result.unchanged, true); assert.deepEqual(await snapshot(folder), before);
        assert.equal((await f.devices.pool.query('SELECT applied_job_id FROM bridge_local_change_plans WHERE id=$1', [plan.planId])).rows[0].applied_job_id, null); await noSecrets(later);
    });
    await check('Отзыв approval до claim запрещает запись локального варианта', async () => {
        await f.run(await f.apply(await f.prepare())); const plan = await restorePreview(backupId); const job = await f.create('apply-local-restore', summaryInput(plan));
        const before = await snapshot(folder); await f.devices.pool.query("UPDATE device_install_plans SET status='revoked' WHERE id=$1", [approval.id]);
        await f.run(job, 'failed'); assert.deepEqual(await snapshot(folder), before);
        assert.equal((await f.devices.pool.query('SELECT applied_job_id FROM bridge_local_change_plans WHERE id=$1', [plan.planId])).rows[0].applied_job_id, null);
    });

    await check('После binding event без payload.installSet выбирается точный граф из2 пакетов среди19 unrelated', async () => {
        const { buildPackage } = await import(pathToFileURL(path.join(repository, 'services/catalog-service/dist/catalog/bundle-package.js')).href);
        const { installationRef, installationSetHash, verifyInstallationSet } = await import(pathToFileURL(path.join(repository, 'services/catalog-service/dist/devices/installation-set.js')).href);
        const dep = buildPackage({ kind: 'plugin', id: 'ai-plug-graph-event-dependency', name: 'graph-event-dependency', version: 1 },
            [{ path: 'index.mjs', content: 'export default {}; // dependency frozen' }], 'now', { entrypoint: 'index.mjs' });
        const root = buildPackage({ kind: 'mcp', id: 'ai-plug-graph-event-root', name: 'graph-event-root', version: 1 },
            [{ path: 'index.mjs', content: 'export default {}; // root frozen' }], 'now', { transport: 'stdio', command: 'node', entrypoint: 'index.mjs',
                extra: { requirements: { dependencies: [installationRef(dep)] } } });
        const unrelated = Array.from({ length: 19 }, (_, index) => buildPackage({ kind: 'skill', id: 'ai-plug-unrelated-' + index, name: 'unrelated-' + index, version: 1 },
            [{ path: 'SKILL.md', content: 'Независимый инструмент ' + index }], 'now'));
        const jobId = randomUUID(); const bindingId = await f.workspace.projectBindingId(projectId); const instanceId = await f.workspace.projectInstanceId(projectId);
        // Собственные SQL fixtures моделируют сохранённый event переноса; пакетные данные не берутся из каталога/head.
        await f.devices.pool.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,percent,started_at,result)
            VALUES($1,$2,$3,$4,$5,'bind-project',$6,$7,$8,'succeeded',100,now(),'{}')`,
        [jobId, f.deviceId, actor.email, actor.activeRole, projectId, { bindingId, mode: 'transfer' }, randomUUID(), digest(jobId)]);
        await f.devices.pool.query(`INSERT INTO bridge_instance_events(id,device_id,project_id,email,event,instance_id,binding_id,previous_binding_id,installations)
            VALUES($1,$2,$3,$4,'transfer',$5,$6,$6,$7)`, [jobId, f.deviceId, projectId, actor.email, instanceId, bindingId, JSON.stringify([root, dep, ...unrelated])]);
        assert.equal((await f.state(jobId)).payload.installSet, undefined);
        const delivered = await f.installations.inspectionDelivery(actor, { deviceId: f.deviceId, projectId, bindingId,
            assetKind: root.plugin.kind, assetId: root.plugin.id, expectedManifest: root.manifest.sha256 });
        assert.equal(delivered.package.manifest.sha256, root.manifest.sha256); assert.equal(delivered.installSet.packages.length, 2);
        assert.equal(delivered.installSet.manifest, installationSetHash(installationRef(root), [root, dep])); assert.equal(verifyInstallationSet(delivered.installSet), true);
        assert.deepEqual(delivered.installSet.packages.map(pkg => pkg.plugin.id).sort(), [root.plugin.id, dep.plugin.id].sort());
    });

} catch (error) { fatal = error.message; if (!fixture && error.cleanup) cleanup = error.cleanup; console.error(error.stack); }
finally { if (fixture) cleanup = await fixture.close(); }
const report = { checkedAt: new Date().toISOString(), database: fixture?.database, tests: results, fatal: fatal ?? null, cleanup,
    realProfileChanged: false, nativeFilePickerUsed: false, runtimeCodeExecuted: false };
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(process.env.PROJECT_LOCAL_WORKER_REPORT || path.join(evidence, 'project-local-worker.json'), JSON.stringify(report, null, 2) + '\n');
if (fatal || results.some(row => !row.ok) || !cleanup?.ownDatabaseDropped || !cleanup?.originalDatabasesPreserved || !cleanup?.originalCatalogDataPreserved) process.exitCode = 1;
