import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createServer,get} from 'node:http';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as wait} from 'node:timers/promises';
import {ForbiddenException} from '@nestjs/common';
import type {Request,Response} from 'express';
import * as tar from 'tar';
import {assetDigest,serializeAsset,type ToolAsset} from '@neurocenter/asset-contract';
import {AssetBlobStore} from '../src/asset-sources/asset-blob-store';
import type {ISourceReceipt} from '../src/asset-sources/import-types';
import {createToolSupply,toolSupplyPlan} from '../src/package-build/supply-export';
import {sendToolSupply} from '../src/package-build/supply-response';
import {PackageBuildService} from '../src/package-build/package-build.service';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {PackageBuildController} from '../src/package-build/package-build.controller';
const capacity=vi.hoisted(()=>({reserve:vi.fn(),release:vi.fn()}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:capacity.reserve}));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
let root:string,store:AssetBlobStore,receipt:ISourceReceipt,payloads:Map<string,Buffer>;
function resign(){receipt.descriptor_sha256=assetDigest(serializeAsset(receipt.descriptor));}
async function retain(bytes:Buffer){const digest=sha(bytes);payloads.set(digest,bytes);await fs.writeFile(path.join(root,'.asset-source-blobs',digest+'.blob'),bytes,{mode:0o400});return digest;}
async function assertClean(){expect(await fs.readdir(path.join(root,'.supply-export'))).toEqual([]);}
async function archiveBytes(){const result=await createToolSupply(toolSupplyPlan(receipt),store,new AbortController().signal);try{const chunks=[];for await(const chunk of result.stream)chunks.push(chunk);return Buffer.concat(chunks);}finally{await result.cleanup();}}
beforeEach(async()=>{
 vi.resetAllMocks();capacity.reserve.mockResolvedValue(capacity.release);root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-supply-export-'));vi.stubEnv('RUNTIME_ARTIFACT_DIR',root);
 await fs.mkdir(path.join(root,'.asset-source-blobs'));payloads=new Map();
 const runtime=Buffer.from('exact runtime archive bytes\0\xff'),source=Buffer.alloc(17*1024**2,173),runtimeSha=await retain(runtime),sourceSha=await retain(source);
 const artifact={sha256:runtimeSha,compressedBytes:runtime.length,unpackedBytes:100,filesCount:1,entrypoint:'bin/server',executable:true};
 const asset:ToolAsset={schemaVersion:1,id:'test-export',kind:'mcp',version:'1.0.0',source:{type:'archive',sha256:sourceSha,bytes:source.length},license:{spdx:'NOASSERTION'},compatibility:{packageFormat:5},card:{name:'Готовая поставка',kind:'mcp',description:'Проверяем перенос поставки',revision:'source-pinned',config:{transport:'stdio',args:[]},files:[]},delivery:{type:'runtime-artifacts',artifacts:[{descriptor:{...artifact,target:'darwin-arm64'}},{descriptor:{...artifact,target:'linux-x64-glibc'}}]}};
 receipt={repository:'local-archive',external_id:asset.id,asset_kind:asset.kind,asset_version:asset.version,descriptor_sha256:assetDigest(serializeAsset(asset)),descriptor:asset,source_commit:null,native_id:'tool-fixture',native_version:1,native_hash:'b'.repeat(64),imported_by:'fixture@example.test',blobs:[{sha256:runtimeSha,bytes:runtime.length,filename:runtimeSha+'.tar.gz'},{sha256:sourceSha,bytes:source.length,filename:sourceSha+'.source'}]};
 store=new AssetBlobStore({query:async(_sql:string,[digest]:string[])=>({rows:payloads.has(digest)?[{bytes:String(payloads.get(digest)!.length)}]:[]})} as never,path.join(root,'.asset-source-blobs'));
});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});vi.unstubAllEnvs();});

