import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const { Pool } = require('pg');
const { InstallPlans } = require('../../services/catalog-service/dist/devices/install-plans.js');
const { setupInstallPlans } = require('../../services/catalog-service/dist/devices/install-plan-schema.js');
const { setupSecurityEvents } = require('../../services/catalog-service/dist/access/security-events.js');
const { buildPackage } = require('../../services/catalog-service/dist/catalog/bundle-package.js');
const url = process.env.INSTALLATION_TEST_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin = new Pool({ connectionString: url });
const database = 'nc_install_test_' + randomBytes(8).toString('hex');
const actor = { email: 'fixture@example.test', activeRole: 'Главный админ' };
const results = []; let pool; let created = false; let fatal = null;
async function check(name, action) { await action(); results.push(name); console.log('OK ' + name); }
const denied = (action, status = 409) => assert.rejects(action, error => error.status === status);
try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const target = new URL(url); target.pathname = '/' + database; pool = new Pool({ connectionString: target.href });
    await pool.query(`CREATE TABLE projects(id text PRIMARY KEY); INSERT INTO projects VALUES('prj-fixture'),('prj-foreign');
        CREATE TABLE project_assets(project_id text,asset_kind text,asset_id text);
        INSERT INTO project_assets VALUES('prj-fixture','skill','common/fixture');`);
    await setupInstallPlans(pool); await setupSecurityEvents(pool);
    const claims = async email => ({ email, userRoles: ['Главный админ','Админ проекта','Разработчик','Наблюдатель'],
        projects: [{ projectId: 'prj-fixture', role: 'Админ проекта' }], pluginIds: [], skillPaths: [] });
    let head = buildPackage({ id: 'common/fixture', name: 'fixture', kind: 'skill', version: 1 }, [{ path: 'SKILL.md', content: 'Исходная версия' }], '2026-01-01', { extra: { generation: 'first' } });
    let reads = 0;
    const plans = new InstallPlans({ pool, access: { claims } }, { build: async () => { reads++; return structuredClone(head); } });
    const input = { projectId: 'prj-fixture', assetKind: 'skill', assetId: 'common/fixture', version: 1 };
    let plan;
    const decision = item => ({ expectedManifest: item.manifest, expectedRevision: item.revision });
    const pinned = item => plans.package(item.id, input.projectId, input.assetKind, input.assetId, input.version, item.revision, item.manifest);
    await check('Миграция повторяется без неявного одобрения каталога', async () => {
        await setupInstallPlans(pool); assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_install_plans')).rows[0].n, 0);
        plan = await plans.prepare(actor, input); assert.equal(plan.status, 'pending'); assert.equal(plan.revision, 0); await denied(pinned(plan));
    });
    await check('Наблюдатель и админ чужого проекта не готовят план, разработчик не одобряет', async () => {
        await denied(plans.prepare({ ...actor, activeRole: 'Наблюдатель' }, input), 403);
        await denied(plans.prepare({ ...actor, activeRole: 'Админ проекта' }, { ...input, projectId: 'prj-foreign' }), 403);
        await denied(plans.decide({ ...actor, activeRole: 'Разработчик' }, plan.id, decision(plan), 'approved'), 403);
    });
    await check('Повтор подготовки сохраняет снимок и позволяет проверить исходный код', async () => {
        const repeated = await plans.prepare(actor, input); assert.equal(repeated.id, plan.id); assert.equal(repeated.files[0].content, 'Исходная версия');
        assert.equal(repeated.revision, 0); assert.equal(repeated.status, 'pending');
    });
    await check('Подмена ожидаемого хэша не одобряет пакет', async () => {
        await denied(plans.decide(actor, plan.id, { ...decision(plan), expectedManifest: 'f'.repeat(64) }, 'approved'));
        assert.equal((await pool.query('SELECT status FROM device_install_plans WHERE id=$1', [plan.id])).rows[0].status, 'pending');
    });
    await check('Отказ аудита откатывает одобрение той же транзакцией', async () => {
        await pool.query(`CREATE FUNCTION fixture_deny_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture-audit-failure'; END$$;
            CREATE TRIGGER fixture_deny_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fixture_deny_audit();`);
        try { await assert.rejects(plans.decide(actor, plan.id, decision(plan), 'approved'), /fixture-audit-failure/); }
        finally { await pool.query('DROP TRIGGER fixture_deny_audit ON security_events; DROP FUNCTION fixture_deny_audit();'); }
        assert.deepEqual((await pool.query('SELECT status,revision FROM device_install_plans WHERE id=$1', [plan.id])).rows[0], { status: 'pending', revision: 0 });
    });
    await check('Две вкладки с одной ревизией не теряют решение и событие аудита', async () => {
        const replies = await Promise.allSettled([1,2].map(() => plans.decide(actor, plan.id, decision(plan), 'approved')));
        assert.equal(replies.filter(row => row.status === 'fulfilled').length, 1);
        assert.equal(replies.find(row => row.status === 'rejected').reason.status, 409);
        plan = replies.find(row => row.status === 'fulfilled').value; assert.equal(plan.revision, 1);
        const events = (await pool.query('SELECT action,after_state FROM security_events')).rows;
        assert.equal(events.length, 1); assert.equal(events[0].action, 'installation.approved'); assert.equal(events[0].after_state.manifest, plan.manifest);
        assert.equal(JSON.stringify(events).includes('Исходная версия'), false);
    });
    await check('Одобрение другой версии или проекта не подходит для установки', async () => {
        await denied(plans.package(plan.id, 'prj-foreign', 'skill', input.assetId, 1, 1, plan.manifest));
        await denied(plans.package(plan.id, input.projectId, 'skill', input.assetId, 2, 1, plan.manifest));
    });
    await check('Удаление и пересоздание head не меняет одобренный снимок и требует нового решения', async () => {
        head = buildPackage(head.plugin, [{ path: 'SKILL.md', content: 'Новая публикация с тем же номером' }], '2026-01-02', { extra: { generation: 'second' } });
        const next = await plans.prepare(actor, input); assert.notEqual(next.id, plan.id); assert.notEqual(next.manifest, plan.manifest); assert.equal(next.status, 'pending');
        const before = reads; assert.equal((await pinned(plan)).files[0].content, 'Исходная версия'); assert.equal(reads, before); await denied(pinned(next));
    });
    await check('Отзыв и повторное одобрение не оживляют старую ревизию очереди', async () => {
        const revoked = await plans.decide(actor, plan.id, decision(plan), 'revoked'); assert.equal(revoked.revision, 2); await denied(pinned(plan));
        const approved = await plans.decide(actor, plan.id, decision(revoked), 'approved'); assert.equal(approved.revision, 3); await denied(pinned(plan));
        assert.equal((await pinned(approved)).manifest.sha256, plan.manifest); plan = approved;
    });
    await check('Удалённый из каталога инструмент нельзя одобрить повторно', async () => {
        await pool.query('DELETE FROM project_assets'); const revoked = await plans.decide(actor, plan.id, decision(plan), 'revoked');
        await denied(plans.decide(actor, plan.id, decision(revoked), 'approved'), 403);
    });
    await check('Повреждённый пакет в JSONB не проходит по сохранённому SHA', async () => {
        await pool.query("UPDATE device_install_plans SET package=jsonb_set(package,'{files,0,content}','\"Подмена\"') WHERE id=$1", [plan.id]);
        await denied(pinned(plan));
    });
    await check('Удаление проекта удаляет планы через внешний ключ', async () => {
        await pool.query('DELETE FROM projects WHERE id=$1', [input.projectId]); assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_install_plans')).rows[0].n, 0);
    });
} catch (error) { fatal = error.stack; process.exitCode = 1; console.error(error); }
finally {
    await pool?.end(); if (created) { await admin.query(`DROP DATABASE "${database}"`); } await admin.end();
    const report = process.env.INSTALL_PLAN_REPORT || root + '.run/install-approvals-20261017/plan-database.json';
    await fs.mkdir(path.dirname(report), { recursive: true });
    await fs.writeFile(report, JSON.stringify({ passed: results.length, cases: results, fatal, temporaryDatabaseRemoved: created }, null, 2));
}
