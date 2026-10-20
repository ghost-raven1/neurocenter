import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assetDigest,serializeAsset,toToolPublication } from '@neurocenter/asset-contract';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';
import { importPlanDigest } from '../src/asset-sources/import-types';
import { LocalAssetIngest } from '../src/asset-sources/local-asset-ingest';

describe('Явная замена local override: immutable history, exact intent, повторный CAS',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>;
 beforeEach(async()=>{f=await databaseFixture();});afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
 const run=async()=>{const w=f.worker();await w.flush();await w.stop();};
 const begin=async()=>f.jobs.create(actor,randomUUID(),await f.snapshot([tool('tool-a')]),['tool-a']);
 const conflict=async()=>{const first=await begin();await run();expect((await f.jobs.get(first.id)).state).toBe('SUCCEEDED');const card=await f.plugins.get('tool-a');await f.plugins.update(card!.id,{description:'Локальная правка',expectedVersion:1},actor);const job=await begin();await run();return f.jobs.get(job.id);};
 it('обычный import не пишет local override; explicit replace создаёт новую версию и сохраняет source mapping',async()=>{
  const job=await conflict();expect(job.state).toBe('NEEDS_INPUT');expect(job.items[0].replaceable).toBe(true);expect(job.items[0].expected?.version).toBe(2);
  const original=(await f.jobs.versions(job.source.repository))[0];await f.jobs.resolve(job.id,actor,importPlanDigest(job));await run();const saved=await f.jobs.get(job.id);expect(saved.state,saved.message).toBe('SUCCEEDED');
  const card=await f.plugins.get('tool-a');expect(card?.version).toBe(3);expect(card?.description).toBe('Описание 1.0.0');expect((await f.plugins.versions(card!.id)).map(v=>v.version)).toEqual([3,2,1]);
  expect((await f.jobs.versions(job.source.repository))[0]).toEqual(original);expect((await f.jobs.receipts(job.source.repository))[0].native_version).toBe(3);
 });
 it('устаревший digest и чужой actor не одобряют замену',async()=>{
  const job=await conflict();await expect(f.jobs.resolve(job.id,actor,'a'.repeat(64))).rejects.toMatchObject({status:409});await expect(f.jobs.resolve(job.id,'other@example.test',importPlanDigest(job))).rejects.toMatchObject({status:404});
  expect((await f.plugins.get('tool-a'))?.version).toBe(2);expect((await f.jobs.get(job.id)).state).toBe('NEEDS_INPUT');
 });
 it('ручная правка после replace approval не перезаписывается; новая проверка требует нового согласия',async()=>{
  const job=await conflict();await f.jobs.resolve(job.id,actor,importPlanDigest(job));const card=await f.plugins.get('tool-a');await f.plugins.update(card!.id,{description:'Следующая правка',expectedVersion:2},actor);await run();
  expect((await f.jobs.get(job.id)).state).toBe('NEEDS_INPUT');expect((await f.plugins.get('tool-a'))?.description).toBe('Следующая правка');
  await f.jobs.retry(job.id,actor);await run();const next=await f.jobs.get(job.id);expect(next.items[0].expected?.version).toBe(3);expect(next.items[0].replaceable).toBe(true);expect(next.replacement_hashes).toEqual({});
 });
 it('name collision требует явного выбора и сохраняет прежний локальный native ID/history',async()=>{
  const publication=toToolPublication(tool('tool-a').asset as Parameters<typeof toToolPublication>[0]);
  const local=await f.plugins.create({...publication,description:'Моя карточка'},actor),job=await begin();await run();const preview=await f.jobs.get(job.id);expect(preview.items[0].replaceable).toBe(true);
  await f.jobs.resolve(job.id,actor,importPlanDigest(preview));await run();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');expect((await f.plugins.get('tool-a'))?.id).toBe(local.id);expect(await f.plugins.versions(local.id)).toHaveLength(2);
 });
 it('server planned ID collision не перезаписывает существующую карточку',async()=>{
  const plannedId='ai-plug-'+randomUUID(),first=toToolPublication(tool('first').asset as Parameters<typeof toToolPublication>[0]);
  const saved=await f.plugins.create(first,actor,undefined,undefined,false,plannedId);
  await expect(f.plugins.create(toToolPublication(tool('second').asset as Parameters<typeof toToolPublication>[0]),actor,undefined,undefined,false,plannedId)).rejects.toMatchObject({status:409});
  expect(await f.plugins.get('second')).toBeNull();expect((await f.plugins.get(plannedId))?.name).toBe(saved.name);expect(await f.plugins.versions(plannedId)).toHaveLength(1);
 });
 it('изменение receipt revision после preview блокирует принятие источника при прежнем native SHA',async()=>{
  const ingest=new LocalAssetIngest(f.pool,f.blobs),local=tool('local-origin'),prepared=await ingest.prepare(local.asset as never,[],randomUUID());
  const card=await f.plugins.create(prepared.publication,actor,async(client,created)=>{await ingest.record(client,prepared,created,actor);});
  const upstream=tool('public-origin');upstream.asset.card.name=local.asset.card.name;upstream.sha256=assetDigest(serializeAsset(upstream.asset));
  const job=await f.jobs.create(actor,randomUUID(),await f.snapshot([upstream]),[upstream.asset.id]);await run();
  const preview=await f.jobs.get(job.id),original=(await f.jobs.receipts('local-archive'))[0];
  expect(preview.state).toBe('NEEDS_INPUT');expect(preview.items[0].originReceipts).toEqual([{repository:'local-archive',externalId:local.asset.id,revision:1}]);
  await f.jobs.resolve(job.id,actor,importPlanDigest(preview));
  const load=f.blobs.importAsset.bind(f.blobs);
  vi.spyOn(f.blobs,'importAsset').mockImplementationOnce(async(...args)=>{
   const bytes=await load(...args);
   // Другой процесс меняет только происхождение после последней проверки плана.
   await f.pool.query('UPDATE asset_source_receipts SET revision=revision+1 WHERE repository=$1 AND external_id=$2',['local-archive',local.asset.id]);return bytes;
  });
  await run();const blocked=await f.jobs.get(job.id),receipt=(await f.jobs.receipts('local-archive'))[0];
  expect(blocked.state,blocked.message).toBe('NEEDS_INPUT');expect(blocked.message).toContain('Источник карточки изменился');
  expect(receipt).toMatchObject({active:true,revision:2,native_hash:original.native_hash});
  expect(await f.jobs.receipts(f.pin.repository)).toEqual([]);expect(await f.plugins.get(card.id)).toEqual(card);expect(await f.plugins.versions(card.id)).toHaveLength(1);
  await f.jobs.retry(job.id,actor);await run();const fresh=await f.jobs.get(job.id);
  expect(fresh.items[0].originReceipts).toEqual([{repository:'local-archive',externalId:local.asset.id,revision:2}]);
  await f.jobs.resolve(job.id,actor,importPlanDigest(fresh));await run();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');
  expect((await f.jobs.receipts('local-archive'))[0].active).toBe(false);expect((await f.jobs.receipts(f.pin.repository))[0].native_hash).toBe(original.native_hash);
 });
});
