import {afterAll,describe,expect,it} from 'vitest';
import {Client,Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {RagDb} from '../src/rag/rag-db';
import {RAG_GENERATION_SCHEMA} from '../src/rag/rag-generation-schema';
import {setupDatabaseLifecycle} from '../src/retired-databases/lifecycle-schema';
import {DATABASE_LIFECYCLE_SCHEMA,PROJECT_IDENTITY_SCHEMA} from '../src/database/migration-sql';
import {GENERATION_MIGRATION,IDENTITY_MIGRATION,LIFECYCLE_MIGRATION,sqlChecksum} from '../src/database/migration-definitions';
import {migrateRag,checkRagMigrations} from '../src/database/migrations';
import {checkBaseMigrations,migrateBase} from '../src/database/migration-cli';
import {setupRagQuota,ragQuotaPolicy} from '../src/rag/quota/rag-quota';

const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
const serviceRoot=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
async function cli(mode:string|string[],env:NodeJS.ProcessEnv){
    const result=await promisify(execFile)(process.execPath,['-r',require.resolve('ts-node/register/transpile-only'),path.join(serviceRoot,'src/database/migrate.cli.ts'),...(typeof mode==='string'?[mode]:mode)],
        {cwd:serviceRoot,env:{...process.env,...env},timeout:30000});return JSON.parse(result.stdout) as any;
}

describe('Offline migration inventory',()=>{
    it('Manifest needs neither a database nor readable secrets, even in production',async()=>{
        const result=await cli('manifest',{NODE_ENV:'production',RAG_PG_URL:'postgresql://invalid:1/forbidden',RAG_PG_URL_FILE:'/missing/never-read'});
        expect(result).toEqual(expect.arrayContaining([
            {scope:'data',version:'project-generations-1',name:'project-generations',checksum:sqlChecksum(RAG_GENERATION_SCHEMA)},
            {scope:'data',version:'001-rag-storage-budget',name:'rag-storage-budget',checksum:expect.stringMatching(/^[a-f0-9]{64}$/)},
            {scope:'base',version:'database-lifecycle-1',name:'database-lifecycle',checksum:sqlChecksum(DATABASE_LIFECYCLE_SCHEMA)},
            {scope:'project',version:'project-identity-1',name:'project-identity',checksum:sqlChecksum(PROJECT_IDENTITY_SCHEMA)},
            {scope:'base',version:'platform-quota-policy-1',name:'platform-quota-policy',checksum:expect.stringMatching(/^[a-f0-9]{64}$/)},
            {scope:'data',version:'platform-quota-applied-1',name:'platform-quota-applied',checksum:expect.stringMatching(/^[a-f0-9]{64}$/)},
        ]));expect(result).toHaveLength(6);
    });
    it('Manifest rejects trailing arguments before opening any secret or connection',async()=>{
        await expect(cli(['manifest','garbage'],{NODE_ENV:'production',RAG_PG_URL_FILE:'/missing/never-read'})).rejects.toMatchObject({code:1});
    });
});

describe.skipIf(!connection)('Versioned RAG migrations in disposable databases',()=>{
    const fixtures:Array<{admin:Client;pool:Pool;name:string;stores:RagDb[]}>=[];
    async function fixture(){
        const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only local disposable PostgreSQL is allowed');
        const admin=new Client({connectionString:url.toString()});await admin.connect();
        const name='nc_rag_migrations_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}"`);url.pathname='/'+name;
        const pool=new Pool({connectionString:url.toString(),max:6}),stores:RagDb[]=[];fixtures.push({admin,pool,name,stores});
        return {pool,url:url.toString(),store:(scope:'base'|'project'='project')=>{const db=new RagDb({url:url.toString(),scope});stores.push(db);return db;}};
    }
    async function oldGeneration(pool:Pool){await pool.query(RAG_GENERATION_SCHEMA);
        await pool.query("CREATE TABLE neurocenter_rag_schema_versions(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now());INSERT INTO neurocenter_rag_schema_versions(version) VALUES('project-generations-1')");}
    afterAll(async()=>{for(const value of fixtures){await Promise.all(value.stores.map(store=>store.close()));await value.pool.end();await value.admin.query(`DROP DATABASE "${value.name}"`);await value.admin.end();}},30000);
    it('Fresh project setup records immutable checksums and prepares identity without control tables',async()=>{
        const f=await fixture();await f.store().setup();
        const names=(await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
        expect(names).toContain('neurocenter_database_identity');expect(names).not.toContain('neurocenter_project_databases');
        const versions=(await f.pool.query('SELECT version,checksum FROM neurocenter_rag_schema_versions ORDER BY version')).rows;
        expect(versions).toEqual(['platform-quota-applied-1','project-generations-1','project-identity-1'].map(version=>({version,checksum:expect.stringMatching(/^[a-f0-9]{64}$/)})));
    });
    it('Lifecycle setup records its migration instead of untracked runtime DDL',async()=>{
        const f=await fixture();await setupDatabaseLifecycle(f.pool);
        expect((await f.pool.query('SELECT version,checksum FROM neurocenter_rag_schema_versions')).rows).toEqual([{version:'database-lifecycle-1',checksum:expect.stringMatching(/^[a-f0-9]{64}$/)}]);
    });
    it('An old version marker cannot adopt an incomplete generation schema',async()=>{
        const f=await fixture();await oldGeneration(f.pool);await f.pool.query('DROP INDEX rag_chunks_hash_idx');
        await expect(f.store().setup()).rejects.toThrow(/структур|схем/i);
    });
    it('The base CLI chain creates exactly thirteen base tables and no project marker',async()=>{
        const f=await fixture(),result=await migrateBase(f.pool,f.url);expect(result).toMatchObject({ok:true,scope:'base',ready:true,existingSchema:true,pending:[]});
        const names=(await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
        expect(names).toEqual(['neurocenter_database_purge_receipts','neurocenter_project_databases','neurocenter_rag_migrations','neurocenter_rag_schema_versions',
            'rag_chunks','rag_generations','rag_index_state','rag_platform_quota_applied','rag_platform_quota_events','rag_platform_quota_policy','rag_quota_events','rag_storage_budget','rag_storage_settings','rag_write_receipts']);
    });
    it('Adoption preserves generation bytes, vectors, quota accounting and the original applied timestamp',async()=>{
        const f=await fixture();await oldGeneration(f.pool);
        await f.pool.query("INSERT INTO rag_chunks(id,project_key,generation_id,content,content_hash,embedding) VALUES('kept','own','own-generation','original','exact-content-hash','[1,2,3]')");
        await setupRagQuota(f.pool,ragQuotaPolicy());
        const bytes=(await f.pool.query('SELECT row_to_json(c) AS data FROM rag_chunks c')).rows;
        const quota=(await f.pool.query('SELECT row_to_json(b) AS data FROM rag_storage_budget b')).rows;
        const history=(await f.pool.query('SELECT * FROM neurocenter_rag_migrations')).rows;
        const at=(await f.pool.query('SELECT applied_at FROM neurocenter_rag_schema_versions')).rows[0].applied_at;
        await f.store().setup();
        expect((await f.pool.query('SELECT row_to_json(c) AS data FROM rag_chunks c')).rows).toEqual(bytes);
        expect((await f.pool.query('SELECT row_to_json(b) AS data FROM rag_storage_budget b')).rows).toEqual(quota);
        expect((await f.pool.query('SELECT * FROM neurocenter_rag_migrations')).rows).toEqual(history);
        expect((await f.pool.query("SELECT applied_at,checksum FROM neurocenter_rag_schema_versions WHERE version='project-generations-1'")).rows[0]).toEqual({applied_at:at,checksum:sqlChecksum(RAG_GENERATION_SCHEMA)});
    });
    it('Untracked lifecycle and retained identity tables adopt without rewriting existing receipts or markers',async()=>{
        const f=await fixture();await f.pool.query(DATABASE_LIFECYCLE_SCHEMA);await f.pool.query(PROJECT_IDENTITY_SCHEMA);
        const marker=randomUUID(),receipt=randomUUID();
        await f.pool.query("INSERT INTO neurocenter_project_databases(project_id,database_name,migrated,retirement_id,lifecycle_state) VALUES('own','own_database',true,$1,'retained')",[receipt]);
        await f.pool.query("INSERT INTO neurocenter_database_purge_receipts(id,project_id,digest,facts,phase) VALUES($1,'own','exact-digest','{\"preserved\":true}','failed')",[receipt]);
        await f.pool.query("INSERT INTO neurocenter_database_identity VALUES(true,$1,'own')",[marker]);
        const before=await Promise.all(['neurocenter_project_databases','neurocenter_database_purge_receipts','neurocenter_database_identity'].map(table=>f.pool.query(`SELECT row_to_json(t) AS data FROM ${table} t`)));
        await setupDatabaseLifecycle(f.pool);await migrateRag(f.pool,[IDENTITY_MIGRATION]);
        const after=await Promise.all(['neurocenter_project_databases','neurocenter_database_purge_receipts','neurocenter_database_identity'].map(table=>f.pool.query(`SELECT row_to_json(t) AS data FROM ${table} t`)));
        expect(after.map(result=>result.rows)).toEqual(before.map(result=>result.rows));
    });
    it('Parallel project initialization and replay leave one immutable receipt per migration',async()=>{
        const f=await fixture();await Promise.all(Array.from({length:4},()=>f.store().setup()));
        const before=(await f.pool.query('SELECT * FROM neurocenter_rag_schema_versions ORDER BY version')).rows;
        await f.store().setup();expect((await f.pool.query('SELECT * FROM neurocenter_rag_schema_versions ORDER BY version')).rows).toEqual(before);expect(before).toHaveLength(3);
        expect((await f.pool.query('SELECT count(*)::int AS count FROM neurocenter_database_identity')).rows[0].count).toBe(0);
    });
    it.each(['project-generations-1','project-identity-1','database-lifecycle-1'])('A changed checksum for %s fails before another migration or data write',async version=>{
        const f=await fixture();await f.store().setup();await setupDatabaseLifecycle(f.pool);
        await f.pool.query('UPDATE neurocenter_rag_schema_versions SET checksum=$2 WHERE version=$1',[version,'a'.repeat(64)]);
        const before=(await f.pool.query('SELECT * FROM neurocenter_rag_schema_versions ORDER BY version')).rows;
        await expect(f.store().setup()).rejects.toThrow(/История миграций/);
        expect((await f.pool.query('SELECT * FROM neurocenter_rag_schema_versions ORDER BY version')).rows).toEqual(before);
    });
    it('Unknown future history fails closed rather than silently rerunning older SQL',async()=>{
        const f=await fixture();await migrateRag(f.pool,[IDENTITY_MIGRATION]);await f.pool.query("INSERT INTO neurocenter_rag_schema_versions(version,checksum) VALUES('future-schema','unexpected')");
        await expect(migrateRag(f.pool,[LIFECYCLE_MIGRATION])).rejects.toThrow(/История миграций/);
        expect((await f.pool.query("SELECT to_regclass('public.neurocenter_project_databases') AS name")).rows[0].name).toBeNull();
    });
    it.each([
        'DROP TRIGGER rag_vector_dimension ON rag_chunks',
        'ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector(3)',
        'ALTER TABLE rag_chunks ALTER COLUMN content DROP NOT NULL',
        "ALTER TABLE rag_generations DROP CONSTRAINT rag_generations_state_check",
        "CREATE OR REPLACE FUNCTION neurocenter_rag_vector_dimension() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    ])('An unchecksummed legacy marker cannot adopt drift: %s',async sql=>{
        const f=await fixture();await oldGeneration(f.pool);await f.pool.query(sql);
        await expect(f.store().setup()).rejects.toThrow(/Структура схемы/);
        expect((await f.pool.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='neurocenter_rag_schema_versions' AND column_name='checksum'")).rows[0].count).toBe(0);
    });
    it('A metadata write failure rolls back lifecycle DDL and can be retried',async()=>{
        const f=await fixture();await migrateRag(f.pool,[IDENTITY_MIGRATION]);
        await f.pool.query(`CREATE FUNCTION fail_migration_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='database-lifecycle-1' THEN RAISE EXCEPTION 'fixture receipt failure'; END IF;RETURN NEW;END $$;
            CREATE TRIGGER fail_migration_receipt BEFORE INSERT ON neurocenter_rag_schema_versions FOR EACH ROW EXECUTE FUNCTION fail_migration_receipt()`);
        await expect(setupDatabaseLifecycle(f.pool)).rejects.toThrow('fixture receipt failure');
        expect((await f.pool.query("SELECT to_regclass('public.neurocenter_project_databases') AS name,to_regclass('public.neurocenter_database_purge_receipts') AS receipts")).rows[0]).toEqual({name:null,receipts:null});
        await f.pool.query('DROP TRIGGER fail_migration_receipt ON neurocenter_rag_schema_versions;DROP FUNCTION fail_migration_receipt()');await setupDatabaseLifecycle(f.pool);
    });
    it('Read-only checking of a fresh database reports pending without creating any table',async()=>{
        const f=await fixture();expect(await checkBaseMigrations(f.pool)).toMatchObject({ok:true,ready:false,existingSchema:false,pending:expect.arrayContaining(['project-generations-1','database-lifecycle-1','001-rag-storage-budget'])});
        expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
    });
    it('Read-only legacy compatibility validates structure but never adds a checksum column or adopts the marker',async()=>{
        const f=await fixture();await oldGeneration(f.pool);
        expect(await checkRagMigrations(f.pool,[GENERATION_MIGRATION])).toEqual({applied:[],pending:['project-generations-1']});
        expect((await f.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='neurocenter_rag_schema_versions' ORDER BY column_name")).rows.map(row=>row.column_name)).toEqual(['applied_at','version']);
    });
    it('Actual CLI check is read-only and migrate initializes only the base scope',async()=>{
        const f=await fixture(),env={NODE_ENV:'development',RAG_PG_URL:f.url,RAG_PG_URL_FILE:undefined};
        expect(await cli('check',env)).toMatchObject({ok:true,scope:'base',ready:false,existingSchema:false,projectMigrations:'before-access'});
        expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
        expect(await cli('migrate',env)).toMatchObject({ok:true,scope:'base',ready:true,pending:[],projectMigrations:'before-access'});
        expect(await cli('check',env)).toMatchObject({ok:true,scope:'base',ready:true,existingSchema:true,pending:[]});
        expect(await cli(['check','--ready'],env)).toMatchObject({ok:true,scope:'base',ready:true,pending:[]});
        expect((await f.pool.query("SELECT to_regclass('public.neurocenter_database_identity') AS name")).rows[0].name).toBeNull();
    },30000);
    it.each([
        'DROP TRIGGER rag_chunks_budget_after ON rag_chunks',
        'DROP FUNCTION neurocenter_check_rag_budget() CASCADE',
        'ALTER TABLE rag_storage_budget DROP COLUMN limit_bytes CASCADE',
        'ALTER TABLE rag_storage_budget DROP CONSTRAINT rag_storage_budget_used_bytes_check',
        'ALTER TABLE rag_chunks DISABLE TRIGGER rag_chunks_write_lock',
        `DROP TRIGGER rag_storage_quota_limit ON rag_storage_budget;CREATE CONSTRAINT TRIGGER rag_storage_quota_limit AFTER INSERT OR UPDATE ON rag_storage_budget
            NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION neurocenter_check_rag_budget()`,
    ])('An intact quota checksum cannot certify weakened physical enforcement: %s',async sql=>{
        const f=await fixture();await migrateBase(f.pool,f.url);await f.pool.query(sql);
        await expect(checkBaseMigrations(f.pool)).rejects.toThrow(/Структура схемы/);
        await expect(migrateBase(f.pool,f.url)).rejects.toThrow(/Структура схемы/);
    });
    it('A damaged quota history prevents legacy generation adoption and new application DDL',async()=>{
        const f=await fixture();await oldGeneration(f.pool);await setupRagQuota(f.pool,ragQuotaPolicy());
        await f.pool.query("UPDATE neurocenter_rag_migrations SET checksum='tampered'");
        await expect(f.store().setup()).rejects.toThrow(/История миграций/);
        expect((await f.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='neurocenter_rag_schema_versions' ORDER BY column_name")).rows.map(row=>row.column_name)).toEqual(['applied_at','version']);
        expect((await f.pool.query("SELECT to_regclass('public.neurocenter_database_identity') AS name")).rows[0].name).toBeNull();
    });
    it('Readonly base receipt detects a partial old RAG database even without any migration ledger',async()=>{
        const f=await fixture();await f.pool.query('CREATE TABLE rag_chunks(id text PRIMARY KEY,content text);INSERT INTO rag_chunks VALUES(\'kept\',\'legacy bytes\')');
        expect(await checkBaseMigrations(f.pool)).toMatchObject({ok:true,scope:'base',ready:false,existingSchema:true});
        expect((await f.pool.query('SELECT * FROM rag_chunks')).rows).toEqual([{id:'kept',content:'legacy bytes'}]);
        expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows).toEqual([{tablename:'rag_chunks'}]);
    });
    it.each([['migrate','--dry-run'],['check','--unknown'],['check','--ready']])('Actual CLI %s %s must not accidentally apply or certify a blank schema',async(mode,flag)=>{
        const f=await fixture();await expect(cli([mode,flag],{NODE_ENV:'development',RAG_PG_URL:f.url,RAG_PG_URL_FILE:undefined})).rejects.toMatchObject({code:1});
        expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
    });
});
