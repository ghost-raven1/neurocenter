import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import type {HostedMcpClaim} from '../src/features/mcp-host/ticket';
import {hostRuntimeTarget} from '../src/features/mcp-host/host-target';
const require=createRequire(import.meta.url);
// Reuse the tiny actual USTAR generator already used by the native Gateway archive regressions.
export const artifactFixture=require('../../../scripts/test/runtime-artifact-fixture.cjs').artifactFixture as (files?:Array<{path:string;content:string|Buffer;mode?:number;type?:string;link?:string}>,target?:string)=>{archive:Buffer;descriptor:{sha256:string;compressedBytes:number;unpackedBytes:number;filesCount:number;entrypoint:string;target:string}};
export const fixtureFiles=()=>[{path:'runtime/server.mjs',content:'export const value = "approved";\n'},{path:'docs/readme.md',content:'A declared runtime resource.\n'}];

/** An isolated cache plus actual local HTTP response; no external vendor or production filesystem is touched. */
export async function cacheFixture(input=artifactFixture(fixtureFiles(),hostRuntimeTarget())){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-source-host-cache-'))),cache=path.join(directory,'cache with spaces');
 const state={bytes:input.archive,status:200,headers:{'x-neurocenter-unpacked-bytes':String(input.descriptor.unpackedBytes),'x-neurocenter-files-count':String(input.descriptor.filesCount)} as Record<string,string>,requests:[] as Array<{url:string;token:unknown}>,gate:undefined as Promise<void>|undefined,disconnect:false,chunked:false};
 let release:(()=>void)|undefined;
 const server=createServer(async(req,res)=>{
  try{
   state.requests.push({url:req.url||'',token:req.headers['x-neurocenter-internal']});
   if(req.headers['x-neurocenter-internal']!=='qa-cache-internal'){res.writeHead(403).end();return;}
   if(state.disconnect){req.socket.destroy();return;}
   if(state.gate)await state.gate;
   res.writeHead(state.status,{'content-type':'application/gzip',...state.headers,...(state.chunked?{'transfer-encoding':'chunked'}:{})});
   if(state.chunked){res.write(state.bytes.subarray(0,1));await new Promise(resolve=>setTimeout(resolve,10));res.end(state.bytes.subarray(1));}
   else res.end(state.bytes);
  }catch{res.destroy();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const claim:HostedMcpClaim={artifactSha256:input.descriptor.sha256,compressedBytes:input.descriptor.compressedBytes,unpackedBytes:input.descriptor.unpackedBytes,filesCount:input.descriptor.filesCount,entrypoint:input.descriptor.entrypoint,executable:false,name:'QA cache',exp:Date.now()+60000};
 return {directory,cache,state,claim,archive:input.archive,base:'http://127.0.0.1:'+address.port,
  final:path.join(cache,'artifacts',claim.artifactSha256),stage:path.join(cache,'building'),
  hold(){state.gate=new Promise<void>(resolve=>{release=resolve;});},release(){release?.();state.gate=undefined;},
  async close(){release?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});},
 };
}
