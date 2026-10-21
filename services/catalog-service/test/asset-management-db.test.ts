import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';
import { AssetManagementService } from '../src/asset-sources/asset-management.service';
import type { AssetSourcesService } from '../src/asset-sources/asset-sources.service';
import { ProjectAssetRepository } from '../src/catalog/project-asset-repository';

describe('Архив карточек: real PostgreSQL impact/CAS и сохранение immutable pins',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>,management:AssetManagementService,id:string;
 beforeEach(async()=>{f=await databaseFixture();management=new AssetManagementService({pool:f.pool,catalogReady:async()=>undefined} as unknown as AssetSourcesService);await management.onModuleInit();
  const job=await f.jobs.create(actor,randomUUID(),await f.snapshot([tool('tool-a')]),['tool-a']),worker=f.worker();await worker.flush();await worker.stop();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');id=(await f.plugins.get('tool-a'))!.id;
  await f.pool.query("INSERT INTO projects(id,name) VALUES('prj-one','Первый проект'),('prj-two','Второй проект')");
 });afterEach(async()=>{await f?.dispose();});
 const impact=()=>management.impact(actor,{kind:'plugin',id});
 const apply=async(mode='catalog-only')=>{const preview=await impact();return management.archive(actor,{impactId:preview.impactId,expectedDigest:preview.digest,mode});};
 it('catalog-only сохраняет projectrefs/versions/source receipts и скрывает только общий head',async()=>{
  const projects=new ProjectAssetRepository(f.pool);await projects.add('prj-one',id,'plugin',actor);const versions=await f.plugins.versions(id),receipts=await f.jobs.versions(f.pin.repository);
  const preview=await impact();expect(preview.projects.map(p=>p.name)).toEqual(['Первый проект']);expect((await apply()).state).toBe('SUCCEEDED');
  expect((await f.plugins.list(1,50,'')).items).toEqual([]);expect((await f.plugins.list(1,50,'',[id])).items).toHaveLength(1);
  expect((await f.pool.query('SELECT * FROM project_assets')).rows).toHaveLength(1);expect(await f.plugins.versions(id)).toEqual(versions);expect(await f.jobs.versions(f.pin.repository)).toEqual(receipts);
  await expect(projects.add('prj-two',id,'plugin',actor)).rejects.toMatchObject({status:409});expect((await f.plugins.get(id))?.archivedAt).toBeTruthy();
 });
 it('явный catalog-and-projects удаляет только project refs, не snapshots/bytes; retry идемпотентен',async()=>{
  await new ProjectAssetRepository(f.pool).add('prj-one',id,'plugin',actor);const preview=await impact(),body={impactId:preview.impactId,expectedDigest:preview.digest,mode:'catalog-and-projects'};
  const results=await Promise.all([management.archive(actor,body),management.archive(actor,body)]);expect(results.map(row=>row.state)).toEqual(['SUCCEEDED','SUCCEEDED']);
  expect((await f.pool.query('SELECT * FROM project_assets')).rows).toEqual([]);expect(await f.plugins.versions(id)).toHaveLength(1);
  expect((await f.pool.query("SELECT * FROM security_events WHERE action='asset.archive'")).rows).toHaveLength(1);
  await expect(management.archive(actor,{...body,mode:'catalog-only'})).rejects.toMatchObject({status:409});
 });
 it('изменение card или refs после preview блокирует archive до writes',async()=>{
  const first=await impact();await f.plugins.update(id,{description:'Локальная правка',expectedVersion:1},actor);
  await expect(management.archive(actor,{impactId:first.impactId,expectedDigest:first.digest,mode:'catalog-only'})).rejects.toMatchObject({status:409});
  const second=await impact();await new ProjectAssetRepository(f.pool).add('prj-one',id,'plugin',actor);
  await expect(management.archive(actor,{impactId:second.impactId,expectedDigest:second.digest,mode:'catalog-and-projects'})).rejects.toMatchObject({status:409});
  expect((await f.plugins.get(id))?.archivedAt).toBeUndefined();expect((await f.pool.query('SELECT * FROM project_assets')).rows).toHaveLength(1);
 });
 it('foreign actor, bad digest, истекшая проверка и отозванные права не архивируют',async()=>{
  const p=await impact(),body={impactId:p.impactId,expectedDigest:p.digest,mode:'catalog-only'};
  await expect(management.archive('other@example.test',body)).rejects.toMatchObject({status:404});await expect(management.archive(actor,{...body,expectedDigest:'a'.repeat(64)})).rejects.toMatchObject({status:409});
  await f.pool.query("UPDATE asset_management_impacts SET expires_at=now()-interval '1 second'");await expect(management.archive(actor,body)).rejects.toMatchObject({status:409});
  const next=await impact();await f.pool.query('UPDATE platform_users SET is_main_admin=false');await expect(management.archive(actor,{...body,impactId:next.impactId,expectedDigest:next.digest})).rejects.toMatchObject({status:403});
  expect((await f.plugins.get(id))?.archivedAt).toBeUndefined();
 });
 it('старый DELETE не обходит refs guard и никогда не удаляет историю',async()=>{
  await new ProjectAssetRepository(f.pool).add('prj-one',id,'plugin',actor);await expect(f.plugins.delete(id,actor)).rejects.toMatchObject({status:409});
  await new ProjectAssetRepository(f.pool).remove('prj-one',id,'plugin',actor);expect(await f.plugins.delete(id,actor)).toBe(true);expect(await f.plugins.versions(id)).toHaveLength(1);expect((await f.plugins.get(id))?.archivedAt).toBeTruthy();
 });
});
