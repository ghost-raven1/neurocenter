import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetDigest, serializeAsset } from '@neurocenter/asset-contract';
import { databaseFixture, tool } from './asset-import-db.fixture';
import { AssetSourceSnapshots } from '../src/asset-sources/source-snapshots';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';

describe('Явное обновление доверенного source: metadata-only, immutable evolution, offline cache',()=>{
 let f:Awaited<ReturnType<typeof databaseFixture>>;beforeEach(async()=>{f=await databaseFixture();});afterEach(async()=>{await f?.dispose();});
 function remote(version='1.0.0',commit='a'.repeat(40)){
  const record=tool('source-tool',version),raw=serializeAsset(record.asset),entry={id:record.asset.id,kind:record.asset.kind,version,path:record.path,sha256:assetDigest(raw),current:true};
  const index=JSON.stringify({schemaVersion:1,assets:[entry]})+'\n',files=new Map([['https://api.github.com/repos/ghost-raven1/neurocenter-assets/git/ref/heads/main',JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:commit}})],
   ['https://raw.githubusercontent.com/ghost-raven1/neurocenter-assets/'+commit+'/index.json',index],['https://raw.githubusercontent.com/ghost-raven1/neurocenter-assets/'+commit+'/'+record.path,raw]]);
  const request=vi.fn(async(url:string|URL|Request)=>new Response(files.get(String(url))??null,{status:files.has(String(url))?200:404}));return {request,files,index,record,commit};
 }
 it('startup не читает сеть, refresh разрешает ref один раз и сохраняет exact index SHA без бинарников',async()=>{
  const r=remote(),sources=new AssetSourceSnapshots(f.pool,undefined,r.request);await sources.setup();expect(r.request).not.toHaveBeenCalled();
  const snapshot=await sources.refresh();expect(snapshot.pin.commit).toBe(r.commit);expect(snapshot.pin.index.sha256).toBe(assetDigest(r.index));expect(snapshot.assets).toHaveLength(1);
  expect(r.request.mock.calls.map(([url])=>String(url))).toEqual([...r.files.keys()]);expect((await sources.latest())?.pin).toEqual(snapshot.pin);
 });
 it('Большой commit diff не запрашивается даже при обновлении крупной поставки',async()=>{
  const r=remote(),sources=new AssetSourceSnapshots(f.pool,undefined,r.request);
  r.files.set('https://api.github.com/repos/ghost-raven1/neurocenter-assets/commits/main',JSON.stringify({sha:r.commit,files:[{patch:'x'.repeat(128*1024)}]}));
  expect((await sources.refresh()).pin.commit).toBe(r.commit);
  expect(r.request.mock.calls.every(([url])=>!String(url).includes('/commits/'))).toBe(true);
 });
 it.each([
  {ref:'refs/heads/other',object:{type:'commit',sha:'a'.repeat(40)}},
  {ref:'refs/heads/main',object:{type:'tag',sha:'a'.repeat(40)}},
  {ref:'refs/heads/main',object:{type:'commit',sha:'abc123'}},
  {sha:'a'.repeat(40)},
 ])('Не принимает другой ref, объект или сокращённый commit: %j',async reference=>{
  const sources=new AssetSourceSnapshots(f.pool,undefined,async()=>Response.json(reference));
  await expect(sources.refresh()).rejects.toMatchObject({status:409});expect(await sources.latest()).toBeUndefined();
 });
 it('Настоящий Fetch декодирует HTTP gzip commit/index/descriptor без ложного отказа Content-Length',async()=>{
  const r=remote(),files=new Map([...r.files].map(([url,body])=>[new URL(url).pathname,body]));
  const server=createServer((req,res)=>{
   const body=files.get(req.url||'');if(body===undefined){res.writeHead(404).end();return;}
   const bytes=gzipSync(body);res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip','content-length':bytes.length});res.end(bytes);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const address=server.address();if(!address||typeof address==='string')throw new Error('HTTP fixture failed');
   const sources=new AssetSourceSnapshots(f.pool,undefined,(url,options)=>fetch('http://127.0.0.1:'+address.port+new URL(String(url)).pathname,options));
   const snapshot=await sources.refresh();expect(snapshot.pin.commit).toBe(r.commit);expect(snapshot.pin.index.sha256).toBe(assetDigest(r.index));expect(snapshot.assets).toHaveLength(1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('Content-Length без HTTP-сжатия продолжает проверяться до сохранения metadata',async()=>{
  const r=remote(),request=async(url:string|URL|Request)=>new Response(r.files.get(String(url)),{headers:{'content-length':'1'}});
  const sources=new AssetSourceSnapshots(f.pool,undefined,request);await expect(sources.refresh()).rejects.toMatchObject({status:409});expect(await sources.latest()).toBeUndefined();
 });
 it('переписанный id/version отклоняется и не заменяет последнюю проверенную опись',async()=>{
  const first=remote(),sources=new AssetSourceSnapshots(f.pool,undefined,first.request),before=await sources.refresh(),next=remote('1.0.0','b'.repeat(40));
  const changed={...next.record.asset,card:{...next.record.asset.card,description:'Переписано'}},raw=serializeAsset(changed),index=JSON.stringify({schemaVersion:1,assets:[{id:changed.id,kind:changed.kind,version:changed.version,path:next.record.path,sha256:assetDigest(raw),current:true}]});
  next.files.set('https://raw.githubusercontent.com/ghost-raven1/neurocenter-assets/'+next.commit+'/'+next.record.path,raw);next.files.set('https://raw.githubusercontent.com/ghost-raven1/neurocenter-assets/'+next.commit+'/index.json',index);
  await expect(new AssetSourceSnapshots(f.pool,undefined,next.request).refresh()).rejects.toMatchObject({status:409});expect((await sources.latest())?.pin).toEqual(before.pin);
 });
 it.each([403,429,503])('offline/rate limit HTTP %s сохраняет last successful source и сообщает ошибку',async status=>{
  const r=remote(),before=await new AssetSourceSnapshots(f.pool,undefined,r.request).refresh(),sources=new AssetSourceSnapshots(f.pool,undefined,async()=>new Response(null,{status}));
  await expect(sources.refresh()).rejects.toMatchObject({status:503});const state=await sources.status();expect(state.snapshot?.pin).toEqual(before.pin);expect(state.last?.message).toBeTruthy();
 });
 it('битые UTF-8/JSON/oversized metadata не становятся проверенным source',async()=>{
  const sources=new AssetSourceSnapshots(f.pool,undefined,async()=>new Response('x'.repeat(65537)));
  await expect(sources.refresh()).rejects.toMatchObject({status:409});expect(await sources.latest()).toBeUndefined();
 });
});
