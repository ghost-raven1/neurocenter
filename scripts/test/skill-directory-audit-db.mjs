import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const { Pool } = require('pg');
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogDist = process.env.PUBLICATION_TEST_DIST || path.join(root, 'services/catalog-service/dist');
const skillsDist = process.env.SKILLS_TEST_DIST || path.join(root, 'services/skills-service/dist');
const { SkillAuditRepository } = require(path.join(catalogDist, 'publication/skill-audit-repository.js'));
const { ensureCatalogSchema } = require(path.join(catalogDist, 'database/catalog-schema.js'));
const { FsSkillsStorage } = require(path.join(skillsDist, 'storage/fs-skills-storage.js'));
const { SkillsService } = require(path.join(skillsDist, 'skills/skills.service.js'));
const { SkillsController } = require(path.join(skillsDist, 'skills/skills.controller.js'));
const { deliverSkillAudit } = require(path.join(skillsDist, 'storage/skill-audit.js'));
const reportPath = process.env.SKILL_DIRECTORY_AUDIT_REPORT || path.join(root, 'output/continuation-20261018/folder-audit/postgres.json');
const directory = await mkdtemp(path.join(tmpdir(), 'nc-directory-audit-'));
const database = 'nc_directory_test_' + randomBytes(8).toString('hex');
const adminUrl = process.env.PUBLICATION_TEST_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const token = randomBytes(24).toString('hex'), actor = 'folder-qa@localhost';
const stores = [], scenarios = [], deliveries = [];
let pool, server, created = false, dropped = false, failure, mode = 'normal';
process.env.NODE_ENV = 'production';
process.env.NEUROCENTER_INTERNAL_TOKEN = token;
const newStorage = async storageRoot => {
    const storage = new FsSkillsStorage(storageRoot, undefined, deliverSkillAudit);
    stores.push(storage); await storage.init(); await storage.onModuleDestroy(); return storage;
};
const count = async resource => Number((await pool.query('SELECT count(*)::int n FROM security_events WHERE resource_id=$1', [resource])).rows[0].n);
const journals = async storageRoot => readdir(path.join(storageRoot, '.neurocenter-sync-journal')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const trustedRequest = { headers: { 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: actor })) } };

/** Прерывается только собственный процесс после настоящего mkdir или commit, до ответа клиенту. */
async function killAt(storageRoot, stage) {
    const code = `const fs=require('node:fs/promises'),path=require('node:path'),cfg=JSON.parse(process.argv[1]);
        const {FsSkillsStorage}=require(path.join(cfg.dist,'storage/fs-skills-storage.js'));
        const wait=()=>new Promise(()=>{});
        if(cfg.stage==='prepared'){const mkdir=fs.mkdir.bind(fs);fs.mkdir=async(file,...args)=>{
            const result=await mkdir(file,...args);if(String(file).endsWith('/common/kill-prepared')){process.send({stage:'prepared'});await wait();}return result;};}
        (async()=>{const store=new FsSkillsStorage(cfg.root,undefined,async()=>{process.send({stage:'committed'});await wait();});
            await store.init();await store.makeDirectory('common/kill-'+cfg.stage+'/child',{actor:cfg.actor,source:'editor'});
        })().catch(error=>{process.send({error:error.message});process.exit(1);});`;
    const child = spawn(process.execPath, ['-e', code, JSON.stringify({ dist: skillsDist, root: storageRoot, stage, actor })],
        { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let timer;
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Не достигнута граница mkdir/commit')), 10000);
            child.once('error', reject); child.once('exit', () => reject(new Error('Процесс вышел до границы')));
            child.on('message', message => message.stage === stage ? resolve() : reject(new Error(message.error || 'Неверная стадия')));
        });
        assert.equal(child.kill('SIGKILL'), true);
        assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
}

