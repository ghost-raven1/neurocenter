import type {Pool,PoolClient} from 'pg';
import {GENERATION_MIGRATION,QUOTA_MIGRATION,RAG_MIGRATIONS,sqlChecksum,type RagMigration} from './migration-definitions';
import {inspectSchema} from './schema-inspection';

interface AppliedMigration {version:string;checksum:string|null;}
const historyError=()=>new Error('История миграций RAG не совпадает с этой сборкой. Автоматический откат запрещён.');
const lock="SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:rag:migrations',0))";

/** An old generation marker is adopted only after exact checks of its columns, constraints, indexes, function and trigger. */
async function verifySchema(db:PoolClient,migration:RagMigration):Promise<void>{
    for(const table of [...migration.objects.tables,...migration.lockTables??[]]){await db.query(`LOCK TABLE public."${table}" IN ACCESS SHARE MODE`);}
    if(sqlChecksum(JSON.stringify(await inspectSchema(db,migration.objects)))!==migration.schemaSha256){
        throw new Error('Структура схемы RAG не соответствует миграции '+migration.version+'. Требуется явное восстановление схемы.');
    }
}

function verifyHistory(rows:AppliedMigration[]):void{
    for(const row of rows){const known=RAG_MIGRATIONS.find(migration=>migration.version===row.version);
        if(!known||row.checksum!==null&&row.checksum!==sqlChecksum(known.sql)||row.checksum===null&&row.version!==GENERATION_MIGRATION.version)throw historyError();}
}

/** Frozen quota SQL has its own ledger; both its history and actual enforcement must remain intact. */
async function verifyQuota(db:PoolClient):Promise<boolean>{
    if(!(await db.query("SELECT to_regclass('public.neurocenter_rag_migrations') AS name")).rows[0].name)return false;
    const rows=(await db.query<AppliedMigration>('SELECT version,checksum FROM neurocenter_rag_migrations ORDER BY version')).rows;
    if(rows.some(row=>row.version!==QUOTA_MIGRATION.version||row.checksum!==sqlChecksum(QUOTA_MIGRATION.sql)))throw historyError();
    if(!rows.length)return false;
    await verifySchema(db,QUOTA_MIGRATION);return true;
}

/** Неизвестный откат не возвращает собственную READ ONLY-сессию следующему писателю. */
export async function checkRagQuotaMigration(pool:Pool):Promise<boolean>{
    const client=await pool.connect();let discard=false;try{
        await client.query('BEGIN READ ONLY');await client.query("SET LOCAL search_path=public,pg_catalog");
        const applied=await verifyQuota(client);await client.query('COMMIT');return applied;
    }catch(error){await client.query('ROLLBACK').catch(()=>{discard=true;});throw error;}finally{client.release(discard);}
}

/** Bootstrap is limited to the migration ledger; application tables are created exclusively by registered SQL. */
export async function migrateRag(pool:Pool,migrations:readonly RagMigration[]):Promise<void>{
    const client=await pool.connect();let discard=false;
    try{
        await client.query('BEGIN');await client.query("SET LOCAL search_path=public,pg_catalog");await client.query(lock);
        // Keep the previous lock too: an older process cannot race generation adoption during a rolling upgrade.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:rag-generation-schema',0))");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:database-lifecycle-schema',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS neurocenter_rag_schema_versions(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),checksum TEXT);
            ALTER TABLE neurocenter_rag_schema_versions ADD COLUMN IF NOT EXISTS checksum TEXT`);
        const rows=(await client.query<AppliedMigration>('SELECT version,checksum FROM neurocenter_rag_schema_versions ORDER BY version')).rows;verifyHistory(rows);
        await verifyQuota(client);
        for(const migration of migrations){
            const applied=rows.find(row=>row.version===migration.version),checksum=sqlChecksum(migration.sql);
            if(!applied)await client.query(migration.sql);
            await verifySchema(client,migration);
            if(!applied)await client.query('INSERT INTO neurocenter_rag_schema_versions(version,checksum) VALUES($1,$2)',[migration.version,checksum]);
            else if(applied.checksum===null)await client.query('UPDATE neurocenter_rag_schema_versions SET checksum=$2 WHERE version=$1 AND checksum IS NULL',[migration.version,checksum]);
        }
        await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{discard=true;});throw error;}finally{client.release(discard);}
}

/** Compatibility inspection never creates a ledger, adopts history, or changes application data. */
export async function checkRagMigrations(pool:Pool,migrations:readonly RagMigration[]):Promise<{applied:string[];pending:string[]}>{
    const client=await pool.connect();let discard=false;try{
        await client.query('BEGIN READ ONLY');await client.query("SET LOCAL search_path=public,pg_catalog");
        const present=(await client.query("SELECT to_regclass('public.neurocenter_rag_schema_versions') AS name")).rows[0].name;
        if(!present){await client.query('COMMIT');return {applied:[],pending:migrations.map(item=>item.version)};}
        const checksumColumn=(await client.query("SELECT 1 FROM pg_attribute WHERE attrelid='public.neurocenter_rag_schema_versions'::regclass AND attname='checksum' AND NOT attisdropped")).rowCount;
        const rows=(await client.query<AppliedMigration>(`SELECT version,${checksumColumn?'checksum':'NULL::text AS checksum'} FROM neurocenter_rag_schema_versions ORDER BY version`)).rows;verifyHistory(rows);
        const applied:string[]=[],pending:string[]=[];
        for(const migration of migrations){const row=rows.find(item=>item.version===migration.version);
            if(row){await verifySchema(client,migration);(row.checksum===null?pending:applied).push(migration.version);}else pending.push(migration.version);}
        await client.query('COMMIT');return {applied,pending};
    }catch(error){await client.query('ROLLBACK').catch(()=>{discard=true;});throw error;}finally{client.release(discard);}
}
