import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {proxyHttpFixture,browserHeaders,deviceHeaders,chatId,reply} from './proxy-http.fixture';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
const pair=(path:string)=>({req:Object.assign(new EventEmitter(),{path,method:'POST',headers:deviceHeaders,query:{},body:{input:'x'},aborted:false}),res:Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,status:vi.fn(),json:vi.fn(),setHeader:vi.fn()})});

describe.sequential('Proxy cancellation admission races with real local authority services',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
 beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');vi.spyOn(console,'error').mockImplementation(()=>undefined);f=await proxyHttpFixture();});
 afterEach(async()=>{await f.close();vi.restoreAllMocks();vi.unstubAllEnvs();});
 it.each(['auth','access','flags'])('does not start model inference after disconnect during %s',async stage=>{
  const hold=gate(),route=`/api/model-chats/${chatId}/turns`;if(stage==='auth')f.state.authDelay=hold.promise;if(stage==='access')f.state.accessDelay=hold.promise;if(stage==='flags')f.state.flagsDelay=hold.promise;
  const cancel=new AbortController(),pending=fetch(f.url+route,{method:'POST',headers:browserHeaders,body:JSON.stringify({prompt:'hello'}),signal:cancel.signal}),rejected=expect(pending).rejects.toBeInstanceOf(Error);void rejected.catch(()=>undefined);
  try{await vi.waitFor(()=>expect(f.calls.some(call=>stage==='auth'?call.kind==='auth':stage==='access'?call.path==='/internal/access/authorize':call.path==='/internal/feature-flags/evaluated')).toBe(true));cancel.abort();await rejected;await new Promise(resolve=>setImmediate(resolve));hold.release();await f.idle();expect(f.business()).toEqual([]);}finally{hold.release();}
 });
 it('closes only an already-started Catalog inference and permits an independent retry',async()=>{
  const started=gate(),closed=gate();let count=0;f.state.handler=(_req,res,call)=>{if(call.path.includes('/turns')){count++;if(count===1){res.once('close',()=>{if(!res.writableEnded)closed.release();});started.release();return;}reply(res,201,{answer:'second request'});}};
  const cancel=new AbortController(),route=`/api/model-chats/${chatId}/turns`,pending=f.send(route,{method:'POST',body:{prompt:'hello'},signal:cancel.signal}),rejected=expect(pending).rejects.toBeInstanceOf(Error);void rejected.catch(()=>undefined);await started.promise;cancel.abort();await rejected;await closed.promise;await f.idle();const result=await f.send(route,{method:'POST',body:{prompt:'retry'}});expect(result.status).toBe(201);expect(result.body).toEqual({answer:'second request'});expect(count).toBe(2);expect(f.live.mutation).not.toHaveBeenCalled();
 });
 it.each(['auth','flags','provider'])('cancels embedding while awaiting %s without leaving a usable provider request',async stage=>{
  const hold=gate(),closed=gate();if(stage==='auth')f.state.authDelay=hold.promise;if(stage==='flags')f.state.flagsDelay=hold.promise;if(stage==='provider')f.state.handler=(_req,res,call)=>{if(call.path==='/internal/device-channel/embedding'){res.once('close',()=>closed.release());return;}reply(res,200,{});};
  const cancel=new AbortController(),pending=f.send('/api/device-channel/embedding',{method:'POST',headers:deviceHeaders,body:{input:'x'},signal:cancel.signal}),rejected=expect(pending).rejects.toBeInstanceOf(Error);void rejected.catch(()=>undefined);
  try{await vi.waitFor(()=>expect(f.calls.some(call=>stage==='auth'?call.path==='/internal/device-channel/identity':stage==='flags'?call.path==='/internal/feature-flags/evaluated':call.path==='/internal/device-channel/embedding')).toBe(true));cancel.abort();await rejected;await f.idle();expect(f.writes.filter(write=>write.path==='/api/device-channel/embedding')).toEqual([]);if(stage==='provider')await closed.promise;else expect(f.calls.filter(call=>call.path==='/internal/device-channel/embedding')).toEqual([]);}finally{hold.release();}
 });
 it.each(['auth','flags','provider'])('returns an explicit embedding timeout during %s and cleans local lifecycle handlers',async stage=>{
  const hold=gate();if(stage==='auth')f.state.authDelay=hold.promise;if(stage==='flags')f.state.flagsDelay=hold.promise;if(stage==='provider')f.state.handler=(_req,_res,call)=>{if(call.path==='/internal/device-channel/embedding')return;};
  const original=setTimeout;vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:Function,ms?:number,...args:unknown[])=>original(callback as never,ms===115000?40:ms,...args)) as unknown as typeof setTimeout);
  try{const result=await f.send('/api/device-channel/embedding',{method:'POST',headers:deviceHeaders,body:{input:'x'}});expect(result.status,JSON.stringify(result.body)).toBe(504);expect(result.body).toMatchObject({code:'EMBEDDING_TIMEOUT'});await f.idle();}finally{hold.release();}
 });
 it('handles a request abort event during actual authentication without allowing provider work',async()=>{
  const hold=gate();f.state.authDelay=hold.promise;const p=pair('/api/device-channel/embedding');p.res.status.mockReturnValue(p.res);const pending=f.proxy.forward(p.req as never,p.res as never);
  try{await vi.waitFor(()=>expect(f.calls.some(call=>call.path==='/internal/device-channel/identity')).toBe(true));p.req.emit('aborted');await pending;expect(p.res.json).not.toHaveBeenCalled();expect(f.calls.filter(call=>call.path==='/internal/device-channel/embedding')).toEqual([]);expect(p.req.listenerCount('aborted')).toBe(0);expect(p.res.listenerCount('close')).toBe(0);}finally{hold.release();}
 });
 it.each(['request','destroyed','finished'])('does no work for an initially closed embedding %s',async mode=>{
  const p=pair('/api/device-channel/embedding');if(mode==='request')p.req.aborted=true;if(mode==='destroyed')p.res.destroyed=true;if(mode==='finished')p.res.writableEnded=true;p.res.status.mockReturnValue(p.res);await f.proxy.forward(p.req as never,p.res as never);expect(f.calls).toEqual([]);expect(p.req.listenerCount('aborted')).toBe(0);expect(p.res.listenerCount('close')).toBe(0);
 });
 it('maps embedding provider transport failure and empty payloads without publishing bridge events',async()=>{
  f.state.handler=req=>{req.socket.destroy();};expect((await f.send('/api/device-channel/embedding',{method:'POST',headers:deviceHeaders,body:{input:'x'}})).status).toBe(502);f.state.handler=(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('');};expect((await f.send('/api/device-channel/embedding',{method:'POST',headers:deviceHeaders,body:{input:'x'}})).body).toBeNull();expect(f.live.bridge).not.toHaveBeenCalled();
 });
});
