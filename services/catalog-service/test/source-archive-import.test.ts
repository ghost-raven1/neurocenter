import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ConflictException} from '@nestjs/common';
import {assetDigest,serializeAsset,type ResolvedAsset,type ToolAsset} from '@neurocenter/asset-contract';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable,PassThrough} from 'node:stream';
import * as tar from 'tar';
import {actor,databaseFixture,tool} from './asset-import-db.fixture';
import {AssetSourceSnapshots} from '../src/asset-sources/source-snapshots';
import {AssetSourceArchiveUploads} from '../src/asset-sources/source-archive-upload';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import {sourceSupplyViews} from '../src/asset-sources/source-supply-view';
import {AssetImportWorker} from '../src/asset-sources/import-worker';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import {SourceMetadataCache} from '../src/asset-sources/source-cache';
import {readSourceArchive} from '../src/asset-sources/source-archive-reader';
import {publicationHash} from '../src/publication/publication-validation';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';

const signal=()=>new AbortController().signal;
const binary=Buffer.from('fixture pinned binary'),binarySha=assetDigest(binary);
function binaryRecord():ResolvedAsset{
 const base=tool('binary').asset as ToolAsset,asset:ToolAsset={...base,card:{...base.card,files:[],config:{}},delivery:{type:'runtime-artifacts',artifacts:[{url:'https://github.com/example/fixture/releases/download/v1/test.tar.gz',descriptor:{sha256:binarySha,target:'darwin-arm64',compressedBytes:binary.length,unpackedBytes:1,filesCount:1,entrypoint:'index.mjs'}}]}};
 return {...tool('binary'),asset,sha256:assetDigest(serializeAsset(asset))};
}
describe('Архив → проверенный источник → выборочный cache-only импорт, реальные FS и PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>,supply:string;
 beforeEach(async()=>{f=await databaseFixture();supply=path.join(f.root,'supply');await fs.mkdir(supply);});
 afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();});
 async function archive(records=[tool('inline')],options:{offline?:boolean;blobs?:boolean;badBlob?:boolean;recipe?:boolean;missingRecipe?:boolean}={}){
  const directory=path.join(f.root,randomUUID());await fs.mkdir(directory);
  const files=new Map<string,Buffer>();
  if(options.recipe){const recipe='A pinned recipe\n';records=records.map(record=>{const asset={...record.asset,recipe:{path:'recipes/build.md',sha256:assetDigest(recipe)}};return {...record,asset,sha256:assetDigest(serializeAsset(asset))};});if(!options.missingRecipe)files.set('recipes/build.md',Buffer.from(recipe));}
  const index=JSON.stringify({schemaVersion:1,assets:records.map(({asset,sha256,path,current})=>({id:asset.id,kind:asset.kind,version:asset.version,sha256,path,current}))})+'\n';
  files.set('index.json',Buffer.from(index));for(const record of records)files.set(record.path,Buffer.from(serializeAsset(record.asset)));
  for(const [name,bytes]of files){const relative=options.offline?'.asset-source-metadata/'+assetDigest(bytes)+'.json':name;await fs.mkdir(path.dirname(path.join(directory,relative)),{recursive:true});await fs.writeFile(path.join(directory,relative),bytes);}
  if(options.blobs||options.badBlob){await fs.mkdir(path.join(directory,'.asset-source-blobs'));await fs.writeFile(path.join(directory,'.asset-source-blobs',binarySha+'.blob'),options.badBlob?Buffer.from('damaged'):binary);}
  const filename=path.join(f.root,randomUUID()+'.tgz');await tar.c({cwd:directory,file:filename,gzip:true,portable:true,prefix:'neurocenter-assets-main'},['.']);
  const bytes=await fs.readFile(filename),pin={...f.pin,index:{path:'index.json',sha256:assetDigest(index)}};
  const request=vi.fn(async()=>{throw Error('GitHub must not be used');}),sources=new AssetSourceSnapshots(f.pool,pin,request);
  return {bytes,pin,index,records,sources,request,upload:new AssetSourceArchiveUploads(f.pool,sources,supply)};
 }
 async function receive(a:Awaited<ReturnType<typeof archive>>){await a.upload.receive(actor,Readable.from([a.bytes]),String(a.bytes.length),signal());}
 async function unchanged(){expect((await f.pool.query('SELECT * FROM asset_source_snapshots')).rows).toEqual([]);expect((await f.pool.query('SELECT * FROM asset_source_jobs')).rows).toEqual([]);expect((await f.pool.query('SELECT * FROM asset_source_blobs')).rows).toEqual([]);expect(await fs.readdir(supply)).toEqual([]);}

 it('Репозиторий с wrapper и рецептами принимается по известному index SHA без сети и создания карточек; повтор immutable',async()=>{
  const a=await archive(undefined,{recipe:true});await receive(a);const first=await a.sources.latest();
  expect(first?.pin).toEqual(a.pin);expect(first?.archive_sha256).toBe(assetDigest(a.bytes));expect(first?.assets).toEqual(a.records);expect(a.request).not.toHaveBeenCalled();
  expect((await f.pool.query('SELECT * FROM ai_plugins')).rows).toEqual([]);expect((await f.pool.query('SELECT * FROM asset_source_blobs')).rows).toEqual([]);
  const files=await fs.readdir(path.join(supply,'.asset-source-metadata'));expect(files).toHaveLength(3);
  await receive(a);expect((await f.pool.query('SELECT * FROM asset_source_snapshots')).rows).toHaveLength(1);expect(await fs.readdir(path.join(supply,'.asset-source-metadata'))).toEqual(files);
  expect((await fs.readdir(supply)).some(name=>name.startsWith('.asset-source-upload-'))).toBe(false);
 });
 it('Публичный view возвращает archive origin/supply; выбор inline карточки идёт через обычный worker один раз',async()=>{
  const a=await archive();await receive(a);
  const service=Object.assign(Object.create(AssetSourcesService.prototype) as AssetSourcesService,{pool:f.pool,sources:a.sources,jobs:f.jobs,blobs:new AssetBlobStore(f.pool,path.join(supply,'.asset-source-blobs')),worker:{kick:vi.fn()}});
  const before=await service.view();expect(before.source.archiveSha256).toBe(assetDigest(a.bytes));expect(before.assets[0].supply).toEqual({ready:true,missingFiles:0,missingBytes:0});
  expect(JSON.stringify(before)).not.toMatch(/index\.mjs|\.asset-source-|upstream/);
  const job=await service.start(actor,{requestKey:randomUUID(),ids:['inline'],commit:a.pin.commit});expect((await f.jobs.get(job.id)).cache_only).toBe(true);
  const worker=f.worker();try{await worker.flush();}finally{await worker.stop();}
  const completed=await f.jobs.get(job.id);expect(completed.state).toBe('SUCCEEDED');expect((await f.pool.query('SELECT * FROM ai_plugins')).rows).toHaveLength(1);expect((await service.view()).assets[0].imported).toMatchObject({id:completed.items[0].native!.id,version:1});expect(a.request).not.toHaveBeenCalled();
 });
 it('Обычный архив без binary показывает missing supply по dependency closure; inline готов',async()=>{
  const b=binaryRecord(),aRecord=tool('depends','1.0.0',[{id:b.asset.id,version:b.asset.version,sha256:b.sha256}]);
  const a=await archive([aRecord,b,tool('inline')]);await receive(a);
  const request=vi.fn(async()=>new Response(binary)),blobs=new AssetBlobStore(f.pool,path.join(supply,'.asset-source-blobs'),request,false),views=await sourceSupplyViews(a.records,blobs);
  expect(views.get('depends')).toEqual({ready:false,missingFiles:1,missingBytes:binary.length});expect(views.get('inline')).toEqual({ready:true,missingFiles:0,missingBytes:0});
  await expect(blobs.importAsset(b.asset,randomUUID(),signal(),true)).rejects.toMatchObject({status:409});expect(request).not.toHaveBeenCalled();
 });
 it('Архив полной offline-папки публикует проверенные blobs без DB registry; обычный import регистрирует их без сети',async()=>{
  const a=await archive([binaryRecord()],{offline:true,blobs:true});await receive(a);
  expect((await f.pool.query('SELECT * FROM asset_source_blobs')).rows).toEqual([]);
  const request=vi.fn(async()=>{throw Error('Network forbidden');}),blobs=new AssetBlobStore(f.pool,path.join(supply,'.asset-source-blobs'),request,false);
  expect((await sourceSupplyViews(a.records,blobs)).get('binary')?.ready).toBe(true);
  expect((await blobs.importAsset(a.records[0].asset,randomUUID(),signal(),true))[0].sha256).toBe(binarySha);expect(request).not.toHaveBeenCalled();
  const offline=new AssetSourceSnapshots(f.pool,{...a.pin,index:{path:'index.json',sha256:'f'.repeat(64)}},request,{offline:true,cache:new SourceMetadataCache(path.join(supply,'.asset-source-metadata'))});
  await offline.refresh();expect((await offline.latest())?.archive_sha256).toBe(assetDigest(a.bytes));expect(request).not.toHaveBeenCalled();
 });
 it('Сохранённый pin принимается без compiled pin; commit не берётся из wrapper/названия архива',async()=>{
  const a=await archive();await f.snapshot(a.records);await f.pool.query('UPDATE asset_source_snapshots SET pin=$1',[JSON.stringify(a.pin)]);
  const saved=new AssetSourceSnapshots(f.pool,undefined,a.request);await new AssetSourceArchiveUploads(f.pool,saved,supply).receive(actor,Readable.from([a.bytes]),String(a.bytes.length),signal());
  expect((await saved.latest())?.pin.commit).toBe(f.pin.commit);expect((await saved.latest())?.archive_sha256).toBe(assetDigest(a.bytes));expect(a.request).not.toHaveBeenCalled();
 });
 it('Неизвестный index SHA не публикует cache, snapshot, jobs или карточки',async()=>{
  const a=await archive(),unknown=new AssetSourceSnapshots(f.pool,{...a.pin,index:{path:'index.json',sha256:'f'.repeat(64)}},a.request);
  await expect(new AssetSourceArchiveUploads(f.pool,unknown,supply).receive(actor,Readable.from([a.bytes]),String(a.bytes.length),signal())).rejects.toThrow('не совпадает');await unchanged();expect(a.request).not.toHaveBeenCalled();
 });
 it('Отсутствующий рецепт и повреждённый SHA blob отклоняются до публикации metadata',async()=>{
  for(const options of [{recipe:true,missingRecipe:true},{badBlob:true}]){const a=await archive(undefined,options);await expect(receive(a)).rejects.toMatchObject({status:409});await unchanged();expect(a.request).not.toHaveBeenCalled();}
 });
 it('Известный pin не разрешает удаление ранее опубликованной истории',async()=>{
  const a=await archive([tool('inline','1.0.0')]);await f.snapshot([tool('inline','2.0.0')],'c'.repeat(40));const before=await a.sources.latest();
  await expect(receive(a)).rejects.toThrow('удалил');expect(await a.sources.latest()).toEqual(before);expect(await fs.readdir(supply)).toEqual([]);
 });
 it('Историческая версия с отсутствующей точной зависимостью отклоняется, даже если current граф исправен',async()=>{
  const old=tool('inline','1.0.0',[{id:'missing',version:'1.0.0',sha256:'f'.repeat(64)}],false),a=await archive([old,tool('inline','2.0.0')]);
  await expect(receive(a)).rejects.toThrow('зависимости');await unchanged();
 });
 it('Отзыв admin во время разбора останавливает cache и snapshot publication',async()=>{
  const a=await archive(),parse=async(...args:Parameters<typeof readSourceArchive>)=>{const result=await readSourceArchive(...args);await f.pool.query('UPDATE platform_users SET is_main_admin=false');return result;};
  await expect(new AssetSourceArchiveUploads(f.pool,a.sources,supply,8*1024**3,parse).receive(actor,Readable.from([a.bytes]),String(a.bytes.length),signal())).rejects.toMatchObject({status:403});await unchanged();
 });
 it('Отзыв admin во время cache publication откатывает snapshot; проверенные public SHA-файлы не становятся карточками',async()=>{
  const a=await archive(),link=fs.link.bind(fs);vi.spyOn(fs,'link').mockImplementation(async(...args)=>{await link(...args);await f.pool.query('UPDATE platform_users SET is_main_admin=false');});
  await expect(receive(a)).rejects.toMatchObject({status:403});expect(await a.sources.latest()).toBeUndefined();expect((await f.pool.query('SELECT * FROM ai_plugins')).rows).toEqual([]);
  expect((await fs.readdir(supply)).some(name=>name.startsWith('.asset-source-upload-'))).toBe(false);
 });
 it('Ссылка вместо metadata cache не перезаписывает посторонние файлы',async()=>{
  const a=await archive(),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'preserve'),'untouched');
  await fs.symlink(outside,path.join(supply,'.asset-source-metadata'));
  await expect(receive(a)).rejects.toMatchObject({status:409});expect(await a.sources.latest()).toBeUndefined();expect(await fs.readFile(path.join(outside,'preserve'),'utf8')).toBe('untouched');
 });
 it('Задание сохраняет cache-only через refresh, retry и worker, старые online request hashes остаются прежними',async()=>{
  const a=await archive();await receive(a);const key=randomUUID(),job=await f.jobs.create(actor,key,a.pin,['inline']);expect(job.cache_only).toBe(true);
  expect((await f.jobs.create(actor,key,a.pin,['inline'])).id).toBe(job.id);
  const request=vi.fn(async()=>new Response(binary)),blobs=new AssetBlobStore(f.pool,path.join(supply,'.asset-source-blobs'),request,false),supplyCall=vi.spyOn(blobs,'importAsset').mockRejectedValue(new ConflictException('missing archive supply'));
  const worker=new AssetImportWorker(f.pool,f.jobs,a.sources,blobs,{} as RuntimeArtifacts);try{await worker.flush();}finally{await worker.stop();}
  expect(supplyCall).toHaveBeenCalledWith(expect.anything(),expect.any(String),expect.any(AbortSignal),true);expect((await f.jobs.get(job.id)).state).toBe('NEEDS_INPUT');
  await f.pool.query('UPDATE asset_source_snapshots SET archive_sha256=NULL');const retried=await f.jobs.retry(job.id,actor);expect(retried.cache_only).toBe(true);expect(request).not.toHaveBeenCalled();
  expect(await f.jobs.create(actor,key,a.pin,['inline'])).toEqual(retried);
  const onlineKey=randomUUID(),online=await f.jobs.create(actor,onlineKey,a.pin,['inline']);expect(online.cache_only).toBe(false);
  await receive(a);expect(await f.jobs.create(actor,onlineKey,a.pin,['inline'],undefined,true)).toEqual(online);expect((await f.jobs.get(job.id)).cache_only).toBe(true);
 });
 it('Только явный online refresh очищает archive origin; прежние jobs остаются cache-only',async()=>{
  const a=await archive();await receive(a);const job=await f.jobs.create(actor,randomUUID(),a.pin,['inline']);
  const files=new Map([['https://api.github.com/repos/'+a.pin.repository+'/git/ref/heads/main',JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:a.pin.commit}})],['https://raw.githubusercontent.com/'+a.pin.repository+'/'+a.pin.commit+'/index.json',a.index],...a.records.map(record=>['https://raw.githubusercontent.com/'+a.pin.repository+'/'+a.pin.commit+'/'+record.path,serializeAsset(record.asset)] as [string,string])]);
  const request=vi.fn(async(url:string|URL|Request)=>new Response(files.get(String(url))??null,{status:files.has(String(url))?200:404}));
  await new AssetSourceSnapshots(f.pool,a.pin,request).refresh();expect((await a.sources.latest())?.archive_sha256).toBeNull();expect((await f.jobs.get(job.id)).cache_only).toBe(true);
  const online=await f.jobs.create(actor,randomUUID(),a.pin,['inline']);expect(online.cache_only).toBe(false);expect(online.request_hash).toBe(publicationHash({source:a.pin,ids:['inline']}));
 });
 it('Ограничения размера, неверный Content-Length, обрыв потока и abort удаляют собственный staging',async()=>{
  const a=await archive(),small=new AssetSourceArchiveUploads(f.pool,a.sources,supply,4);
  await expect(small.receive(actor,Readable.from([Buffer.from('12345')]),undefined,signal())).rejects.toMatchObject({status:413});await unchanged();
  await expect(a.upload.receive(actor,Readable.from([a.bytes]),String(a.bytes.length+1),signal())).rejects.toMatchObject({status:400});await unchanged();
  const input=Readable.from((async function*(){yield Buffer.from('partial');throw Error('private server path');})());
  await expect(a.upload.receive(actor,input,undefined,signal())).rejects.toMatchObject({status:400});await unchanged();
  const aborted=new AbortController();aborted.abort();await expect(a.upload.receive(actor,new PassThrough(),undefined,aborted.signal)).rejects.toMatchObject({status:400});await unchanged();
 });
 it('Параллельные загрузки ограничены; отмена двух потоков освобождает слоты и staging',async()=>{
  const a=await archive(),controllers=[new AbortController(),new AbortController()];
  const pending=controllers.map(controller=>a.upload.receive(actor,new PassThrough(),undefined,controller.signal));const observed=Promise.allSettled(pending);
  await expect(a.upload.receive(actor,Readable.from([a.bytes]),String(a.bytes.length),signal())).rejects.toMatchObject({status:409});controllers.forEach(controller=>controller.abort());
  expect((await observed).every(result=>result.status==='rejected')).toBe(true);await unchanged();await receive(a);expect((await a.sources.latest())?.archive_sha256).toBeTruthy();
 });
 it('Ошибка удаления staging не удерживает active slots для следующих загрузок',async()=>{
  const a=await archive(),remove=fs.rm.bind(fs),failure=vi.spyOn(fs,'rm').mockImplementation(async(filename,options)=>{
   if(path.basename(String(filename)).startsWith('.asset-source-upload-'))throw Error('fixture staging cleanup failed');await remove(filename,options);
  });
  for(let attempt=0;attempt<2;attempt++)await expect(receive(a)).rejects.toThrow('fixture staging cleanup failed');
  failure.mockRestore();await receive(a);expect((await a.sources.latest())?.archive_sha256).toBe(assetDigest(a.bytes));
 });
});
