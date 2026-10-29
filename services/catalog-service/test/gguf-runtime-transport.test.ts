import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {GgufOllamaTransport} from '../src/models/gguf-runtime/gguf-runtime.transport';
import {ggufRuntimeManifest} from '../src/models/gguf-runtime/gguf-runtime.manifest';
import {localModelAlias} from '../src/models/local-model-alias';
import {ggufImportPolicy} from '../../shared/gguf-import-policy.cjs';

import {runtimeManifest} from './gguf-runtime.fixture';

const limits=ggufImportPolicy({runtimeRequestTimeoutMs:2000,uploadTimeoutMs:4000,diskReserveBytes:1});
const alias='neurocenter/gguf-'+randomUUID()+':v1',sha='a'.repeat(64);

describe('Pinned GGUF provider API with actual loopback HTTP and bounded manifest reads',()=>{
 let server:Server,root:string,base:string,provider:GgufOllamaTransport,handler:(req:any,res:any)=>void;
 beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'gguf-runtime-'));handler=(_req,res)=>{res.setHeader('content-type','application/json');res.end('{}');};server=createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('port');base='http://127.0.0.1:'+address.port;provider=new GgufOllamaTransport(fetch,{MODEL_RUNTIME_URL:base});});
 afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});vi.restoreAllMocks();});
 it('checks the pinned engine and blob via HEAD, then streams exact bytes and only a files-based create',async()=>{const bytes=Buffer.from('GGUF'),file=path.join(root,'owned.source'),digest=createHash('sha256').update(bytes).digest('hex'),requests:Array<{method:string;url:string;body:Buffer}>=[];await fs.writeFile(file,bytes,{mode:0o400});
  handler=(req,res)=>{const chunks:Buffer[]=[];req.on('data',(chunk:Buffer)=>chunks.push(chunk));req.on('end',()=>{const body=Buffer.concat(chunks);requests.push({method:req.method,url:req.url,body});if(req.url==='/api/version'){res.end(JSON.stringify({version:'0.35.1'}));return;}if(req.method==='HEAD'){res.statusCode=404;res.end();return;}if(req.url.startsWith('/api/blobs/')){expect(req.headers['content-length']).toBe('4');res.statusCode=201;res.end();return;}res.end(JSON.stringify({status:'success'}));});};
  const signal=new AbortController().signal;await provider.version(limits,signal);expect(await provider.blobExists(digest,limits,signal)).toBe(false);await provider.upload(file,bytes.length,digest,limits,signal,async()=>{});await provider.create(alias,digest,limits,signal);
  expect(requests.map(item=>[item.method,item.url])).toEqual([['GET','/api/version'],['HEAD','/api/blobs/sha256:'+digest],['POST','/api/blobs/sha256:'+digest],['POST','/api/create']]);expect(requests[2].body).toEqual(bytes);expect(JSON.parse(requests[3].body.toString())).toEqual({model:alias,files:{'model.gguf':'sha256:'+digest},stream:false});
 });
 it('requires setup for an incompatible engine without pull or install calls',async()=>{const calls:string[]=[];handler=(req,res)=>{calls.push(req.url);res.end(JSON.stringify({version:'0.34.0'}));};await expect(provider.version(limits,new AbortController().signal)).rejects.toThrow('0.35.1');expect(calls).toEqual(['/api/version']);});
 it('does not follow a provider redirect',async()=>{handler=(_req,res)=>{res.statusCode=307;res.setHeader('location',base+'/forbidden');res.end();};await expect(provider.version(limits,new AbortController().signal)).rejects.toMatchObject({status:503});});
 it('keeps its deadline while a JSON body stalls after successful response headers',async()=>{handler=(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"version":');};await expect(provider.version({...limits,runtimeRequestTimeoutMs:30},new AbortController().signal)).rejects.toMatchObject({status:409});});
 it('aborts body reading when the parent operation is cancelled after headers',async()=>{const controller=new AbortController();handler=(_req,res)=>{res.writeHead(200);res.write('{');setTimeout(()=>controller.abort(),10);};await expect(provider.version(limits,controller.signal)).rejects.toMatchObject({status:409});});
 it('bounds responses and refuses a scalar payload',async()=>{handler=(_req,res)=>res.end(JSON.stringify({payload:'x'.repeat(1000)}));await expect(provider.version({...limits,runtimeResponseBytes:10},new AbortController().signal)).rejects.toThrow('лимит');handler=(_req,res)=>res.end('[]');await expect(provider.version(limits,new AbortController().signal)).rejects.toMatchObject({status:409});});
 it('never accepts another file SHA or mutable source as a blob upload',async()=>{const file=path.join(root,'source');await fs.writeFile(file,'GGUF');await expect(provider.upload(file,4,sha,limits,new AbortController().signal,async()=>{})).rejects.toMatchObject({status:409});});
 it('derives owned raw-import aliases without changing legacy manifest aliases',()=>{const uploadId=randomUUID();expect(localModelAlias({runtime:'ollama',manifestSha256:null,fileImport:{format:'gguf',uploadId,sha256:sha,bytes:4,fileName:'a.gguf',architecture:'llama',version:3}})).toBe('neurocenter/gguf-'+uploadId+':v1');expect(localModelAlias({runtime:'ollama',manifestSha256:sha})).toBe('neurocenter/'+sha+':v1');});
 it('reconciles manifest SHA separately from its source file layer SHA',async()=>{const manifest=await runtimeManifest(root,alias);expect(manifest.digest).not.toBe(sha);expect(await ggufRuntimeManifest(root,alias,sha,4,limits)).toBe(manifest.digest);});
 it('rejects another layer SHA, wrong length, non-owned alias, oversized or symlinked manifest',async()=>{const manifest=await runtimeManifest(root,alias);await expect(ggufRuntimeManifest(root,alias,'b'.repeat(64),4,limits)).rejects.toMatchObject({status:409});await expect(ggufRuntimeManifest(root,alias,sha,5,limits)).rejects.toMatchObject({status:409});await expect(ggufRuntimeManifest(root,'foreign/model:v1',sha,4,limits)).rejects.toMatchObject({status:409});await expect(ggufRuntimeManifest(root,alias,sha,4,{...limits,runtimeResponseBytes:1})).rejects.toMatchObject({status:409});await fs.rename(manifest.file,manifest.file+'.foreign');await fs.symlink(manifest.file+'.foreign',manifest.file);await expect(ggufRuntimeManifest(root,alias,sha,4,limits)).rejects.toBeDefined();});
});
