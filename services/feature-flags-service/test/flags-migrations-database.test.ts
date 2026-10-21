import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Pool} from 'pg';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {checkFeatureFlagsMigrations,featureFlagsMigrationManifest,migrateFeatureFlags} from '../src/database/migrations';
import {FEATURE_FLAGS_SCHEMA_SQL} from '../src/database/feature-flags-schema';
import {FlagsRepository} from '../src/flags/flags.repository';

/** Every case owns an entire temporary database; no public fallback reaches working tables. */
describe.runIf(!!process.env.CATALOG_TEST_PG_URL)('Versioned feature flags — actual PostgreSQL',()=>{
    let admin:Pool,pool:Pool,database:string;
    beforeEach(async()=>{
        const url=new URL(process.env.CATALOG_TEST_PG_URL!);url.pathname='/postgres';
        admin=new Pool({connectionString:url.href,max:1});database='nc_flags_schema_'+randomUUID().replaceAll('-','');
        await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;pool=new Pool({connectionString:url.href,max:4});
    });
    afterEach(async()=>{await pool?.end();if(database)await admin.query('DROP DATABASE '+database);await admin?.end();});
    const tables=async()=> (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);

    it('Readonly preflight accepts a blank database without creating a journal or defaults',async()=>{
        expect(await checkFeatureFlagsMigrations(pool)).toEqual({ok:true,ready:false,applied:[],pending:[1]});
        await expect(checkFeatureFlagsMigrations(pool,true)).rejects.toThrow('ещё не применены');expect(await tables()).toEqual([]);
    });
    it('A blank database is completely prepared by its numbered migration',async()=>{
        expect(await migrateFeatureFlags(pool)).toEqual({ok:true,ready:true,applied:[1],pending:[]});
        expect(await tables()).toEqual(['feature_flags','feature_flags_schema_migrations','security_events']);
        expect((await pool.query('SELECT version,name,checksum FROM feature_flags_schema_migrations')).rows).toEqual(featureFlagsMigrationManifest());
        expect(await checkFeatureFlagsMigrations(pool,true)).toMatchObject({ready:true,pending:[]});
    });
    it('Adopts the former startup schema without changing overrides, revisions, timestamps or events',async()=>{
        await pool.query(FEATURE_FLAGS_SCHEMA_SQL);
        await pool.query("INSERT INTO feature_flags VALUES('model_hosting','{\"enabled\":false}',17,'2026-10-19T00:00:00Z','owner@example.test')");
        await pool.query("INSERT INTO security_events(event_id,actor,action,resource_id) VALUES($1,'owner','changed','model_hosting')",[randomUUID()]);
        const before={flags:(await pool.query('SELECT * FROM feature_flags')).rows,events:(await pool.query('SELECT * FROM security_events')).rows};
        await migrateFeatureFlags(pool);await new FlagsRepository(pool).setup();
        expect((await pool.query("SELECT * FROM feature_flags WHERE flag_key='model_hosting'")).rows).toEqual(before.flags);
        expect((await pool.query('SELECT * FROM security_events')).rows).toEqual(before.events);
    });
    it('Replay and concurrent migration callers keep one immutable history row',async()=>{
        await Promise.all([migrateFeatureFlags(pool),migrateFeatureFlags(pool),migrateFeatureFlags(pool)]);
        const before=(await pool.query('SELECT * FROM feature_flags_schema_migrations')).rows;
        await migrateFeatureFlags(pool);expect((await pool.query('SELECT * FROM feature_flags_schema_migrations')).rows).toEqual(before);
    });
    it.each(['checksum','name','version'])('History tampering (%s) stops migration and preflight',async key=>{
        await migrateFeatureFlags(pool);
        await pool.query('UPDATE feature_flags_schema_migrations SET '+key+'=$1',[key==='version'?2:'tampered']);
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('История миграций');
        await expect(checkFeatureFlagsMigrations(pool)).rejects.toThrow('История миграций');
    });
    it('Wrong existing column type fails adoption and rolls back new schema and history',async()=>{
        await pool.query('CREATE TABLE feature_flags(flag_key TEXT PRIMARY KEY,overrides TEXT NOT NULL,revision BIGINT NOT NULL,updated_at TIMESTAMPTZ NOT NULL,updated_by TEXT NOT NULL)');
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('feature_flags.overrides');
        expect(await tables()).toEqual(['feature_flags']);
    });
    it('A forged complete history does not hide a dropped column',async()=>{
        await migrateFeatureFlags(pool);await pool.query('ALTER TABLE feature_flags DROP COLUMN updated_by');
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('feature_flags.updated_by');
        await expect(checkFeatureFlagsMigrations(pool,true)).rejects.toThrow('feature_flags.updated_by');
    });
    it('Wrong existing index is rejected without recording a migration',async()=>{
        await pool.query(FEATURE_FLAGS_SCHEMA_SQL);await pool.query('DROP INDEX security_events_created;CREATE INDEX security_events_created ON security_events(actor)');
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('индекс');
        expect(await tables()).not.toContain('feature_flags_schema_migrations');
    });
    it('A UNIQUE replacement of the audit index is rejected before it can suppress equal-time events',async()=>{
        await pool.query(FEATURE_FLAGS_SCHEMA_SQL);await pool.query('DROP INDEX security_events_created;CREATE UNIQUE INDEX security_events_created ON security_events(created_at DESC)');
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('индекс');
        expect(await tables()).not.toContain('feature_flags_schema_migrations');
    });
    it('Wrong defaults are rejected before adopting the former untracked schema',async()=>{
        await pool.query(FEATURE_FLAGS_SCHEMA_SQL);await pool.query('ALTER TABLE feature_flags ALTER COLUMN revision SET DEFAULT -1');
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('default переключателей: feature_flags.revision');
        expect(await tables()).not.toContain('feature_flags_schema_migrations');
    });
    it('A weakened CHECK cannot masquerade as the canonical constraint',async()=>{
        await pool.query(FEATURE_FLAGS_SCHEMA_SQL);await pool.query("ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_overrides_check;ALTER TABLE feature_flags ADD CHECK(jsonb_typeof(overrides)='object' OR true)");
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('ограничения');
        expect(await tables()).not.toContain('feature_flags_schema_migrations');
    });
    it('Adoption preserves the positive revision CHECK from the former startup schema',async()=>{
        await pool.query(FEATURE_FLAGS_SCHEMA_SQL);await pool.query('ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_revision_check');
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('ограничения');
        expect(await tables()).not.toContain('feature_flags_schema_migrations');
        await pool.query('ALTER TABLE feature_flags ADD CHECK(revision>0)');await migrateFeatureFlags(pool);
        await expect(pool.query("INSERT INTO feature_flags(flag_key,revision) VALUES('bad',0)")).rejects.toMatchObject({code:'23514'});
    });
    it('Database failure in the migration rolls back all new objects, and retry is usable',async()=>{
        await pool.query("CREATE TABLE security_events(event_id UUID PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,resource_id TEXT NOT NULL,before_state JSONB,after_state JSONB,created_at TEXT NOT NULL)");
        await expect(migrateFeatureFlags(pool)).rejects.toThrow('security_events.created_at');
        expect(await tables()).toEqual(['security_events']);
        await pool.query('DROP TABLE security_events');expect(await migrateFeatureFlags(pool)).toMatchObject({ready:true});
    });
    it('Schema lock serializes migration with the catalog before touching shared tables',async()=>{
        const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:catalog:migrations',0))");
        let finished=false;const migration=migrateFeatureFlags(pool).then(()=>{finished=true;});
        try{await pool.query('SELECT pg_sleep(0.05)');expect(finished).toBe(false);expect(await tables()).toEqual([]);}
        finally{await blocker.query('ROLLBACK');blocker.release();}
        await migration;expect(finished).toBe(true);
    });
    it('Actual CLI check/migrate/ready roundtrip obeys the same schema contract',async()=>{
        const url=new URL(process.env.CATALOG_TEST_PG_URL!);url.pathname='/'+database;
        const run=(...args:string[])=>spawnSync(process.execPath,['-r','ts-node/register/transpile-only','src/database/migrate.cli.ts',...args],{
            cwd:process.cwd(),encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,NODE_ENV:'test',CATALOG_PG_URL:url.href},
        });
        const pending=run('check');expect(pending.status).toBe(0);expect(JSON.parse(pending.stdout)).toMatchObject({ready:false,pending:[1]});
        expect(run('check','--ready').status).toBe(1);expect(await tables()).toEqual([]);
        const migrated=run('migrate');expect(migrated.status,migrated.stderr).toBe(0);expect(JSON.parse(migrated.stdout)).toEqual({ok:true,ready:true,applied:[1],pending:[]});
        const ready=run('check','--ready');expect(ready.status,ready.stderr).toBe(0);expect(JSON.parse(ready.stdout)).toMatchObject({ready:true,pending:[]});
    });
});