describe('Full supply preserves the existing immutable envelope',()=>{
 it('Exports canonical asset, exact 17MiB opaque source and each runtime SHA once with public headers',async()=>{
  const bytes=await archiveBytes(),archive=path.join(root,'download.tar.gz'),output=path.join(root,'unpacked');await fs.writeFile(archive,bytes);await fs.mkdir(output);
  const names:string[]=[];await tar.t({file:archive,onReadEntry:entry=>{names.push(entry.path);expect(entry.path.startsWith('/')).toBe(false);expect(entry.uname||'').toBe('');expect(entry.gname||'').toBe('');}});
  await tar.x({file:archive,cwd:output,strict:true});
  expect(await fs.readFile(path.join(output,'asset.json'),'utf8')).toBe(serializeAsset(receipt.descriptor));expect(assetDigest(await fs.readFile(path.join(output,'asset.json')))).toBe(receipt.descriptor_sha256);
  const plan=toolSupplyPlan(receipt);expect(plan.files).toHaveLength(2);expect(names.filter(name=>name.startsWith('artifacts/'))).toHaveLength(1);
  for(const file of plan.files){const saved=await fs.readFile(path.join(output,file.name));expect(saved.length).toBe(file.bytes);expect(sha(saved)).toBe(file.sha256);}
  const readme=await fs.readFile(path.join(output,'README.md'),'utf8');expect(readme).toContain('первой публикацией');expect(readme).not.toContain(root);expect(readme).not.toContain(receipt.imported_by);await assertClean();expect(capacity.release).toHaveBeenCalledOnce();
 });
 it('Includes a retained public recipe at its exact descriptor path',async()=>{
  const bytes=Buffer.from('{"schemaVersion":1,"key":"public-recipe"}\n'),digest=await retain(bytes);receipt.descriptor.recipe={path:'supply.tar.gz',sha256:digest};receipt.blobs.push({sha256:digest,bytes:bytes.length,filename:'recipe.json'});resign();
  const archive=path.join(root,'recipe-export.tar.gz'),output=path.join(root,'recipe-out');await fs.writeFile(archive,await archiveBytes());await fs.mkdir(output);await tar.x({file:archive,cwd:output,strict:true});expect(await fs.readFile(path.join(output,receipt.descriptor.recipe.path))).toEqual(bytes);await assertClean();
 });
 it.each(['descriptor','missing-source','missing-runtime','missing-recipe','recipe-collision'] as const)('Rejects incomplete or changed immutable receipt: %s',async change=>{
  if(change==='descriptor')receipt.descriptor_sha256='f'.repeat(64);
  if(change==='missing-source')receipt.blobs.pop();
  if(change==='missing-runtime')receipt.blobs.shift();
  if(change==='missing-recipe')receipt.descriptor.recipe={path:'recipes/absent.json',sha256:'c'.repeat(64)};
  if(change==='recipe-collision'){const bytes=Buffer.from('{}'),digest=await retain(bytes);receipt.descriptor.recipe={path:'README.md',sha256:digest};receipt.blobs.push({sha256:digest,bytes:bytes.length,filename:'recipe.json'});}
  if(change.startsWith('missing-recipe')||change==='recipe-collision')resign();
  expect(()=>toolSupplyPlan(receipt)).toThrow();expect(capacity.reserve).not.toHaveBeenCalled();
 });
 it('Corrupted retained runtime fails before returning download and removes owned staging',async()=>{
  const runtime=receipt.blobs[0];await fs.chmod(path.join(root,'.asset-source-blobs',runtime.sha256+'.blob'),0o600);await fs.writeFile(path.join(root,'.asset-source-blobs',runtime.sha256+'.blob'),Buffer.alloc(runtime.bytes,0));
  await expect(createToolSupply(toolSupplyPlan(receipt),store,new AbortController().signal)).rejects.toThrow();await assertClean();expect(capacity.release).toHaveBeenCalledOnce();
 });
 it('Capacity refusal creates no export stage and touches no source bytes',async()=>{
  capacity.reserve.mockRejectedValue(Object.assign(new Error('Capacity denied'),{statusCode:507}));await expect(createToolSupply(toolSupplyPlan(receipt),store,new AbortController().signal)).rejects.toThrow('Capacity denied');await assertClean();expect(payloads.size).toBe(2);
 });
 it('Cancellation during source copy removes owned files and retains the original blobs',async()=>{
  const abort=new AbortController(),original=store.open.bind(store);let copying=false;
  const wrapped={open:async(digest:string,signal?:AbortSignal)=>{const value=await original(digest,signal);if(digest===receipt.blobs[1].sha256){copying=true;const stream=Readable.from((async function*(){try{for await(const chunk of value.stream){abort.abort();yield chunk;}}finally{value.stream.destroy();}})());return {...value,stream} as never;}return value;}};
  await expect(createToolSupply(toolSupplyPlan(receipt),wrapped,abort.signal)).rejects.toThrow();expect(copying).toBe(true);await assertClean();for(const blob of receipt.blobs)expect(sha(await fs.readFile(path.join(root,'.asset-source-blobs',blob.sha256+'.blob')))).toBe(blob.sha256);
 });
 it('Only completed jobs with exact source identity can prepare a supply',async()=>{
  const repository={get:vi.fn().mockResolvedValue({state:'RUNNING',result:null})},sources={exportLocalReceipt:vi.fn().mockResolvedValue(receipt),blobs:store};
  const builds=Object.assign(Object.create(PackageBuildService.prototype),{repository,sources,requireMain:vi.fn().mockResolvedValue(undefined)}) as PackageBuildService;
  const actor={email:'fixture@example.test',activeRole:'Главный админ'};await expect(builds.checkSupply(actor,'11111111-1111-4111-8111-111111111111')).rejects.toThrow();expect(sources.exportLocalReceipt).not.toHaveBeenCalled();
  repository.get.mockResolvedValue({state:'SUCCEEDED',result:{assetId:receipt.external_id,sourceVersion:receipt.asset_version,sourceSha256:receipt.descriptor_sha256}});
  expect((await builds.checkSupply(actor,'11111111-1111-4111-8111-111111111111')).filename).toBe('test-export-1.0.0-supply.tar.gz');expect(sources.exportLocalReceipt).toHaveBeenCalledWith({assetId:receipt.external_id,sourceVersion:receipt.asset_version,sourceSha256:receipt.descriptor_sha256});
 });
 it('JSONB key order does not change the canonical export, and changed receipt content fails closed',async()=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','supply-controller-fixture');
  receipt.descriptor=Object.fromEntries(Object.entries(receipt.descriptor).reverse()) as ToolAsset;
  const pool={query:vi.fn().mockResolvedValue({rows:[receipt]})},sources=Object.assign(Object.create(AssetSourcesService.prototype),{pool}) as AssetSourcesService;
  const reference={assetId:receipt.external_id,sourceVersion:receipt.asset_version,sourceSha256:receipt.descriptor_sha256};
  expect(await sources.exportLocalReceipt(reference)).toBe(receipt);expect(await sources.exportLocal(reference)).toBe(receipt.descriptor);
  const controller=new PackageBuildController({exportAsset:async()=>sources.exportLocal(reference)} as never),send=vi.fn(),headers:Record<string,string>={};
  const response={setHeader:(key:string,value:string)=>{headers[key]=value;},send} as unknown as Response;
  await controller.asset({headers:{'x-neurocenter-internal':'supply-controller-fixture','x-bridge-actor':encodeURIComponent(JSON.stringify({email:'fixture@example.test',activeRole:'Главный админ'}))}} as Request,'11111111-1111-4111-8111-111111111111',response);
  expect(send).toHaveBeenCalledWith(serializeAsset(receipt.descriptor));expect(assetDigest(send.mock.calls[0][0])).toBe(receipt.descriptor_sha256);expect(headers['Content-Type']).toBe('application/json');
  receipt.descriptor.card.name='Changed immutable name';await expect(sources.exportLocalReceipt(reference)).rejects.toThrow('checksum changed');
 });
 it('Rejects an oversized supply from metadata before allocating or reserving files',()=>{
  const item=receipt.descriptor.delivery.artifacts[0].descriptor;item.compressedBytes=4*1024**3;receipt.descriptor.delivery.artifacts=[receipt.descriptor.delivery.artifacts[0]];receipt.blobs[0].bytes=item.compressedBytes;resign();
  expect(()=>toolSupplyPlan(receipt)).toThrow('4 ГиБ');expect(capacity.reserve).not.toHaveBeenCalled();
 });
});

