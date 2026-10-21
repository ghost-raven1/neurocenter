import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import axios from 'axios';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {materializeArtifact} from '../src/features/mcp-host/artifact-cache';
import {cacheFixture,artifactFixture,fixtureFiles} from './artifact-cache.fixture';
import {hostRuntimeTarget} from '../src/features/mcp-host/host-target';
const faults=vi.hoisted(()=>({write:undefined as string|undefined}));
vi.mock('node:fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs')>(),{Writable}=await import('node:stream');
 return {...actual,createWriteStream:(filename:unknown,options:unknown)=>{
  if(faults.write&&path.basename(String(filename))==='artifact.tar.gz')return new Writable({highWaterMark:1,write(_chunk,_encoding,callback){setImmediate(()=>callback(Object.assign(new Error('Synthetic cache writer failure.'),{code:faults.write})));}});
  return actual.createWriteStream(filename as string,options as never);
 }};
});

describe.sequential('Gateway artifact cache source: actual local HTTP, USTAR and filesystem',()=>{
 let fixture:Awaited<ReturnType<typeof cacheFixture>>|undefined;
 afterEach(async()=>{faults.write=undefined;vi.restoreAllMocks();if(fixture)await fixture.close();fixture=undefined;vi.unstubAllEnvs();});
 const setup=async(input?:Parameters<typeof cacheFixture>[0])=>{fixture=await cacheFixture(input);vi.stubEnv('NEUROCENTER_MCP_HOST_DIR',fixture.cache);return fixture;};
 const build=()=>materializeArtifact(fixture!.claim,fixture!.base+'///','qa-cache-internal');
 const noPublication=async()=>{expect(await fs.readdir(fixture!.stage)).toEqual([]);await expect(fs.stat(path.join(fixture!.final,'.ready'))).rejects.toMatchObject({code:'ENOENT'});};
 it('publishes an atomic complete inventory, reuses checked cache bytes, and deduplicates concurrent downloads',async()=>{
  const f=await setup();f.hold();const first=build(),second=build();
  await vi.waitFor(()=>expect(f.state.requests).toHaveLength(1));await expect(fs.stat(f.final)).rejects.toMatchObject({code:'ENOENT'});expect(await fs.readdir(f.stage)).toHaveLength(1);f.release();
  const roots=await Promise.all([first,second]);expect(roots).toEqual([f.final,f.final]);expect(await fs.readdir(f.stage)).toEqual([]);
  const receipt=JSON.parse(await fs.readFile(path.join(f.final,'.ready'),'utf8'));expect(receipt).toMatchObject({schemaVersion:2,sha256:f.claim.artifactSha256});expect(receipt.entries).toHaveLength(2);
  expect(await fs.readFile(path.join(f.final,'runtime/server.mjs'),'utf8')).toBe(fixtureFiles()[0].content);expect(await build()).toBe(f.final);expect(f.state.requests).toEqual([{url:'/internal/mcp-host/artifact/'+f.claim.artifactSha256,token:'qa-cache-internal'}]);
 });
 it('uses complete signed limits in preference to conflicting transport headers',async()=>{
  const f=await setup();f.state.headers={'x-neurocenter-unpacked-bytes':'invalid','x-neurocenter-files-count':'99999'};expect(await build()).toBe(f.final);
 });
 it('supports older signed claims only when exact archive limits arrive in Catalog headers',async()=>{
  const f=await setup();delete f.claim.unpackedBytes;delete f.claim.filesCount;expect(await build()).toBe(f.final);
 });
 it.each(['missing','invalid','wrong-inventory'])('rejects a legacy claim with %s transport limits and permits a clean retry',async mode=>{
  const f=await setup();delete f.claim.unpackedBytes;delete f.claim.filesCount;f.state.headers=mode==='missing'?{}:mode==='invalid'?{'x-neurocenter-unpacked-bytes':'invalid','x-neurocenter-files-count':'bad'}:{'x-neurocenter-unpacked-bytes':'1','x-neurocenter-files-count':'1'};
  await expect(build()).rejects.toThrow('Комплект хоста недоступен');await noPublication();f.state.headers={'x-neurocenter-unpacked-bytes':String(fixtureFiles().reduce((sum,file)=>sum+Buffer.byteLength(file.content),0)),'x-neurocenter-files-count':'2'};expect(await build()).toBe(f.final);expect(f.state.requests).toHaveLength(2);
 });
 it.each(['hash','short','long','status','disconnect'])('does not publish a %s response and removes its private stage',async mode=>{
  const f=await setup();if(mode==='hash'){f.state.bytes=Buffer.from(f.archive);f.state.bytes[20]^=1;}if(mode==='short')f.state.bytes=f.archive.subarray(0,-1);if(mode==='long')f.state.bytes=Buffer.concat([f.archive,Buffer.from('extra')]);if(mode==='status')f.state.status=201;if(mode==='disconnect')f.state.disconnect=true;
  await expect(build()).rejects.toThrow('Комплект хоста недоступен');await noPublication();f.state.bytes=f.archive;f.state.status=200;f.state.disconnect=false;expect(await build()).toBe(f.final);
 });
 it('bounds an unknown-length chunked response after the HTTP stream has already started',async()=>{
  const f=await setup();f.state.chunked=true;f.claim.compressedBytes=1;await expect(build()).rejects.toThrow('Комплект хоста недоступен');await noPublication();expect(f.state.requests).toHaveLength(1);
 });
 it('also bounds a transport adapter that returns more bytes than its advertised maximum',async()=>{
  const f=await setup(),stream=Readable.from([f.archive,Buffer.from('extra')]);
  vi.spyOn(axios,'get').mockResolvedValueOnce({status:200,headers:f.state.headers,data:stream});
  await expect(build()).rejects.toThrow('Комплект хоста недоступен');expect(stream.destroyed).toBe(true);await noPublication();
 });
 it.each(['ENOSPC','EACCES'])('cleans %s writer failure under backpressure without an unhandled stream error',async code=>{
  const input=artifactFixture([{path:'runtime/server.mjs',content:randomBytes(256*1024)}],hostRuntimeTarget());const f=await setup(input);faults.write=code;
  await expect(build()).rejects.toThrow('Комплект хоста недоступен');await new Promise(resolve=>setImmediate(resolve));await noPublication();faults.write=undefined;expect(await build()).toBe(f.final);
 });
 it.each(['traversal','link','duplicate','missing-entry'])('rejects a checksummed but unsafe %s archive and keeps paths inside the owned fixture',async mode=>{
  const files=fixtureFiles();if(mode==='traversal')files.push({path:'../escape',content:'must not escape'});if(mode==='duplicate')files.push({...files[0]});
  const input=artifactFixture(files,hostRuntimeTarget());if(mode==='link')Object.assign(input,artifactFixture([{path:'runtime/server.mjs',content:'never',type:'2',link:'../../outside'}],hostRuntimeTarget()));
  if(mode==='link')input.descriptor.filesCount=1;
  const f=await setup(input);if(mode==='missing-entry')f.claim.entrypoint='runtime/missing.mjs';await expect(build()).rejects.toThrow('Комплект хоста недоступен');await noPublication();await expect(fs.stat(path.join(f.directory,'escape'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('does not publish when the atomic rename fails, and releases the inflight slot for retry',async()=>{
  const f=await setup(),rename=vi.spyOn(fs,'rename').mockRejectedValueOnce(Object.assign(new Error('Synthetic rename denied.'),{code:'EACCES'}));await expect(build()).rejects.toThrow('Комплект хоста недоступен');await noPublication();rename.mockRestore();expect(await build()).toBe(f.final);
 });
 it.each(['invalid-json','wrong-schema','wrong-sha','missing-list','empty-list','too-many-files','oversize-marker','unsafe-path','missing-file','wrong-size','wrong-hash','entry-directory','marker-directory','missing-entry-inventory'])('rehydrates a %s cache from the immutable Catalog archive',async mode=>{
  const f=await setup();await build();const marker=path.join(f.final,'.ready'),entry=path.join(f.final,f.claim.entrypoint),receipt=JSON.parse(await fs.readFile(marker,'utf8'));await fs.chmod(marker,0o600);
  if(mode==='invalid-json')await fs.writeFile(marker,'not JSON');
  else if(mode==='oversize-marker')await fs.writeFile(marker,'x'.repeat(8*1024*1024+1));
  else if(mode==='entry-directory'){await fs.rm(entry);await fs.mkdir(entry);}
  else if(mode==='marker-directory'){await fs.rm(marker);await fs.mkdir(marker);}
  else if(mode==='wrong-hash'){await fs.chmod(entry,0o600);const bytes=await fs.readFile(entry);bytes[0]^=1;await fs.writeFile(entry,bytes);}
  else if(mode==='missing-file')await fs.rm(path.join(f.final,'docs/readme.md'));
  else{if(mode==='wrong-schema')receipt.schemaVersion=1;if(mode==='wrong-sha')receipt.sha256='b'.repeat(64);if(mode==='missing-list')receipt.entries=null;if(mode==='empty-list')receipt.entries=[];if(mode==='too-many-files')receipt.entries=Array(20001).fill({});if(mode==='unsafe-path')receipt.entries[0].path='../outside';if(mode==='wrong-size')receipt.entries[0].size++;if(mode==='missing-entry-inventory')receipt.entries=receipt.entries.filter((file:{path:string})=>file.path!==f.claim.entrypoint);await fs.writeFile(marker,JSON.stringify(receipt));}
  expect(await build()).toBe(f.final);expect(f.state.requests).toHaveLength(2);expect(await fs.readFile(entry,'utf8')).toBe(fixtureFiles()[0].content);expect(await fs.readdir(f.stage)).toEqual([]);
 });
 it('keeps the default cache root inside the private fixture when no location is configured',async()=>{
  const f=await setup();vi.spyOn(os,'tmpdir').mockReturnValue(f.directory);vi.stubEnv('NEUROCENTER_MCP_HOST_DIR','');expect(await build()).toBe(path.join(f.directory,'neurocenter-mcp-host','artifacts',f.claim.artifactSha256));
 });
 it.each(['removed','directory'])('does not publish an entry that was %s after extraction',async mode=>{
  const f=await setup(),lstat=fs.lstat.bind(fs);let changed=false;
  vi.spyOn(fs,'lstat').mockImplementation(async(filename,...args)=>{
   if(!changed&&String(filename).includes(path.sep+'unpack'+path.sep)&&path.basename(String(filename))==='server.mjs'){
    changed=true;await fs.rm(filename);if(mode==='directory')await fs.mkdir(filename);
   }
   return lstat(filename,...args as []);
  });
  await expect(build()).rejects.toThrow('Комплект хоста недоступен');expect(changed).toBe(true);await noPublication();
 });
 it('does not publish if a filesystem denies writing the durable ready marker',async()=>{
  const f=await setup(),open=fs.open.bind(fs);let denied=false;
  vi.spyOn(fs,'open').mockImplementation(async(filename,...args)=>{
   if(path.basename(String(filename))==='.ready'){denied=true;throw Object.assign(new Error('Synthetic marker write denied.'),{code:'EACCES'});}
   return open(filename,...args as [any,any]);
  });
  await expect(build()).rejects.toThrow('Комплект хоста недоступен');expect(denied).toBe(true);await noPublication();
 });
 it('preserves an unrelated occupied final path and fails closed until its owner removes it',async()=>{
  const f=await setup();await fs.mkdir(path.dirname(f.final),{recursive:true});await fs.writeFile(f.final,'owned conflicting file');await expect(build()).rejects.toThrow('Комплект хоста недоступен');expect(await fs.readFile(f.final,'utf8')).toBe('owned conflicting file');expect(await fs.readdir(f.stage)).toEqual([]);
 });
});