try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const url = new URL(adminUrl); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 4 });
    await ensureCatalogSchema(pool);
    const repository = new SkillAuditRepository(pool);
    server = createServer(async (req, res) => {
        const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
        try {
            if (req.headers['x-neurocenter-internal'] !== token) { send(403, {}); return; }
            if (req.method !== 'POST' || req.url !== '/internal/skill-audit/events') { send(404, {}); return; }
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString()); deliveries.push(body.events);
            if (mode === 'unavailable') { send(503, {}); return; }
            const result = await repository.record(body);
            if (mode === 'lost-ack') { mode = 'normal'; req.socket.destroy(); return; }
            send(201, result);
        } catch (error) { send(error.getStatus?.() || 500, { message: error.message }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    process.env.CATALOG_SERVICE_URL = 'http://127.0.0.1:' + server.address().port;
    const storage = await newStorage(directory), service = new SkillsService(storage), controller = new SkillsController(service);
    const requested = 'common/team/tools';
    const result = await controller.createDirectory({ path: requested, actor: 'spoofed@example.test' }, trustedRequest);
    assert.equal(result.path, requested); assert.equal(result.audit, undefined);
    assert.equal((await stat(path.join(directory, requested))).isDirectory(), true);
    const rows = (await pool.query('SELECT * FROM security_events WHERE resource_id=$1', [requested])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].actor, actor); assert.equal(rows[0].action, 'skill.directory.create');
    assert.equal(rows[0].before_state, null); assert.deepEqual(rows[0].after_state, { directory: true, source: 'editor' });
    assert.equal(await count('common/team'), 0);
    scenarios.push('Controller/service/FS и настоящий HTTP/SQL: одно событие на запрошенный путь, доверенный actor, без версий и текста');

    await Promise.all(Array.from({ length: 4 }, () => controller.createDirectory({ path: requested }, trustedRequest)));
    assert.equal(await count(requested), 1); assert.deepEqual(await journals(directory), []);
    scenarios.push('Повтор и конкурентные mkdir существующей папки не добавляют события');

    mode = 'unavailable';
    const pendingPath = 'common/pending';
    const pending = await service.createDirectory(pendingPath, actor);
    assert.deepEqual(pending.audit, { state: 'pending' }); assert.equal(await count(pendingPath), 0);
    assert.equal((await stat(path.join(directory, pendingPath))).isDirectory(), true);
    assert.deepEqual((await service.createDirectory(pendingPath, actor)).audit, { state: 'pending' });
    assert.equal((await journals(directory)).filter(name => name.endsWith('.json')).length, 1);
    mode = 'normal'; await storage.flushSkillAudit();
    assert.equal(await count(pendingPath), 1); assert.equal(await storage.pendingAudit(pendingPath), false);
    scenarios.push('Отказ каталога возвращает saved+pending; повтор не дублирует mkdir, flush подтверждает исходный UUID');

    mode = 'lost-ack'; const lostPath = 'common/lost-ack';
    assert.deepEqual((await service.createDirectory(lostPath, actor)).audit, { state: 'pending' });
    assert.equal(await count(lostPath), 1); await storage.flushSkillAudit(); assert.equal(await count(lostPath), 1);
    const repeated = deliveries.flat().filter(event => event.resourceId === lostPath);
    assert.equal(repeated.length, 2); assert.equal(repeated[0].id, repeated[1].id);
    scenarios.push('SQL COMMIT и потеря HTTP ACK дают ровно одну запись после повтора');

    const beforeInvalid = Number((await pool.query('SELECT count(*)::int n FROM security_events')).rows[0].n);
    for (const input of [null, {}, { path: '../outside' }, { path: 'common/Invalid' }]) {
        await assert.rejects(async () => controller.createDirectory(input, trustedRequest), error => error.status === 400);
    }
    assert.equal(Number((await pool.query('SELECT count(*)::int n FROM security_events')).rows[0].n), beforeInvalid);
    scenarios.push('Некорректное тело и путь отклоняются до файловой записи и аудита');

    await controller.createDirectory({ path: 'common/service-actor', actor }, { headers: { 'x-bridge-actor': 'malformed' } });
    assert.equal((await pool.query('SELECT actor FROM security_events WHERE resource_id=$1', ['common/service-actor'])).rows[0].actor, 'skills-service');
    scenarios.push('Поле actor в теле не заменяет проверенный служебный заголовок');

    const accepted = deliveries.flat().find(event => event.resourceId === requested);
    await assert.rejects(repository.record({ events: [{ ...accepted, after: { directory: true, body: 'Секрет' } }] }), error => error.status === 400);
    await assert.rejects(repository.record({ events: [{ ...accepted, resourceId: 'common/other' }] }), error => error.status === 409);
    assert.equal(await count(requested), 1); assert.equal(await count('common/other'), 0);
    scenarios.push('Произвольные поля отвергаются; UUID с другим путём не меняет SQL-квитанцию');

    const preparedRoot = path.join(directory, 'prepared-recovery');
    await killAt(preparedRoot, 'prepared');
    await newStorage(preparedRoot);
    await assert.rejects(stat(path.join(preparedRoot, 'common')), error => error.code === 'ENOENT');
    assert.equal(await count('common/kill-prepared/child'), 0);
    assert.deepEqual(await journals(preparedRoot), []);
    scenarios.push('SIGKILL собственного процесса после первого mkdir: startup удаляет только созданные пустые родители, без события');

    const committedRoot = path.join(directory, 'committed-recovery');
    await killAt(committedRoot, 'committed');
    await rm(path.join(committedRoot, 'common/kill-committed'), { recursive: true });
    await newStorage(committedRoot);
    assert.equal(await count('common/kill-committed/child'), 1);
    await assert.rejects(stat(path.join(committedRoot, 'common/kill-committed')), error => error.code === 'ENOENT');
    await newStorage(committedRoot); assert.equal(await count('common/kill-committed/child'), 1);
    scenarios.push('SIGKILL после commit: startup доставляет событие ровно один раз и не повторяет mkdir');

    const protectedRoot = path.join(directory, 'manual-recovery');
    await killAt(protectedRoot, 'prepared');
    await writeFile(path.join(protectedRoot, 'common/kill-prepared/keep.txt'), 'Ручная правка');
    await assert.rejects(newStorage(protectedRoot), /откат остановлен/);
    assert.equal(await readFile(path.join(protectedRoot, 'common/kill-prepared/keep.txt'), 'utf8'), 'Ручная правка');
    assert.equal((await journals(protectedRoot)).filter(name => name.endsWith('.json')).length, 1);
    scenarios.push('Посторонний файл после SIGKILL сохраняется: recovery останавливается до первого rmdir и оставляет журнал');
} catch (error) { failure = String(error?.stack || error); process.exitCode = 1; }
finally {
    await Promise.all(stores.map(store => store.onModuleDestroy().catch(() => undefined)));
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await pool?.end();
    if (created) { await admin.query(`DROP DATABASE "${database}"`); dropped = true; }
    await admin.end(); await rm(directory, { recursive: true, force: true });
    const report = { ok: !failure, scenarios, count: scenarios.length, ownDatabaseDropped: dropped, ownDirectoryRemoved: true, realWorkingDataWrites: 0, ...(failure ? { failure } : {}) };
    await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
}
