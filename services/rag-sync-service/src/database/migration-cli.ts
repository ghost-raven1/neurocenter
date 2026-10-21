import type {Pool} from 'pg';
import {RagDb} from '../rag/rag-db';
import {setupDatabaseLifecycle} from '../retired-databases/lifecycle-schema';
import {RAG_QUOTA_MIGRATION} from '../rag/quota/rag-quota-schema';
import {checkRagMigrations,checkRagQuotaMigration} from './migrations';
import {GENERATION_MIGRATION,LIFECYCLE_MIGRATION,PLATFORM_QUOTA_MIGRATION,PLATFORM_QUOTA_CACHE_MIGRATION,QUOTA_MIGRATION} from './migration-definitions';

/** A readiness inspection is strictly read-only, including databases from before the first migration ledger. */
export async function checkBaseMigrations(pool:Pool){
    const tables=[...GENERATION_MIGRATION.objects.tables,...QUOTA_MIGRATION.objects.tables,...LIFECYCLE_MIGRATION.objects.tables,...PLATFORM_QUOTA_MIGRATION.objects.tables,...PLATFORM_QUOTA_CACHE_MIGRATION.objects.tables];
    const existingSchema=(await pool.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1::text[])) AS present`,[tables])).rows[0].present;
    const result=await checkRagMigrations(pool,[GENERATION_MIGRATION,LIFECYCLE_MIGRATION,PLATFORM_QUOTA_MIGRATION,PLATFORM_QUOTA_CACHE_MIGRATION]);
    (await checkRagQuotaMigration(pool)?result.applied:result.pending).push(RAG_QUOTA_MIGRATION);
    return {ok:true,scope:'base',projectMigrations:'before-access',existingSchema,ready:result.pending.length===0,...result};
}

/** Base initialization never creates, adopts or modifies a project database. */
export async function migrateBase(pool:Pool,url:string){
    const db=new RagDb({url,scope:'base'});
    try{await db.setup();await setupDatabaseLifecycle(pool);return await checkBaseMigrations(pool);}finally{await db.close();}
}
