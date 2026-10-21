import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assetDigest, type ToolAsset } from '@neurocenter/asset-contract';
import { databaseFixture, tool } from './asset-import-db.fixture';
import { AssetBlobStore } from '../src/asset-sources/asset-blob-store';
const bytes=Buffer.from('fixture verified bytes'),sha=assetDigest(bytes),signal=()=>new AbortController().signal;
function asset():ToolAsset {const base=tool('binary').asset as ToolAsset;return {...base,card:{...base.card,files:[],config:{}},delivery:{type:'runtime-artifacts',artifacts:[{url:'https://github.com/example/fixture/releases/download/v1/test.tar.gz',descriptor:{sha256:sha,target:'darwin-arm64',compressedBytes:bytes.length,unpackedBytes:1,filesCount:1,entrypoint:'index.mjs'}}]}};}
describe('Серверный SHA supply cache: реальные tempfiles и isolated registry',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>,directory:string;
 beforeEach(async()=>{f=await databaseFixture();directory=path.join(f.root,'cache');});afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
 it('скачивает один раз, verify/open/repeat offline проверяют те же байты; URL не попадает в receipt',async()=>{
  const request=vi.fn(async()=>new Response(bytes)),store=new AssetBlobStore(f.pool,directory,request);const blobs=await store.importAsset(asset(),randomUUID(),signal());expect(request).toHaveBeenCalledOnce();expect(JSON.stringify(blobs)).not.toContain('https:');
  const cached=new AssetBlobStore(f.pool,directory,async()=>{throw new Error('Network запрещена');});expect(await cached.importAsset(asset(),randomUUID(),signal())).toEqual(blobs);
  const opened=await cached.open(sha),chunks=[];for await(const chunk of opened.stream){chunks.push(chunk);}expect(Buffer.concat(chunks)).toEqual(bytes);expect(opened.bytes).toBe(bytes.length);
  expect((await fs.readdir(directory))).toEqual([sha+'.blob']);
 });
 it('SHA/size/network error не регистрирует ready и убирает только собственный partial; retry работает',async()=>{
  const store=new AssetBlobStore(f.pool,directory,async()=>new Response('bad'));
  await expect(store.importAsset(asset(),randomUUID(),signal())).rejects.toThrow();expect((await f.pool.query('SELECT * FROM asset_source_blobs')).rows).toEqual([]);expect(await fs.readdir(directory)).toEqual([]);
  await expect(new AssetBlobStore(f.pool,directory,async()=>{throw new Error('Offline');}).importAsset(asset(),randomUUID(),signal())).rejects.toThrow();
  await new AssetBlobStore(f.pool,directory,async()=>new Response(bytes)).importAsset(asset(),randomUUID(),signal());expect((await f.pool.query('SELECT * FROM asset_source_blobs')).rows).toHaveLength(1);
 });
 it('повреждённый cache, symlink и hardlink не используются как проверенная поставка',async()=>{
  const store=new AssetBlobStore(f.pool,directory,async()=>new Response(bytes));await store.importAsset(asset(),randomUUID(),signal());const file=path.join(directory,sha+'.blob');
  await fs.chmod(file,0o600);await fs.writeFile(file,Buffer.alloc(bytes.length));await expect(store.open(sha)).rejects.toMatchObject({status:409});
  await fs.unlink(file);const outside=path.join(f.root,'outside');await fs.writeFile(outside,bytes);await fs.symlink(outside,file);await expect(store.open(sha)).rejects.toThrow();
  await fs.unlink(file);await fs.link(outside,file);await expect(store.open(sha)).rejects.toMatchObject({status:409});expect(await fs.readFile(outside)).toEqual(bytes);
 });
 it('abort до записи не подтверждает поставку, незарегистрированный SHA не отдаётся',async()=>{
  const cancellation=new AbortController();cancellation.abort();const request=vi.fn(async()=>new Response(bytes)),store=new AssetBlobStore(f.pool,directory,request);
  await expect(store.importAsset(asset(),randomUUID(),cancellation.signal)).rejects.toThrow();expect(request).not.toHaveBeenCalled();await expect(store.open(sha)).rejects.toMatchObject({status:404});
 });
 it('Автономный импорт не скачивает отсутствующий blob и не пишет registry; полный кэш принимается',async()=>{
  const request=vi.fn(async()=>new Response(bytes)),store=new AssetBlobStore(f.pool,directory,request,true);
  await expect(store.importAsset(asset(),randomUUID(),signal())).rejects.toThrow('локальной поставке');
  expect(request).not.toHaveBeenCalled();expect(await fs.readdir(directory)).toEqual([]);expect((await f.pool.query('SELECT * FROM asset_source_blobs')).rows).toEqual([]);
  await fs.writeFile(path.join(directory,sha+'.blob'),bytes,{mode:0o400});
  const blobs=await store.importAsset(asset(),randomUUID(),signal());expect(blobs[0].sha256).toBe(sha);expect(request).not.toHaveBeenCalled();
  expect((await f.pool.query('SELECT * FROM asset_source_blobs')).rows).toHaveLength(1);
 });
 it('Availability проверяет sparse multi-GiB файл через stat без чтения/хэширования; настоящий import отвергает повреждённые байты',async()=>{
  await fs.mkdir(directory);const filename=path.join(directory,sha+'.blob'),file=await fs.open(filename,'wx');
  await file.truncate(4*1024**3);const prototype=Object.getPrototypeOf(file);await file.close();
  const streaming=vi.spyOn(prototype,'createReadStream').mockImplementation(()=>{throw Error('Availability must not read bytes');});
  const store=new AssetBlobStore(f.pool,directory);expect(await store.hasLocalCandidate(sha,4*1024**3)).toBe(true);expect(streaming).not.toHaveBeenCalled();
  expect(await store.hasLocalCandidate(sha,7)).toBe(false);streaming.mockRestore();
  await fs.writeFile(filename,Buffer.alloc(bytes.length));expect(await store.hasLocalCandidate(sha,bytes.length)).toBe(true);
  await expect(store.importAsset(asset(),randomUUID(),signal(),true)).rejects.toMatchObject({status:409});
 });
});
