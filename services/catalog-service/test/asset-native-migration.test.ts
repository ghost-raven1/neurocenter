import { describe, expect, it } from 'vitest';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';
import {PluginRepository} from '../src/publication/plugin-repository';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import { toToolPublication } from '@neurocenter/asset-contract';
import type {IAiPlugin,IAiPluginVersion} from '../src/catalog/dto';

describe('Одноразовый переход старых данных к единому source contract',()=>{
 it('старые receipts остаются evidence без ложного upstream, native IDs/versions/refs сохраняются',async()=>{
  let card:IAiPlugin|undefined,versions:IAiPluginVersion[]=[];
  const f=await databaseFixture({beforeFinalize:async pool=>{
   const plugins=new PluginRepository(pool);card=await plugins.create(toToolPublication(tool('local').asset as Parameters<typeof toToolPublication>[0]),actor);versions=await plugins.versions(card.id);
   await pool.query(`CREATE TABLE builtin_catalog_receipts(tool_key text PRIMARY KEY,asset_id text,release text,publication_hash text,card_hash text,updated_at timestamptz DEFAULT now())`);
   await pool.query("INSERT INTO builtin_catalog_receipts(tool_key,asset_id,release,publication_hash,card_hash) VALUES('old',$1,'old-release','old-pubhash','old-cardhash')",[card.id]);
  }});try{
  if(!card)throw new Error('Legacy fixture did not publish a card');await ensureCatalogSchema(f.pool);await ensureCatalogSchema(f.pool);
  const evidence=(await f.pool.query('SELECT * FROM asset_native_migrations')).rows;expect(evidence).toHaveLength(1);expect(evidence[0]).toMatchObject({native_id:card.id,provenance:'local-unattributed',evidence:{release:'old-release'}});
  expect((await f.pool.query("SELECT to_regclass('builtin_catalog_receipts') AS name")).rows[0].name).toBeNull();expect(await f.plugins.get(card.id)).toEqual(card);expect(await f.plugins.versions(card.id)).toEqual(versions);expect(await f.jobs.receipts(f.pin.repository)).toEqual([]);
  }finally{await f.dispose();}
 });
});
