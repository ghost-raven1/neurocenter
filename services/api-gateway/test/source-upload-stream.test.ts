import express from 'express';
import axios from 'axios';
import {createServer,request,type IncomingMessage} from 'node:http';
import {once} from 'node:events';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {forwardSourceUpload,sourceUploadConnection} from '../src/proxy/source-upload-stream';
import {jobId} from './proxy-http.fixture';
const route='/api/tool-builds/uploads/'+jobId+'/content';
const listen=async(server:ReturnType<typeof createServer>)=>{server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Missing port');return 'http://127.0.0.1:'+address.port;};
const stop=async(server:ReturnType<typeof createServer>)=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
async function fixture(){
 const state={calls:0,received:[] as number[],aborted:false,early:false,result:{ok:true} as unknown,status:200,disconnect:false,finished:0};
 const upstream=createServer((req,res)=>{state.calls++;req.on('aborted',()=>{state.aborted=true;});if(state.disconnect){req.socket.destroy();return;}if(state.early){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({message:'Already cancelled.'}));return;}
  let bytes=0;req.on('data',chunk=>bytes+=chunk.length);req.on('end',()=>{state.received.push(bytes);res.writeHead(state.status,{'content-type':'application/json'});res.end(JSON.stringify(state.result));});
 });const base=await listen(upstream),client=axios.create({validateStatus:()=>true}),app=express();
 app.use(sourceUploadConnection);app.use((req,res)=>{void(async()=>{const requestListeners=req.listenerCount('aborted'),responseListeners=res.listenerCount('close');await forwardSourceUpload(client,base+'/upload',{'x-neurocenter-internal':'qa-stream-only'},req,res,16,1024);expect(req.listenerCount('aborted')).toBe(requestListeners);expect(res.listenerCount('close')).toBe(responseListeners);state.finished++;})().catch(error=>{if(!res.headersSent)res.status(599).json({message:error.message});else res.destroy(error);});});
 const gateway=createServer(app),url=await listen(gateway);
 return {url,state,async send(body=Buffer.from('data'),headers:Record<string,string|number>={}){return new Promise<{status:number;body:any;headers:IncomingMessage['headers']}>((resolve,reject)=>{const req=request(url+route,{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':body.length,...headers}},res=>{const parts:Buffer[]=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(parts).toString()),headers:res.headers}));});req.once('error',reject);req.end(body);});},async close(){await stop(gateway);await stop(upstream);}};
}

describe.sequential('Raw upload source with low bounded limits and actual HTTP streams',()=>{
 let f:Awaited<ReturnType<typeof fixture>>|undefined;afterEach(async()=>{if(f)await f.close();f=undefined;vi.restoreAllMocks();});
 it('streams the exact file, returns only a small object receipt and releases request listeners',async()=>{f=await fixture();const result=await f.send();expect(result.status).toBe(200);expect(f.state.received).toEqual([4]);expect(result.body).toEqual({ok:true});expect(result.headers['cache-control']).toBe('no-store');expect(result.headers.connection).toBe('close');await vi.waitFor(()=>expect(f!.state.finished).toBe(1));});
 it.each([['text/plain',4,415],['application/octet-stream',0,413],['application/octet-stream',17,413]] as const)('rejects media %s / declared bytes %s before contacting upstream',async(media,length,status)=>{f=await fixture();const result=await f.send(Buffer.from('x'),{'content-type':media,'content-length':length});expect(result.status).toBe(status);expect(f.state.calls).toBe(0);expect(result.headers.connection).toBe('close');});
 it.each([null,[],42,'not an object'])('does not trust a scalar or array upstream receipt %#',async value=>{f=await fixture();f.state.result=value;const result=await f.send();expect(result.status).toBe(200);expect(result.body).toEqual({message:'Каталог вернул некорректный ответ загрузки.'});});
 it('returns an early catalog refusal promptly and closes an unfinished client message',async()=>{f=await fixture();f.state.early=true;const result=await f.send(Buffer.from('x'),{'content-length':10});expect(result.status).toBe(409);expect(result.body).toEqual({message:'Already cancelled.'});expect(result.headers.connection).toBe('close');});
 it('aborts upstream on actual chunked-byte overflow after a partial transfer',async()=>{
  f=await fixture();const current=f;const result=new Promise<{status:number;body:any}>((resolve,reject)=>{
   const req=request(current.url+route,{method:'PUT',headers:{'content-type':'application/octet-stream'}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',()=>{});req.write('first');
   void vi.waitFor(()=>expect(current.state.calls).toBe(1)).then(()=>req.end('second chunk too large')).catch(reject);
  });expect((await result).status).toBe(413);expect(current.state.received).toEqual([]);await vi.waitFor(()=>expect(current.state.aborted).toBe(true));
 });
 it('closes only its upstream transfer when a raw-upload browser disconnects',async()=>{f=await fixture();const req=request(f.url+route,{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':16}});req.on('error',()=>{});req.write('part');await vi.waitFor(()=>expect(f!.state.calls).toBe(1));req.destroy();await vi.waitFor(()=>expect(f!.state.aborted).toBe(true));await vi.waitFor(()=>expect(f!.state.finished).toBe(1));});
 it('maps transport failure and an unbounded receipt to safe failures, without a false success receipt',async()=>{
  f=await fixture();f.state.disconnect=true;expect((await f.send()).status).toBe(502);f.state.disconnect=false;f.state.result={large:'x'.repeat(1025)};expect((await f.send()).status).toBe(502);
 });
 it('enforces its ten-minute deadline and cleans up the aborted upstream request',async()=>{
  f=await fixture();const original=setTimeout;const timer=vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:Function,ms?:number,...args:unknown[])=>original(callback as never,ms===600000?20:ms,...args)) as unknown as typeof setTimeout);
  const result=new Promise<{status:number}>((resolve,reject)=>{const req=request(f!.url+route,{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':16}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode!}));});req.on('error',reject);req.write('part');});expect((await result).status).toBe(504);expect(timer).toHaveBeenCalledWith(expect.any(Function),600000);await vi.waitFor(()=>expect(f!.state.finished).toBe(1));
 });
});
