import type {Pool} from 'pg';
import {migrateRag} from '../database/migrations';
import {LIFECYCLE_MIGRATION} from '../database/migration-definitions';

export const LIFECYCLE_LOCK='neurocenter:database-lifecycle';
export const databaseLock=(database:string)=>'neurocenter:database:'+database;

/** Реестр не удаляется вместе с физической БД: receipt отличает повтор от чужой новой базы. */
export async function setupDatabaseLifecycle(db:Pool):Promise<void>{
    await migrateRag(db,[LIFECYCLE_MIGRATION]);
}