async function httpFixture(authorize:()=>Promise<void>,prepare:(signal:AbortSignal)=>ReturnType<typeof createToolSupply>){
 const tasks:Promise<void>[]=[];const server=createServer((request,response)=>{
  const res=response as unknown as Response;res.status=function(code){this.statusCode=code;return this;};res.json=function(value){this.setHeader('content-type','application/json');this.end(JSON.stringify(value));return this;};
  tasks.push(sendToolSupply(request as Request,res,authorize,prepare));
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}/supply`,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await Promise.allSettled(tasks);}};
}
describe('Actual HTTP export ownership and cleanup',()=>{
 it('Transfers a complete tar.gz with exact length and preserves source SHA bytes',async()=>{
  const app=await httpFixture(async()=>{},signal=>createToolSupply(toolSupplyPlan(receipt),store,signal));
  try{const response=await fetch(app.url),bytes=Buffer.from(await response.arrayBuffer());expect(response.status).toBe(200);expect(response.headers.get('content-length')).toBe(String(bytes.length));expect(response.headers.get('content-type')).toBe('application/gzip');expect(response.headers.get('content-disposition')).toBe('attachment; filename="test-export-1.0.0-supply.tar.gz"');const archive=path.join(root,'http.tar.gz');await fs.writeFile(archive,bytes);const names:string[]=[];await tar.t({file:archive,onReadEntry:entry=>{names.push(entry.path);}});expect(names).toContain('asset.json');}finally{await app.close();}await assertClean();
 });
 it('Revocation after preparation prevents any attachment headers and cleans the real staged archive',async()=>{
  let checks=0;const app=await httpFixture(async()=>{if(++checks===2)throw new ForbiddenException();},signal=>createToolSupply(toolSupplyPlan(receipt),store,signal));
  try{const response=await fetch(app.url);expect(response.status).toBe(403);expect(response.headers.get('content-disposition')).toBeNull();expect(await response.text()).not.toContain(root);}finally{await app.close();}await assertClean();
 });
 it.each(['cancel','revoke'] as const)('%s during slow source preparation aborts actual HTTP and removes partial FS output',async mode=>{
  let started!:()=>void;const copying=new Promise<void>(resolve=>started=resolve),original=store.open.bind(store);let checks=0;
  const slow={open:async(digest:string,signal?:AbortSignal)=>{const value=await original(digest,signal);if(digest!==receipt.blobs[1].sha256)return value;const stream=Readable.from((async function*(){started();try{for await(const chunk of value.stream){await wait(15);yield chunk;}}finally{value.stream.destroy();}})());return {...value,stream} as never;}};
  const app=await httpFixture(async()=>{if(++checks>1&&mode==='revoke')throw new ForbiddenException();},signal=>createToolSupply(toolSupplyPlan(receipt),slow,signal));
  try{if(mode==='cancel'){const request=get(app.url,res=>res.resume());request.on('error',()=>{});await copying;request.destroy();}else{const response=await fetch(app.url);expect(response.status).toBe(403);expect(response.headers.get('content-disposition')).toBeNull();}}finally{await app.close();}await assertClean();
 });
 it('Revocation during the actual response interrupts transfer and releases its export once',async()=>{
  let checks=0;const cleanup=vi.fn(),chunk=Buffer.alloc(1024,7),stream=Readable.from((async function*(){for(let i=0;i<200;i++){await wait(20);yield chunk;}})());
  const app=await httpFixture(async()=>{if(++checks>2)throw new ForbiddenException();},async()=>({filename:'test-supply.tar.gz',bytes:200*chunk.length,stream,cleanup} as Awaited<ReturnType<typeof createToolSupply>>));
  try{const response=await fetch(app.url);expect(response.status).toBe(200);await expect(response.arrayBuffer()).rejects.toThrow();}finally{await app.close();}expect(cleanup).toHaveBeenCalledOnce();expect(stream.destroyed).toBe(true);
 });
});
