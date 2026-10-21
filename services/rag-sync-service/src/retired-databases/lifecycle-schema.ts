import type {Pool} from 'pg';

export const LIFECYCLE_LOCK='neurocenter:database-lifecycle';
export const databaseLock=(database:string)=>'neurocenter:database:'+database;

/** Реестр не удаляется вместе с физической БД: receipt отличает повтор от чужой новой базы. */
export async function setupDatabaseLifecycle(db:Pick<Pool,'query'>):Promise<void>{
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:database-lifecycle-schema',0));
        CREATE TABLE IF NOT EXISTS neurocenter_project_databases(
        project_id TEXT PRIMARY KEY,database_name TEXT NOT NULL UNIQUE,migration_offset BIGINT NOT NULL DEFAULT 0,
        migrated BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        ALTER TABLE neurocenter_project_databases ADD COLUMN IF NOT EXISTS database_identity UUID NOT NULL DEFAULT gen_random_uuid();
        ALTER TABLE neurocenter_project_databases ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active';
        ALTER TABLE neurocenter_project_databases ADD COLUMN IF NOT EXISTS retirement_id UUID;
        ALTER TABLE neurocenter_project_databases ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS neurocenter_database_purge_receipts(
        id UUID PRIMARY KEY,project_id TEXT NOT NULL,digest TEXT NOT NULL,facts JSONB NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('claimed','freezing','dropping','failed','dropped')),
        message TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}
