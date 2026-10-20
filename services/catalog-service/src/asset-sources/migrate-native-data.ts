import type { Pool } from 'pg';

/** Старые квитанции сохраняются как история миграции; они не объявляются доказательством нового upstream. */
export async function migrateNativeAssetData(pool:Pool):Promise<void> {
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:asset-native-data-migration',0))");
  await client.query(`CREATE TABLE IF NOT EXISTS asset_native_migrations (
   migration text NOT NULL,old_key text NOT NULL,native_id text NOT NULL,provenance text NOT NULL CHECK(provenance='local-unattributed'),
   evidence jsonb NOT NULL,migrated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(migration,old_key))`);
  const previous=await client.query<{name:string|null}>("SELECT to_regclass('builtin_catalog_receipts')::text AS name");
  if(previous.rows[0]?.name){
   await client.query(`INSERT INTO asset_native_migrations(migration,old_key,native_id,provenance,evidence)
    SELECT 'catalog-source-v1',tool_key,asset_id,'local-unattributed',to_jsonb(receipt) FROM builtin_catalog_receipts receipt ON CONFLICT DO NOTHING`);
   await client.query('DROP TABLE builtin_catalog_receipts');
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}
