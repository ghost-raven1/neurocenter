import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import {captureMigrationState,assertMigrationStatePreserved} from './production-migration-state.fixture.mjs';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

const adminConnection=ownedTestPostgresAdmin(process.env.TEST_ADMIN_PG_URL).href;

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
require('ts-node').register({transpileOnly:true,project:fileURLToPath(new URL('../../services/catalog-service/tsconfig.json',import.meta.url))});
const { Pool } = require('pg');
const { migrateCatalog } = require('./src/database/migrations.ts');
const { CATALOG_MIGRATIONS } = require('./src/database/catalog-migrations.ts');
const { CURRENT_CATALOG_SCHEMA_CONTRACT, assertCurrentCatalogSchema } = require('./src/database/current-schema-verification.ts');
const database = 'nc_install_test_reliable_migrations_' + process.pid;
const admin = new Pool({ connectionString: adminConnection });
let pool;
let created = false;
const cases = [];
const check = async (name, action) => { await action(); cases.push({ name, passed: true }); };
try {
    await admin.query('CREATE DATABASE ' + database); created = true;
    const url = new URL(adminConnection); url.pathname = '/' + database;
    pool = new Pool({ connectionString: url.href, max: 4 });
    await check('Обновление с первой схемы сохраняет прежний план и задаёт его назначение', async () => {
        await migrateCatalog(pool,CATALOG_MIGRATIONS.slice(0,2));
        await pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES('device','fixture@example.test','Главный админ','Fixture','fixture-fingerprint','fixture-token'); INSERT INTO bridge_jobs(id,email,role,device_id,kind,payload,request_key,request_hash) VALUES('prepare','fixture@example.test','Главный админ','device','project-connect','{}','prepare-key','prepare-hash'); INSERT INTO bridge_local_change_plans(id,device_id,project_id,email,binding_id,instance_id,preparation_job_id,digest,summary,expires_at) VALUES('old-plan','device','project','fixture@example.test','binding','instance','prepare','digest','{}',now()+interval '15 minutes')");
        await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(migration=>migration.version<=5));
        assert.deepEqual((await pool.query("SELECT purpose,source_id FROM bridge_local_change_plans WHERE id='old-plan'")).rows,[{purpose:'repair',source_id:null}]);
        assert.deepEqual((await pool.query('SELECT email,request_key,device_id,request_hash,job_id FROM bridge_job_requests')).rows,
            [{email:'fixture@example.test',request_key:'prepare-key',device_id:'device',request_hash:'prepare-hash',job_id:'prepare'}]);
    });
    await check('Исторические 1–5 принимают baseline без перезаписи прежних квитанций и данных',async()=>{
        await pool.query('DELETE FROM catalog_schema_migrations WHERE version IN (0,6)');
        const before=(await pool.query('SELECT * FROM catalog_schema_migrations WHERE version BETWEEN 1 AND 5 ORDER BY version')).rows;
        const devices=(await pool.query('SELECT * FROM bridge_devices ORDER BY id')).rows;
        await migrateCatalog(pool,CATALOG_MIGRATIONS);
        assert.deepEqual((await pool.query('SELECT * FROM catalog_schema_migrations WHERE version BETWEEN 1 AND 5 ORDER BY version')).rows,before);
        assert.deepEqual((await pool.query('SELECT * FROM bridge_devices ORDER BY id')).rows,devices);
        await assertCurrentCatalogSchema(pool);
    });
    await check('Полная цепочка создаёт все managed-таблицы без ручного подготовительного DDL',async()=>{
        const expected=CURRENT_CATALOG_SCHEMA_CONTRACT.filter(item=>item.kind==='table').map(item=>item.id).sort();
        const actual=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
        assert.deepEqual(actual,expected);await assertCurrentCatalogSchema(pool);
    });
    await check('Два сервера применяют миграции ровно один раз', async () => {
        await Promise.all([migrateCatalog(pool, CATALOG_MIGRATIONS), migrateCatalog(pool, CATALOG_MIGRATIONS)]);
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM catalog_schema_migrations')).rows[0].count, CATALOG_MIGRATIONS.length);
    });
    await check('Новая схема не меняет исторические задания', async () => {
        await pool.query("INSERT INTO bridge_jobs(id,email,role,device_id,kind,payload,request_key,request_hash) VALUES('history','fixture@example.test','Главный админ','device','project-connect','{}','history-key','history-hash')");
        const before=(await pool.query('SELECT * FROM bridge_jobs ORDER BY id')).rows;
        await migrateCatalog(pool, CATALOG_MIGRATIONS);
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
        await assert.rejects(migrateCatalog(pool, CATALOG_MIGRATIONS), /История миграций/);
        for(const row of history)await pool.query('UPDATE catalog_schema_migrations SET checksum=$1 WHERE version=$2',[row.checksum,row.version]);
    });
    await check('Сбой следующей миграции откатывает DDL и номер версии', async () => {
        await assert.rejects(migrateCatalog(pool, [...CATALOG_MIGRATIONS, { version: CATALOG_MIGRATIONS.at(-1).version+1, name: 'проверка отката', sql: 'CREATE TABLE rollback_probe(id integer); SELECT * FROM definitely_missing_relation' }]));
        assert.equal((await pool.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name, null);
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM catalog_schema_migrations')).rows[0].count, CATALOG_MIGRATIONS.length);
    });
    await check('Старый сервер не запускается с новой схемой',async()=>{
        await assert.rejects(migrateCatalog(pool,CATALOG_MIGRATIONS.slice(0,2)),/История миграций/);
    });
    const query=async sql=>(await pool.query(sql)).rows[0].value;
    const jsonQuery=async sql=>query('SELECT ('+sql+')::text AS value');
    await check('Acceptance сохраняет все старые значения, разрешая новые колонки и записи миграций',async()=>{
        await pool.query("CREATE TABLE migration_projection_fixture(id integer PRIMARY KEY,payload jsonb,nullable_text text); INSERT INTO migration_projection_fixture VALUES(1,'{\"original\":true}',NULL); CREATE TABLE migration_history_fixture(version text PRIMARY KEY,applied_at timestamptz NOT NULL); INSERT INTO migration_history_fixture VALUES('old-v1','2026-10-20T00:00:00Z')");
        const before=await captureMigrationState(jsonQuery);
        await pool.query("ALTER TABLE migration_projection_fixture ADD COLUMN new_metadata text; INSERT INTO migration_projection_fixture VALUES(2,'{\"new\":true}',NULL,'new'); ALTER TABLE migration_history_fixture ADD COLUMN checksum text; INSERT INTO migration_history_fixture VALUES('new-v2',now(),'new-sha')");
        await assertMigrationStatePreserved(jsonQuery,before);
        await pool.query("UPDATE migration_projection_fixture SET payload='{\"changed\":true}' WHERE id=1");
        await assert.rejects(assertMigrationStatePreserved(jsonQuery,before),/changed source row: migration_projection_fixture/);
        await pool.query("UPDATE migration_projection_fixture SET payload='{\"original\":true}' WHERE id=1;ALTER TABLE migration_projection_fixture DROP COLUMN nullable_text");
        await assert.rejects(assertMigrationStatePreserved(jsonQuery,before),/Missing source column: migration_projection_fixture.nullable_text/);
        await pool.query("ALTER TABLE migration_projection_fixture ADD COLUMN nullable_text text; UPDATE migration_history_fixture SET applied_at=applied_at+interval '1 second' WHERE version='old-v1'");
        await assert.rejects(assertMigrationStatePreserved(jsonQuery,before),/changed source row: migration_history_fixture/);
    });
    await check('Acceptance принимает удаление legacy receipts только при exact bijection evidence',async()=>{
        await pool.query("CREATE TABLE builtin_catalog_receipts(tool_key text PRIMARY KEY,asset_id text NOT NULL,payload jsonb); INSERT INTO builtin_catalog_receipts VALUES('receipt-fixture','asset-fixture','{\"original\":true}')");
        const before=await captureMigrationState(jsonQuery);
        await pool.query("INSERT INTO asset_native_migrations(migration,old_key,native_id,provenance,evidence) SELECT 'catalog-source-v1',tool_key,asset_id,'local-unattributed',to_jsonb(receipt) FROM builtin_catalog_receipts receipt;DROP TABLE builtin_catalog_receipts");
        await assertMigrationStatePreserved(jsonQuery,before,{requireReceiptMigration:true});
        await pool.query("UPDATE asset_native_migrations SET evidence='{\"changed\":true}' WHERE migration='catalog-source-v1' AND old_key='receipt-fixture'");
        await assert.rejects(assertMigrationStatePreserved(jsonQuery,before,{requireReceiptMigration:true}),/evidence replacement differs/);
    });
    await check('Acceptance сохраняет кратность одинаковых строк таблицы без первичного ключа',async()=>{
        await pool.query("CREATE TABLE migration_multiset_fixture(payload text); INSERT INTO migration_multiset_fixture VALUES('same'),('same')");
        const before=await captureMigrationState(jsonQuery);
        await pool.query('DELETE FROM migration_multiset_fixture WHERE ctid=(SELECT ctid FROM migration_multiset_fixture LIMIT 1)');
        await assert.rejects(assertMigrationStatePreserved(jsonQuery,before),/changed source row: migration_multiset_fixture/);
    });
    const result = { checkedAt: new Date().toISOString(), isolatedDatabase: database, cases, passed: cases.length };
    if (process.env.EVIDENCE_FILE) { await writeFile(process.env.EVIDENCE_FILE, JSON.stringify(result, null, 2) + '\n'); }
    console.log(JSON.stringify(result));
} finally {
    await pool?.end();
    if (created) { await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)'); }
    await admin.end();
}
