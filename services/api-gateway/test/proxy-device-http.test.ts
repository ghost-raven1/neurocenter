import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {proxyHttpFixture,deviceHeaders,jobId,lease,reply} from './proxy-http.fixture';

describe.sequential('Device channel source allowlist, fresh identity and event boundaries',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
 beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');vi.stubEnv('NODE_ENV','production');vi.stubEnv('NEUROCENTER_TLS_PROXY_ADDRESSES','');vi.spyOn(console,'error').mockImplementation(()=>undefined);f=await proxyHttpFixture();});
 afterEach(async()=>{await f.close();vi.restoreAllMocks();vi.unstubAllEnvs();});
 it.each([['GET','identity'],['POST','internal/access/users'],['POST','%69dentity'],['POST','jobs/not-a-uuid/complete'],['POST','heartbeat/extra']])('does not proxy arbitrary internal paths: %s %s',async(method,suffix)=>{
  const result=await f.send('/api/device-channel/'+suffix,{method,headers:deviceHeaders,body:method==='POST'?{}:undefined});expect(result.status).toBe(404);expect(f.calls).toEqual([]);
 });
 it('still denies a dot-segment URL normalized by the HTTP client as ordinary device management',async()=>{
  expect((await f.send('/api/device-channel/../access/users',{method:'POST',headers:deviceHeaders,body:{}})).status).toBe(403);expect(f.business()).toEqual([]);
 });
 it.each([401,403])('requires current device authority before forwarding channel commands (%s)',async status=>{
  f.state.deviceStatus=status;const result=await f.send('/api/device-channel/heartbeat',{method:'POST',headers:deviceHeaders,body:{}});expect(result.status).toBe(401);expect(f.calls.filter(call=>call.path==='/internal/device-channel/heartbeat')).toEqual([]);
 });
 it('does not turn a browser session into a device identity',async()=>{
  expect((await f.send('/api/device-channel/heartbeat',{method:'POST',body:{}})).status).toBe(401);expect(f.calls.filter(call=>call.path==='/internal/device-channel/heartbeat')).toEqual([]);
 });
 it('keeps credential transfer disabled on plaintext, including spoofed forwarded TLS',async()=>{
  const value=await f.send('/api/device-channel/opencode-models/sync',{method:'POST',headers:{...deviceHeaders,'x-forwarded-proto':'https'},body:{credentials:{candidate:'qa-synthetic-key'}}});expect(value.status).toBe(403);expect(f.calls).toEqual([]);
 });
 it('allows opted-in transfer only through explicitly trusted proxy TLS evidence',async()=>{
  vi.stubEnv('NEUROCENTER_TLS_PROXY_ADDRESSES','127.0.0.1');const result=await f.send('/api/device-channel/opencode-models/sync',{method:'POST',headers:{...deviceHeaders,'x-forwarded-proto':'https'},body:{credentials:{candidate:'qa-synthetic-key'}}});expect(result.status).toBe(200);expect(f.calls.some(call=>call.path==='/internal/device-channel/opencode-models/sync')).toBe(true);
 });
 it('allows metadata-only sync without TLS credentials and invalidates sections only when changed',async()=>{
  f.state.businessPayload={changed:false};expect((await f.send('/api/device-channel/opencode-models/sync',{method:'POST',headers:deviceHeaders,body:{credentials:{}}})).status).toBe(200);expect(f.live.sections).not.toHaveBeenCalled();
  f.state.businessPayload={changed:true};expect((await f.send('/api/device-channel/opencode-models/sync',{method:'POST',headers:deviceHeaders,body:{credentials:{}}})).status).toBe(200);expect(f.live.sections).toHaveBeenCalledExactlyOnceWith(['catalog','projects','audit']);
 });
 it.each(['context','record','propose','observe'])('routes only the approved learning/%s action with the real bearer',async action=>{
  const result=await f.send('/api/device-channel/learning/'+action,{method:'POST',headers:deviceHeaders,body:{projectId:'prj-qa'}});expect(result.status).toBe(200);const call=f.calls.find(call=>call.path==='/internal/device-channel/learning/'+action)!;expect(call.headers.authorization).toBe(deviceHeaders.authorization);expect(call.headers['x-neurocenter-internal']).toBe('qa-proxy-internal');if(action!=='context')expect(f.live.sections).toHaveBeenCalledWith(['projects','audit']);
 });
 it.each(['succeeded','failed','running'])('emits operation completion sections only for terminal job state %s',async state=>{
  expect((await f.send('/api/device-channel/jobs/'+jobId+'/complete',{method:'POST',headers:deviceHeaders,body:{state}})).status).toBe(200);expect(f.live.bridge).toHaveBeenCalledWith('owner@example.test','device-qa',jobId);expect(f.live.sections.mock.calls.length).toBe(state==='running'?0:1);
 });
 it('preserves an empty successful channel response as JSON null and never emits success events on refusal',async()=>{
  f.state.handler=(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('');};expect((await f.send('/api/device-channel/heartbeat',{method:'POST',headers:deviceHeaders,body:{}})).body).toBeNull();expect(f.live.bridge).toHaveBeenCalledOnce();
  f.live.bridge.mockClear();f.state.handler=(_req,res)=>reply(res,409,{message:'refused'});expect((await f.send('/api/device-channel/heartbeat',{method:'POST',headers:deviceHeaders,body:{}})).status).toBe(409);expect(f.live.bridge).not.toHaveBeenCalled();
 });
 it('returns a generic channel failure when Catalog disconnects',async()=>{
  f.state.handler=req=>{req.socket.destroy();};const result=await f.send('/api/device-channel/heartbeat',{method:'POST',headers:deviceHeaders,body:{}});expect(result.status).toBe(502);expect(result.body).toEqual({message:'Сервис подключений недоступен.'});expect(f.live.bridge).not.toHaveBeenCalled();
 });
 it('applies a current feature decision before a channel action reaches Catalog',async()=>{
  f.state.flags.computer_connections=false;expect((await f.send('/api/device-channel/pair/start',{method:'POST',body:{}})).status).toBe(403);expect(f.calls.filter(call=>call.path==='/internal/device-channel/pair/start')).toEqual([]);
 });
 it('limits repeated pairing starts per socket and resets the window without sharing unrelated addresses',async()=>{
  const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now);for(let i=0;i<15;i++)expect((await f.send('/api/device-channel/pair/start',{method:'POST',body:{}})).status).toBe(200);
  expect((await f.send('/api/device-channel/pair/start',{method:'POST',body:{}})).status).toBe(429);clock.mockReturnValue(now+60001);expect((await f.send('/api/device-channel/pair/start',{method:'POST',body:{}})).status).toBe(200);
 });
 it('validates poll codes and gives separate per-device budgets behind a shared proxy',async()=>{
  expect((await f.send('/api/device-channel/pair/poll',{method:'POST',body:{deviceCode:'invalid'}})).status).toBe(401);
  const body={deviceCode:'a'.repeat(64)};for(let i=0;i<60;i++)expect((await f.send('/api/device-channel/pair/poll',{method:'POST',body})).status).toBe(200);
  expect((await f.send('/api/device-channel/pair/poll',{method:'POST',body})).status).toBe(429);expect((await f.send('/api/device-channel/pair/poll',{method:'POST',body:{deviceCode:'b'.repeat(64)}})).status).toBe(200);
  const calls=f.calls.filter(call=>call.path==='/internal/device-channel/pair/poll');expect(calls.every(call=>call.headers.authorization===undefined)).toBe(true);
 });
 it('serves a runtime only after fresh device authentication and forwards the lease',async()=>{
  f.state.handler=(_req,res,call)=>{expect(call.headers['x-neurocenter-job-lease']).toBe(lease);res.writeHead(200,{'content-length':'4'});res.end('data');};const result=await f.send('/api/device-channel/jobs/'+jobId+'/runtime/'+'b'.repeat(64),{headers:{...deviceHeaders,'x-neurocenter-job-lease':lease}});expect(result.status).toBe(200);expect(result.body).toBe('data');expect(result.headers.get('cache-control')).toBe('no-store');
  f.state.deviceStatus=401;expect((await f.send('/api/device-channel/jobs/'+jobId+'/runtime/'+'b'.repeat(64),{headers:deviceHeaders})).status).toBe(401);
 });
 it('blocks embedding without device auth or an enabled model host, and forwards a permitted vector once',async()=>{
  f.state.deviceStatus=401;expect((await f.send('/api/device-channel/embedding',{method:'POST',headers:deviceHeaders,body:{input:'x'}})).status).toBe(401);
  f.state.deviceStatus=200;f.state.flags.model_hosting=false;expect((await f.send('/api/device-channel/embedding',{method:'POST',headers:deviceHeaders,body:{input:'x'}})).status).toBe(403);
  f.state.flags.model_hosting=true;f.state.businessPayload={embedding:[0.1,0.2]};const result=await f.send('/api/device-channel/embedding',{method:'POST',headers:deviceHeaders,body:{input:'x'}});expect(result.status).toBe(200);expect(result.body).toEqual({embedding:[0.1,0.2]});expect(f.live.bridge).not.toHaveBeenCalled();
 });
});
