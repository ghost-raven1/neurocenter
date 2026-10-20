import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';
import { migrateNativeAssetData } from '../src/asset-sources/migrate-native-data';
import { toToolPublication } from '@neurocenter/asset-contract';

describe('Одноразовый переход старых данных к единому source contract',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>;beforeEach(async()=>{f=await databaseFixture();});afterEach(async()=>{await f?.dispose();});
 it('старые receipts остаются evidence без ложного upstream, native IDs/versions/refs сохраняются',async()=>{
  const card=await f.plugins.create(toToolPublication(tool('local').asset as Parameters<typeof toToolPublication>[0]),actor);
  await f.pool.query(`CREATE TABLE builtin_catalog_receipts(tool_key text PRIMARY KEY,asset_id text,release text,publication_hash text,card_hash text,updated_at timestamptz DEFAULT now())`);
  await f.pool.query("INSERT INTO builtin_catalog_receipts(tool_key,asset_id,release,publication_hash,card_hash) VALUES('old',$1,'old-release','old-pubhash','old-cardhash')",[card.id]);
  const versions=await f.plugins.versions(card.id);await migrateNativeAssetData(f.pool);await migrateNativeAssetData(f.pool);
  const evidence=(await f.pool.query('SELECT * FROM asset_native_migrations')).rows;expect(evidence).toHaveLength(1);expect(evidence[0]).toMatchObject({native_id:card.id,provenance:'local-unattributed',evidence:{release:'old-release'}});
  expect((await f.pool.query("SELECT to_regclass('builtin_catalog_receipts') AS name")).rows[0].name).toBeNull();expect(await f.plugins.get(card.id)).toEqual(card);expect(await f.plugins.versions(card.id)).toEqual(versions);expect(await f.jobs.receipts(f.pin.repository)).toEqual([]);
 });
});
