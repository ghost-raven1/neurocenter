import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { assetDigest, serializeAsset, type ResolvedAsset, type SkillAsset } from '@neurocenter/asset-contract';
import { FsSkillsStorage } from '../../skills-service/src/storage/fs-skills-storage';
import { SkillsService } from '../../skills-service/src/skills/skills.service';
import { SkillAssetImportController } from '../../skills-service/src/skills/asset-import.controller';
import { SkillAssetAdapter, SkillAssetClient } from '../src/asset-sources/skill-adapter';
import { reserveSkillDependencies } from '../src/publication/skill-dependency-registry';
import { AssetManagementService } from '../src/asset-sources/asset-management.service';
import type { AssetSourcesService } from '../src/asset-sources/asset-sources.service';
import { actor, databaseFixture, tool } from './asset-import-db.fixture';

const token='test-internal-token';
function skill(dependency:ResolvedAsset):ResolvedAsset {
 const asset:SkillAsset={schemaVersion:1,id:'skill-a',kind:'skill',version:'1.0.0',source:{type:'git',repository:'https://github.com/example/fixture',commit:'a'.repeat(40)},license:{spdx:'MIT'},compatibility:{packageFormat:5},
  card:{path:'common',slug:'helper',name:'Полезный помощник',body:'Инструкция',meta:{description:'Описание'},resources:[{path:'references/guide.md',content:'Справочник'}]},delivery:{type:'inline'},dependencies:[{id:dependency.asset.id,version:dependency.asset.version,sha256:dependency.sha256}]};
 return {asset,sha256:assetDigest(serializeAsset(asset)),path:'assets/skill-a/1.0.0/asset.json',current:true};
}
describe('Cross-service durable skill: real FS journal + real isolated SQL',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>,storage:FsSkillsStorage,service:SkillsService,controller:SkillAssetImportController;
 let loseAck=false;const workers:ReturnType<Awaited<ReturnType<typeof databaseFixture>>['worker']>[]=[];
 beforeEach(async()=>{f=await databaseFixture();vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);storage=new FsSkillsStorage(path.join(f.root,'skills'),async entries=>{await reserveSkillDependencies(f.pool,{entries});},async()=>undefined);service=new SkillsService(storage);controller=new SkillAssetImportController(service);loseAck=false;
  vi.stubGlobal('fetch',async(url:string|URL|Request,options?:RequestInit)=>{
   const request={headers:{'x-neurocenter-internal':(options?.headers as Record<string,string>)?.['x-neurocenter-internal']}} as Request,body=options?.body?JSON.parse(String(options.body)):undefined,method=String(url).split('/').at(-1);
   try{const value=method==='preview'?await controller.preview(request,body):method==='inspect'?await controller.inspect(request,body):method==='archive'?await controller.archive(request,body):await controller.publish(request,body);
    if(method==='publish'&&loseAck){loseAck=false;throw new Error('Lost ACK');}return new Response(JSON.stringify(value),{status:200});
   }catch(error){if((error as Error).message==='Lost ACK'){throw error;}return new Response(JSON.stringify({message:(error as Error).message}),{status:(error as {status?:number}).status??500});}
  });
 });
 afterEach(async()=>{vi.restoreAllMocks();await Promise.all(workers.splice(0).map(w=>w.stop()));await storage?.onModuleDestroy();vi.unstubAllGlobals();vi.unstubAllEnvs();await f?.dispose();});
 const run=async()=>{const worker=f.worker(new SkillAssetAdapter(new SkillAssetClient()));workers.push(worker);await worker.flush();};
 const begin=async()=>{const dependency=tool('dependency'),record=skill(dependency),source=await f.snapshot([dependency,record]);return f.jobs.create(actor,randomUUID(),source,['skill-a']);};
 it('потеря ACK после FS commit возвращает PARTIAL и retry не создаёт второй skill/version',async()=>{
  const job=await begin();loseAck=true;await run();const partial=await f.jobs.get(job.id);expect(partial.state).toBe('PARTIAL');expect(partial.items.map(item=>item.state)).toEqual(['SUCCEEDED','FAILED']);
  expect((await service.getSkill('common/helper')).meta.version).toBe(1);expect(await f.jobs.versions(job.source.repository)).toHaveLength(1);
  await f.jobs.retry(job.id,actor);await run();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');const file=await service.getSkill('common/helper');expect(file.meta.version).toBe(1);expect(file.meta.history).toHaveLength(1);expect(file.resources).toHaveLength(1);expect(file.meta.dependencies?.[0].id).toBe((await f.plugins.get('dependency'))?.id);
 });
 it('SQL receipt failure после FS commit восстанавливается тем же intent и сохраняет resource/history',async()=>{
  const job=await begin(),original=f.jobs.receipt.bind(f.jobs);let fail=true;vi.spyOn(f.jobs,'receipt').mockImplementation(async(client,job,item,blobs)=>{if(item.resolved.asset.kind==='skill'&&fail){fail=false;throw new Error('receipt unavailable');}return original(client,job,item,blobs);});
  await run();expect((await f.jobs.get(job.id)).state).toBe('PARTIAL');expect((await service.getSkill('common/helper')).meta.version).toBe(1);await f.jobs.retry(job.id,actor);await run();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');expect((await service.getSkill('common/helper')).meta.version).toBe(1);
 });
 it('archive lost ACK и повтор защищены persisted marker; источник сохраняет старые immutable snapshots',async()=>{
  const job=await begin();await run();expect((await f.jobs.get(job.id)).state).toBe('SUCCEEDED');
  const management=new AssetManagementService({pool:f.pool,catalogReady:async()=>undefined} as unknown as AssetSourcesService);await management.onModuleInit();
  const preview=await management.impact(actor,{kind:'skill',id:'common/helper'}),body={impactId:preview.impactId,expectedDigest:preview.digest,mode:'catalog-only'};
  const original=f.pool.query.bind(f.pool);let fail=true;
  // Один SQL-этап после подтверждённого FS archive обрывается; повтор использует marker того же impact.
  const client=await f.pool.connect();client.release();const query=client.query.bind(client);vi.spyOn(client,'query').mockImplementation(async(...args:unknown[])=>{if(String(args[0]).startsWith('UPDATE asset_source_receipts')&&fail){fail=false;throw new Error('SQL commit fault');}return query(...args as Parameters<typeof client.query>);});
  const partial=await management.archive(actor,body);expect(partial.state).toBe('PARTIAL');expect((await service.getSkill('common/helper')).meta.version).toBe(2);
  expect((await management.archive(actor,body)).state).toBe('SUCCEEDED');expect((await service.getSkill('common/helper')).meta.version).toBe(2);expect((await service.getSkill('common/helper',1)).resources).toHaveLength(1);
  expect((await original('SELECT * FROM asset_source_versions')).rows).toHaveLength(2);
  const archived=await management.impact(actor,{kind:'skill',id:'common/helper'});
  expect((await management.archive(actor,{impactId:archived.impactId,expectedDigest:archived.digest,mode:'restore'})).state).toBe('SUCCEEDED');
  expect((await service.getSkill('common/helper')).meta.version).toBe(3);expect(await service.listSkills({})).toHaveLength(1);
  const again=await begin();await run();expect((await f.jobs.get(again.id)).state).toBe('SUCCEEDED');expect((await service.getSkill('common/helper')).meta.version).toBe(3);
 });
});
