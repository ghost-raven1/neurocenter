import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const { Pool } = require('pg');
const { migrateCatalog } = await import(pathToFileURL(path.resolve('services/catalog-service/src/database/migrations.ts')));
const { INSTALLATION_MIGRATIONS } = await import(pathToFileURL(path.resolve('services/catalog-service/src/devices/installation-migrations.ts')));
const database = 'nc_install_test_reliable_migrations_' + process.pid;
const admin = new Pool({ connectionString: process.env.TEST_ADMIN_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres' });
let pool;
let created = false;
const cases = [];
const check = async (name, action) => { await action(); cases.push({ name, passed: true }); };
try {
    await admin.query('CREATE DATABASE ' + database); created = true;
    const url = new URL(process.env.TEST_ADMIN_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres'); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 4 });
    await pool.query(`CREATE TABLE bridge_devices(id text PRIMARY KEY);
        CREATE TABLE bridge_jobs(id text PRIMARY KEY,email text NOT NULL DEFAULT 'fixture@example.test',
        device_id text NOT NULL REFERENCES bridge_devices(id),request_key text NOT NULL,request_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(email,request_key))`);
    await check('Обновление с первой схемы сохраняет прежний план и задаёт его назначение', async () => {
        await migrateCatalog(pool,INSTALLATION_MIGRATIONS.slice(0,1));
        await pool.query("INSERT INTO bridge_devices VALUES('device'); INSERT INTO bridge_jobs(id,device_id,request_key,request_hash) VALUES('prepare','device','prepare-key','prepare-hash'); INSERT INTO bridge_local_change_plans(id,device_id,project_id,email,binding_id,instance_id,preparation_job_id,digest,summary,expires_at) VALUES('old-plan','device','project','fixture@example.test','binding','instance','prepare','digest','{}',now()+interval '15 minutes')");
        await migrateCatalog(pool,INSTALLATION_MIGRATIONS);
        assert.deepEqual((await pool.query("SELECT purpose,source_id FROM bridge_local_change_plans WHERE id='old-plan'")).rows,[{purpose:'repair',source_id:null}]);
        assert.deepEqual((await pool.query('SELECT email,request_key,device_id,request_hash,job_id FROM bridge_job_requests')).rows,
            [{email:'fixture@example.test',request_key:'prepare-key',device_id:'device',request_hash:'prepare-hash',job_id:'prepare'}]);
    });
    await check('Два сервера применяют миграции ровно один раз', async () => {
        await Promise.all([migrateCatalog(pool, INSTALLATION_MIGRATIONS), migrateCatalog(pool, INSTALLATION_MIGRATIONS)]);
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM catalog_schema_migrations')).rows[0].count, INSTALLATION_MIGRATIONS.length);
    });
    await check('Новая схема не меняет исторические задания', async () => {
        await pool.query("INSERT INTO bridge_jobs(id,device_id,request_key,request_hash) VALUES('history','device','history-key','history-hash')");
        const before=(await pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows;
        await migrateCatalog(pool, INSTALLATION_MIGRATIONS);
        assert.deepEqual((await pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows,before);
    });
    await check('Удаление job удаляет его alias, чужой job не затрагивается',async()=>{
        await pool.query("INSERT INTO bridge_job_requests(email,request_key,device_id,request_hash,job_id) VALUES('fixture@example.test','history-alias','device','alias-hash','history')");
        await pool.query("DELETE FROM bridge_jobs WHERE id='history'");
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM bridge_job_requests WHERE job_id='history'")).rows[0].count,0);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM bridge_job_requests WHERE job_id='prepare'")).rows[0].count,1);
    });
    await check('Повреждённая история останавливает запуск', async () => {
        const history = (await pool.query('SELECT version,checksum FROM catalog_schema_migrations ORDER BY version')).rows;
        await pool.query("UPDATE catalog_schema_migrations SET checksum='broken'");
        await assert.rejects(migrateCatalog(pool, INSTALLATION_MIGRATIONS), /История миграций/);
        for(const row of history)await pool.query('UPDATE catalog_schema_migrations SET checksum=$1 WHERE version=$2',[row.checksum,row.version]);
    });
    await check('Сбой следующей миграции откатывает DDL и номер версии', async () => {
        await assert.rejects(migrateCatalog(pool, [...INSTALLATION_MIGRATIONS, { version: INSTALLATION_MIGRATIONS.length+1, name: 'проверка отката', sql: 'CREATE TABLE rollback_probe(id integer); SELECT * FROM definitely_missing_relation' }]));
        assert.equal((await pool.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name, null);
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM catalog_schema_migrations')).rows[0].count, INSTALLATION_MIGRATIONS.length);
    });
    await check('Старый сервер не запускается с новой схемой',async()=>{
        await assert.rejects(migrateCatalog(pool,INSTALLATION_MIGRATIONS.slice(0,1)),/История миграций/);
    });
    const result = { checkedAt: new Date().toISOString(), isolatedDatabase: database, cases, passed: cases.length };
    if (process.env.EVIDENCE_FILE) { await writeFile(process.env.EVIDENCE_FILE, JSON.stringify(result, null, 2) + '\n'); }
    console.log(JSON.stringify(result));
} finally {
    await pool?.end();
    if (created) { await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)'); }
    await admin.end();
}
