import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {proxyHttpFixture,deviceHeaders,reply} from './proxy-http.fixture';

describe.sequential('Retained bridge key has only a queue maintenance channel',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
 beforeEach(async()=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');vi.spyOn(console,'error').mockImplementation(()=>undefined);
  f=await proxyHttpFixture();f.state.flags.computer_connections=false;
 });
 afterEach(async()=>{await f.close();vi.restoreAllMocks();vi.unstubAllEnvs();});
 it.each([['pause',401],['resume',401],['pause',403],['resume',403]])('forwards %s for a retained key despite inactive identity (%s)',async(action,status)=>{
  f.state.deviceStatus=Number(status);f.state.businessPayload=action==='pause'?{activeJobs:0}:{ok:true};
  const response=await f.send('/api/device-channel/worker/'+action,{method:'POST',headers:deviceHeaders,body:{}});
  expect(response.status).toBe(200);expect(response.body).toEqual(f.state.businessPayload);
  const calls=f.calls.filter(call=>call.path.startsWith('/internal/device-channel/'));
  expect(calls).toHaveLength(1);expect(calls[0].path).toBe('/internal/device-channel/worker/'+action);
  expect(calls[0].headers.authorization).toBe(deviceHeaders.authorization);
  expect(calls[0].headers['x-neurocenter-internal']).toBe('qa-proxy-internal');
  expect(f.live.bridge).not.toHaveBeenCalled();expect(f.live.sections).not.toHaveBeenCalled();
 });
 it.each(['identity','heartbeat','configuration-authorize','jobs/claim'])('does not restore access to %s',async action=>{
  f.state.deviceStatus=401;
  const response=await f.send('/api/device-channel/'+action,{method:'POST',headers:deviceHeaders,body:{}});
  expect(response.status).toBe(401);expect(f.calls.filter(call=>call.path!=='/internal/device-channel/identity')).toEqual([]);
 });
 it.each([['GET','worker/pause'],['POST','worker/pause/extra'],['POST','worker/resume/extra'],['POST','worker/claim']])('rejects nearby routes: %s %s',async(method,suffix)=>{
  expect((await f.send('/api/device-channel/'+suffix,{method,headers:deviceHeaders,body:method==='POST'?{}:undefined})).status).toBe(404);
  expect(f.calls).toEqual([]);
 });
 it('preserves Catalog denial for a missing, rotated or unknown key',async()=>{
  f.state.deviceStatus=401;f.state.handler=(_req,res)=>reply(res,401,{message:'MCP не подключён или доступ отозван.'});
  const response=await f.send('/api/device-channel/worker/pause',{method:'POST',headers:deviceHeaders,body:{}});
  expect(response.status).toBe(401);expect(response.body).toEqual({message:'MCP не подключён или доступ отозван.'});
  expect(f.live.bridge).not.toHaveBeenCalled();
 });
});
