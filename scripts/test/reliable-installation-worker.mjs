import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { actor, createWorkerFixture, digest, evidence, legacyProjectId, projectId, snapshot, waitFor } from './reliable-installation-worker.fixture.mjs';

const results = [];
let fixture, fatal, cleanup;
const check = async (name, action) => {
    try { await action(); results.push({ case: name, ok: true }); console.log(name); }
    catch (error) { results.push({ case: name, ok: false, error: error.message }); throw error; }
};
try {
    fixture = await createWorkerFixture(); const f = fixture;
    let folder = f.folderA;
    const entry = () => path.join(folder, f.receipts.assetBase(f.pkg), 'index.mjs');
    const prepare = () => f.prepare();
    let approved, initialBinding, initialInstance;
    const updateApproval = async status => {
        const current = await f.plans.view(actor, approved.id);
        approved = await f.plans.decide(actor, current.id, { expectedManifest: current.manifest, expectedRevision: current.revision }, status);
    };
    const assertNoPrivateBeforeOnServer = async secret => {
        const rows = (await f.devices.pool.query('SELECT result,message FROM bridge_jobs ORDER BY created_at')).rows;
        const serialized = JSON.stringify(rows);
        assert.ok(!serialized.includes(secret) && !serialized.includes(Buffer.from(secret).toString('base64')), 'Ручное содержимое не должно попасть в результаты сервера');
    };
    const repair = async () => { const plan = await prepare(); return f.run(await f.apply(plan)); };

    await check('Source worker создает новый экземпляр папки и устанавливает точный одобренный пакет', async () => {
        await f.run(await f.initialBind(projectId, folder)); await f.heartbeat();
        initialBinding = await f.workspace.projectBindingId(projectId); initialInstance = await f.workspace.projectInstanceId(projectId);
        approved = await f.approved(projectId);
        await f.run(await f.create('install', { version: 1, planId: approved.id, planRevision: approved.revision }));
        assert.equal(await fs.readFile(entry(), 'utf8'), f.pkg.files[0].content);
        assert.equal((await f.inspectInstallation(projectId, f.pkg)).status, 'synced');
        const rows = (await f.installations.list(actor)).filter(row => row.projectId === projectId);
        assert.equal(rows.length, 1); assert.equal(rows[0].bindingId, initialBinding); assert.equal(rows[0].isCurrentBinding, true);
    });
    await check('Prepare сохраняет ручные байты только в приватном diff и не меняет файлы проекта', async () => {
        const dirty = '// РУЧНОЙ_СЕКРЕТ_ПЕРЕД_РЕМОНТОМ\n<script>не выполнять</script>\n';
        await fs.writeFile(entry(), dirty); const before = await snapshot(folder);
        const plan = await prepare(); assert.deepEqual(await snapshot(folder), before);
        assert.ok(plan.files.some(file => file.path.endsWith('/index.mjs') && file.beforeSha256 === digest(dirty)));
        const local = JSON.parse(await fs.readFile(path.join(f.stateModule.stateDir(), 'local-change-plans', plan.planId + '.json'), 'utf8'));
        const savedBefore = local.changes.find(change => change.relative.endsWith('/index.mjs'));
        assert.equal(Buffer.from(savedBefore.before, savedBefore.encoding ?? 'utf8').toString('utf8'), dirty);
        const html = await fs.readFile(path.join(f.stateModule.stateDir(), 'local-change-plans', plan.planId + '.html'), 'utf8');
        assert.ok(html.includes('&lt;script&gt;не выполнять&lt;/script&gt;')); assert.ok(!html.includes('<script>'));
        await assertNoPrivateBeforeOnServer(dirty);
        const completed = await f.run(await f.apply(plan));
        assert.equal(await fs.readFile(entry(), 'utf8'), f.pkg.files[0].content);
        const history = path.join(f.stateModule.stateDir(), 'file-changes', digest(folder), 'history');
        const journals = await Promise.all((await fs.readdir(history)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(history, name), 'utf8'))));
        const journal = journals.find(value => value.result?.changePlanId === plan.planId);
        assert.ok(journal, 'Резервная копия должна остаться в приватном журнале');
        const backedUp = journal.changes.find(change => change.relative.endsWith('/index.mjs'));
        assert.equal(Buffer.from(backedUp.before, backedUp.encoding ?? 'utf8').toString('utf8'), dirty);
        const dbPlan = (await f.devices.pool.query('SELECT applied_job_id FROM bridge_local_change_plans WHERE id=$1', [plan.planId])).rows[0];
        assert.equal(dbPlan.applied_job_id, completed.id);
        await assert.rejects(f.apply(plan), error => error.status === 409);
        await assertNoPrivateBeforeOnServer(dirty);
    });
    await check('Stale plan не затирает правку после preview и не отмечается примененным', async () => {
        await fs.writeFile(entry(), '// Первая ручная версия'); const plan = await prepare();
        await fs.writeFile(entry(), '// Вторая ручная версия после preview'); const before = await snapshot(folder);
        const completed = await f.run(await f.apply(plan), 'failed');
        assert.equal(completed.result.unchanged, true); assert.deepEqual(await snapshot(folder), before);
        assert.equal((await f.devices.pool.query('SELECT applied_job_id FROM bridge_local_change_plans WHERE id=$1', [plan.planId])).rows[0].applied_job_id, null);
        await repair();
    });
    await check('Missing MCP config восстанавливается с сохранением чужого значения и комментария', async () => {
        const receipt = JSON.parse(await fs.readFile(path.join(folder, f.receipts.receiptPath(f.pkg)), 'utf8'));
        const config = path.join(folder, receipt.config.path); const secret = 'ЧУЖОЙ_КЛЮЧ_ОСТАЕТСЯ_ЛОКАЛЬНО';
        const text = `{\n // ЛИЧНЫЙ_КОММЕНТАРИЙ\n "mcp": {},\n "privateValue": "${secret}"\n}\n`;
        await fs.writeFile(config, text); const plan = await prepare();
        assert.equal(await fs.readFile(config, 'utf8'), text);
        assert.ok(plan.files.some(file => file.path === receipt.config.path && file.beforeSha256 === digest(text)));
        await f.run(await f.apply(plan)); const updated = await fs.readFile(config, 'utf8');
        assert.ok(updated.includes('// ЛИЧНЫЙ_КОММЕНТАРИЙ')); assert.equal(f.parse(updated).privateValue, secret);
        assert.ok(f.parse(updated).mcp['neurocenter_' + f.receipts.assetKey(f.pkg)]);
        assert.equal((await f.inspectInstallation(projectId, f.pkg)).status, 'synced'); await assertNoPrivateBeforeOnServer(secret);
    });
    await check('Неверная binding и роль наблюдателя не создают repair задания', async () => {
        const before = (await f.devices.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count;
        await assert.rejects(f.create('prepare-local-change', { expectedBindingId: '0'.repeat(64) }), error => error.status === 409);
        await assert.rejects(f.jobs.create({ ...actor, activeRole: 'Наблюдатель' }, await f.request('prepare-local-change')), error => error.status === 403);
        assert.equal((await f.devices.pool.query('SELECT count(*)::int AS count FROM bridge_jobs')).rows[0].count, before);
    });
    await check('Смена binding на второй authorize блокирует apply до commit', async () => {
        await fs.writeFile(entry(), '// Правка перед сменой binding'); const plan = await prepare(); const job = await f.apply(plan); const before = await snapshot(folder);
        f.hooks.set(job.id, async count => {
            if (count !== 2) return;
            const report = await f.workspace.workspaceReport();
            await f.devices.heartbeat(await f.devices.identity(f.token), { ...report, bindings: report.bindings.map(binding => binding.projectId === projectId ? { ...binding, bindingId: '0'.repeat(64) } : binding) });
        });
        await f.run(job, 'failed'); f.hooks.delete(job.id); await f.heartbeat();
        assert.equal(f.authorizeCounts.get(job.id), 2); assert.deepEqual(await snapshot(folder), before); await repair();
    });
    await check('Отзыв approval на второй authorize сохраняет ручной вариант и не применяет план', async () => {
        await fs.writeFile(entry(), '// Правка перед отзывом approval'); const plan = await prepare(); const job = await f.apply(plan); const before = await snapshot(folder);
        f.hooks.set(job.id, async count => { if (count === 2) await updateApproval('revoked'); });
        await f.run(job, 'failed'); f.hooks.delete(job.id); assert.equal(f.authorizeCounts.get(job.id), 2); assert.deepEqual(await snapshot(folder), before);
        await updateApproval('approved'); await repair();
    });
    await check('Отозванный после enqueue approval отменяет выдачу prepare worker без локального diff', async () => {
        const job = await f.create('prepare-local-change'); await updateApproval('revoked'); const before = await snapshot(folder);
        const completed = await f.run(job, 'failed'); assert.equal(completed.result, null); assert.deepEqual(await snapshot(folder), before);
        await updateApproval('approved');
    });
    await check('Потеря apply completion ACK и рестарт доставляют прежнюю квитанцию без повторной записи', async () => {
        const dirty = '// Ручная версия для потерянного ACK'; await fs.writeFile(entry(), dirty); const plan = await prepare(); const job = await f.apply(plan);
        f.lostAcks.add(job.id); await f.run(job); assert.ok(f.committedAcks.has(job.id));
        assert.equal(await fs.readFile(entry(), 'utf8'), f.pkg.files[0].content);
        assert.ok((await f.pendingCompletions()).some(item => item.id === job.id)); const before = await snapshot(folder);
        f.lostAcks.delete(job.id); f.startWorker();
        try { await waitFor(async () => !(await f.pendingCompletions()).some(item => item.id === job.id), 'повторной доставки apply completion'); }
        finally { await f.stopWorker(); }
        assert.deepEqual(await snapshot(folder), before); assert.ok(f.completions.some(item => item.id === job.id && item.repeated));
        assert.equal((await f.devices.pool.query('SELECT applied_job_id FROM bridge_local_change_plans WHERE id=$1', [plan.planId])).rows[0].applied_job_id, job.id);
    });
    await check('Открытие приватного отчёта переживает потерю ACK без повторного opener и не блокирует следующее задание', async () => {
        const secret = 'ЛОКАЛЬНЫЙ_СЕКРЕТ_ОТЧЕТА_НЕ_ДЛЯ_СЕРВЕРА'; await fs.writeFile(entry(), '// ' + secret);
        const before = await snapshot(folder); const plan = await prepare();
        const job = await f.create('open-local-change-report', { changePlanId: plan.planId, changePlanRevision: plan.revision, expectedChangeDigest: plan.digest });
        f.lostAcks.add(job.id); const completed = await f.run(job); assert.ok(f.committedAcks.has(job.id));
        const expected = { projectId, bindingId: await f.workspace.projectBindingId(projectId), changePlanId: plan.planId, digest: plan.digest, opened: true };
        assert.deepEqual(completed.result, expected); assert.match(completed.message, /сравнение открыто/);
        const pending = (await f.pendingCompletions()).find(item => item.id === job.id);
        assert.ok(pending, 'Квитанция должна остаться на диске до подтверждения доставки'); assert.deepEqual(pending.result, expected);
        const html = path.join(f.stateModule.stateDir(), 'local-change-plans', plan.planId + '.html');
        assert.deepEqual(await f.openerInvocations(), [{ args: [html], sha256: digest(await fs.readFile(html)) }]);
        assert.ok(!JSON.stringify(completed.result).includes(f.temporary)); await assertNoPrivateBeforeOnServer(secret);
        f.lostAcks.delete(job.id); const next = await f.run(await f.create('inspect-installation'));
        assert.equal(next.result.status, 'modified'); assert.ok(!(await f.pendingCompletions()).some(item => item.id === job.id));
        assert.ok(f.completions.some(item => item.id === job.id && item.repeated)); assert.equal((await f.openerInvocations()).length, 1);
        assert.deepEqual(await snapshot(folder), before); await assertNoPrivateBeforeOnServer(secret);
        assert.equal((await f.devices.pool.query('SELECT applied_job_id FROM bridge_local_change_plans WHERE id=$1', [plan.planId])).rows[0].applied_job_id, null);
        await f.run(await f.apply(plan)); assert.equal((await f.inspectInstallation(projectId, f.pkg)).status, 'synced');
    });
    await check('Transfer после rename сохраняет instance, меняет binding и чинит абсолютное MCP подключение', async () => {
        const moved = path.join(f.parent, 'Папка после переноса'); await fs.rename(folder, moved); folder = moved; await f.heartbeat();
        const preview = await f.prepareBinding('transfer', moved, initialBinding, initialInstance); const job = await preview.create();
        f.lostAcks.add(job.id); const completed = await f.run(job); assert.ok(f.committedAcks.has(job.id));
        assert.equal(completed.result.instanceId, initialInstance); assert.notEqual(completed.result.bindingId, initialBinding);
        assert.equal(await f.workspace.projectInstanceId(projectId), initialInstance);
        assert.equal((await f.inspectInstallation(projectId, f.pkg)).status, 'synced');
        f.lostAcks.delete(job.id); f.startWorker();
        try { await waitFor(async () => !(await f.pendingCompletions()).some(item => item.id === job.id), 'повторной доставки transfer event'); }
        finally { await f.stopWorker(); }
        await f.heartbeat();
        const events = (await f.devices.pool.query('SELECT * FROM bridge_instance_events WHERE id=$1', [job.id])).rows;
        assert.equal(events.length, 1); assert.equal(events[0].event, 'transfer'); assert.equal(events[0].previous_binding_id, initialBinding);
        const rows = (await f.installations.list(actor)).filter(row => row.projectId === projectId);
        assert.equal(rows.find(row => row.bindingId === initialBinding).isCurrentBinding, false);
        assert.equal(rows.find(row => row.bindingId === completed.result.bindingId).isCurrentBinding, true);
        assert.equal(rows.find(row => row.bindingId === completed.result.bindingId).folderName, path.basename(moved));
    });
    await check('Возврат А → Б → А через resume сохраняет экземпляр А и не оживляет прежнюю очередь', async () => {
        const historicalBinding = await f.workspace.projectBindingId(projectId);
        const historicalInstance = await f.workspace.projectInstanceId(projectId);
        const beforeEntry = await fs.stat(entry()); const beforeBytes = await fs.readFile(entry());
        const oldQueued = await f.create('install', { version: 1, planId: approved.id, planRevision: approved.revision });
        const folderB = path.join(f.parent, 'Новая папка Б'); await fs.mkdir(folderB);
        await f.run(await f.initialBind(projectId, folderB)); await f.heartbeat();
        assert.equal((await f.state(oldQueued.id)).state, 'cancelled');
        const bindingB = await f.workspace.projectBindingId(projectId); assert.notEqual(bindingB, historicalBinding);
        assert.notEqual(await f.workspace.projectInstanceId(projectId), historicalInstance);
        await f.run(await f.create('install', { version: 1, planId: approved.id, planRevision: approved.revision }));
        const preview = await f.prepareBinding('resume', folder, undefined, undefined);
        assert.equal(preview.prepared.previousBindingId, historicalBinding); assert.equal(preview.prepared.instanceId, historicalInstance);
        const resumed = await f.run(await preview.create()); await f.heartbeat();
        assert.equal(resumed.result.instanceId, historicalInstance); assert.equal(resumed.result.previousBindingId, historicalBinding);
        assert.notEqual(resumed.result.bindingId, historicalBinding); assert.notEqual(resumed.result.bindingId, bindingB);
        assert.equal(await f.workspace.projectInstanceId(projectId), historicalInstance);
        assert.equal((await f.inspectInstallation(projectId, f.pkg)).status, 'synced');
        assert.deepEqual(await fs.readFile(entry()), beforeBytes); assert.equal((await fs.stat(entry())).mtimeMs, beforeEntry.mtimeMs);
        assert.equal((await f.state(oldQueued.id)).state, 'cancelled');
        await assert.rejects(f.create('install', { version: 1, planId: approved.id, planRevision: approved.revision, expectedBindingId: historicalBinding }), error => error.status === 409);
        const event = (await f.devices.pool.query('SELECT * FROM bridge_instance_events WHERE id=$1', [resumed.id])).rows[0];
        assert.equal(event.event, 'resume'); assert.equal(event.previous_binding_id, historicalBinding); assert.equal(event.instance_id, historicalInstance);
        const rows = (await f.installations.list(actor)).filter(row => row.projectId === projectId);
        assert.equal(rows.filter(row => row.isCurrentBinding).length, 1);
        assert.equal(rows.find(row => row.bindingId === resumed.result.bindingId).isCurrentBinding, true);
        assert.equal(rows.find(row => row.bindingId === bindingB).isCurrentBinding, false);
        assert.equal(rows.find(row => row.bindingId === historicalBinding).isCurrentBinding, false);
    });
    await check('Legacy marker требует явного adopt; неизвестная receipt сохраняется и блокирует commit', async () => {
        await f.run(await f.initialBind(legacyProjectId, f.legacyFolder)); await f.heartbeat();
        const legacyApproval = await f.approved(legacyProjectId);
        const installed = await f.run(await f.create('install', { version: 1, planId: legacyApproval.id, planRevision: legacyApproval.revision }, legacyProjectId));
        const legacyBinding = digest(JSON.stringify([f.origin, legacyProjectId, f.legacyFolder]));
        await f.devices.pool.query(`UPDATE bridge_jobs SET payload=jsonb_set(payload,'{bindingId}',to_jsonb($2::text)),result=jsonb_set(result,'{bindingId}',to_jsonb($2::text)) WHERE id=$1`, [installed.id, legacyBinding]);
        const marker = path.join(f.legacyFolder, '.opencode/neurocenter.json');
        const markerBytes = JSON.stringify({ version: 1, server: f.origin, projectId: legacyProjectId }); await fs.writeFile(marker, markerBytes); await f.heartbeat();
        await assert.rejects(f.create('prepare-local-change', { expectedBindingId: legacyBinding }, legacyProjectId), error => error.status === 409);
        const foreign = path.join(f.legacyFolder, '.opencode/neurocenter/receipts', 'f'.repeat(24) + '.json'); await fs.writeFile(foreign, '{"private":"Не трогать"}');
        const preview = await f.prepareBinding('adopt-legacy', f.legacyFolder, legacyBinding, undefined, legacyProjectId);
        await f.run(await preview.create(), 'failed'); assert.equal(await fs.readFile(marker, 'utf8'), markerBytes); assert.equal(await fs.readFile(foreign, 'utf8'), '{"private":"Не трогать"}');
        await fs.unlink(foreign);
        const fresh = await f.prepareBinding('adopt-legacy', f.legacyFolder, legacyBinding, undefined, legacyProjectId);
        const adopted = await f.run(await fresh.create()); await f.heartbeat();
        assert.notEqual(adopted.result.bindingId, legacyBinding); assert.equal((await f.inspectInstallation(legacyProjectId, f.pkg)).status, 'synced');
        const event = (await f.devices.pool.query('SELECT * FROM bridge_instance_events WHERE id=$1', [adopted.id])).rows[0];
        assert.equal(event.event, 'adopt-legacy'); assert.equal(event.previous_binding_id, legacyBinding); assert.equal(event.installations.length, 1);
        const rows = (await f.installations.list(actor)).filter(row => row.projectId === legacyProjectId);
        assert.equal(rows.find(row => row.bindingId === adopted.result.bindingId).isCurrentBinding, true);
        assert.equal(rows.find(row => row.bindingId === legacyBinding).isCurrentBinding, false);
    });
    await check('Runtime без bundle metadata честно unsupported; отсутствие explicit consent не создает job', async () => {
        await assert.rejects(f.create('probe-runtime', { consentManifest: '0'.repeat(64) }), error => error.status === 400);
        const completed = await f.run(await f.create('probe-runtime', { consentManifest: f.pkg.manifest.sha256 }));
        assert.equal(completed.result.status, 'unsupported'); assert.equal(completed.result.code, 'runtime-mismatch'); assert.equal(completed.result.engineSha256, '');
        const row = (await f.installations.list(actor)).find(item => item.projectId === projectId && item.isCurrentBinding);
        assert.equal(row.runtime.status, 'unsupported');
    });
} catch (error) { fatal = error.stack || String(error); cleanup = error.cleanup; console.error(fatal); process.exitCode = 1; }
finally {
    if (fixture) cleanup = await fixture.close();
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'worker.json'), JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), nodeVersion: process.version,
        harnessSha256: digest(await fs.readFile(new URL(import.meta.url))), workerMode: 'source-tsx', results, fatal: fatal ?? null, cleanup: cleanup ?? null,
        realDeviceCommandsCreated: false, realProfileChanged: false, nativePickerCalled: false, operatingSystemReportOpened: false }, null, 2) + '\n');
    if (!cleanup || Object.values(cleanup).some(value => value !== true)) process.exitCode = 1;
}
