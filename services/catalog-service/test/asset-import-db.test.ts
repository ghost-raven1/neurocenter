vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';
import type { AssetImportWorker } from '../src/asset-sources/import-worker';
import { importView, type IImportJob } from '../src/asset-sources/import-types';
describe('Durable source → native в изолированной PostgreSQL schema',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>,workers:AssetImportWorker[]=[];
 beforeEach(async()=>{f=await databaseFixture();});afterEach(async()=>{vi.restoreAllMocks();await Promise.all(workers.map(w=>w.stop()));workers=[];await f?.dispose();});
 const run=async()=>{const worker=f.worker();workers.push(worker);await worker.flush();};
 const begin=async(ids=['tool-a'],records=[tool('tool-a')],key=randomUUID())=>f.jobs.create(actor,key,await f.snapshot(records),ids);
 const pair=()=>{const b1=tool('tool-b','1.0.0',[],false),b2=tool('tool-b','2.0.0'),a=tool('tool-a','1.0.0',[{id:'tool-b',version:'1.0.0',sha256:b1.sha256}]);return {b1,b2,a,all:[a,b1,b2]};};
 it('same intent, lost ACK и concurrent restart дают одну карточку/версию/receipt',async()=>{
  const key=randomUUID(),job=await begin(undefined,undefined,key);expect((await f.jobs.create(actor,key,job.source,['tool-a'])).id).toBe(job.id);
  const first=f.worker(),second=f.worker();workers.push(first,second);await Promise.all([first.flush(),second.flush()]);expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');await run();
  expect((await f.pool.query('SELECT * FROM ai_plugins')).rows).toHaveLength(1);expect((await f.pool.query('SELECT * FROM ai_plugin_versions')).rows).toHaveLength(1);expect(await f.jobs.versions(job.source.repository)).toHaveLength(1);
  await expect(f.jobs.create(actor,key,job.source,['other'])).rejects.toMatchObject({status:409});
 });
 it('lost ACK after the actual final PostgreSQL UPDATE preserves the exact durable SUCCEEDED receipt',async()=>{
  const job=await begin(),save=f.jobs.save.bind(f.jobs);let completed:IImportJob|undefined,lost=0;
  vi.spyOn(f.jobs,'save').mockImplementation(async(...args)=>{
   const saved=await save(...args);
   if(args[2]==='SUCCEEDED'&&!lost){lost++;completed=await f.jobs.get(job.id);throw new Error('Final UPDATE committed; acknowledgement lost');}
   return saved;
  });
  await run();expect(lost).toBe(1);expect(completed?.state).toBe('SUCCEEDED');expect(await f.jobs.get(job.id)).toEqual(completed);
  expect((await f.pool.query('SELECT * FROM ai_plugin_versions')).rows).toHaveLength(1);expect(await f.jobs.versions(job.source.repository)).toHaveLength(1);
  await expect(f.jobs.retry(job.id,actor)).rejects.toMatchObject({status:409});
 });
 it('a stale failure writer cannot overwrite a concurrently committed SUCCEEDED job or its items',async()=>{
  const stale=await begin();await run();const completed=await f.jobs.get(stale.id);
  const saved=await f.jobs.save(f.pool,stale,'PARTIAL','Late stale failure',stale.items);
  expect(saved).toEqual(completed);expect(await f.jobs.get(stale.id)).toEqual(completed);expect(completed.items[0].state).toBe('SUCCEEDED');
 });
 it('A→Bv1 и явно выбранный Bcurrentv2 сохраняют head2 и pin1',async()=>{
  const p=pair(),job=await begin(['tool-a','tool-b'],p.all);await run();const saved=await f.jobs.get(job.id);expect(saved.state,saved.message).toBe('SUCCEEDED');
  const b=await f.plugins.get('tool-b'),a=await f.plugins.get('tool-a');expect(b?.version).toBe(2);expect(a?.dependencies?.[0]).toMatchObject({id:b?.id,version:1});expect(await f.plugins.versions(b!.id)).toHaveLength(2);
 });
 it('только A: Bv1 становится head зависимости, Bv2 не добавляется',async()=>{
  const p=pair(),job=await begin(['tool-a'],p.all);await run();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');expect((await f.plugins.get('tool-b'))?.version).toBe(1);
  expect((await f.jobs.versions(job.source.repository)).map(row=>row.external_id+'@'+row.asset_version)).not.toContain('tool-b@2.0.0');
 });
 it('при локальном Bv2 старый Bv1 публикуется snapshot-only без изменения head; следующий ordinal монотонен',async()=>{
  const p=pair(),first=await begin(['tool-b'],[p.b2]);await run();expect((await f.jobs.get(first.id)).state).toBe('SUCCEEDED');const before=await f.plugins.get('tool-b');
  const job=await begin(['tool-a'],p.all);await run();const saved=await f.jobs.get(job.id);expect(saved.state,saved.message).toBe('SUCCEEDED');expect(await f.plugins.get('tool-b')).toEqual(before);
  expect((await f.plugins.get('tool-a'))?.dependencies?.[0]).toMatchObject({id:before!.id,version:2});expect((await f.plugins.versions(before!.id)).map(v=>v.version)).toEqual([2,1]);
  expect((await f.plugins.update(before!.id,{description:'Локальная правка',expectedVersion:1},actor))?.version).toBe(3);
 });
 it('local override останавливает весь preview до новых native writes',async()=>{
  await begin();await run();const current=await f.plugins.get('tool-a');await f.plugins.update(current!.id,{description:'Моя правка',expectedVersion:1},actor);
  const job=await begin(['tool-b','tool-a'],[tool('tool-a','2.0.0'),tool('tool-b')]);await run();expect((await f.jobs.get(job.id)).state).toBe('NEEDS_INPUT');expect(await f.plugins.get('tool-b')).toBeNull();
 });
 it('отказ receipt откатывает publication и history; retry создаёт ровно одну версию',async()=>{
  const job=await begin(),original=f.jobs.receipt.bind(f.jobs);vi.spyOn(f.jobs,'receipt').mockRejectedValueOnce(new Error('receipt fault'));await run();expect((await f.jobs.get(job.id)).state).toBe('FAILED');expect(await f.plugins.get('tool-a')).toBeNull();expect((await f.pool.query('SELECT * FROM ai_plugin_versions')).rows).toEqual([]);
  vi.mocked(f.jobs.receipt).mockImplementation(original);await f.jobs.retry(job.id,actor);await run();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');expect((await f.plugins.get('tool-a'))?.version).toBe(1);
 });
 it('отзыв роли/отмена не публикуют; view не раскрывает payload/upstreamURL',async()=>{
  const job=await begin();expect(JSON.stringify(importView(job))).not.toMatch(/https:|payload|index.mjs/);await f.pool.query('UPDATE platform_users SET is_main_admin=false');await run();expect((await f.jobs.get(job.id)).state).toBe('FAILED');expect(await f.plugins.get('tool-a')).toBeNull();
  await f.pool.query('UPDATE platform_users SET is_main_admin=true');const next=await begin();await f.jobs.cancel(next.id,actor);await run();expect((await f.jobs.get(next.id)).state).toBe('CANCELLED');expect(await f.plugins.get('tool-a')).toBeNull();
 });
});
