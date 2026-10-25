import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {deviceHeaders,jobId,lease,proxyHttpFixture,reply} from './proxy-http.fixture';
const actions=['claim','authorize','context','next','dispatch','result','complete'];
const path=(action:string)=>'/api/device-channel/system-role-mcp/'+action;
const body={jobId,lease,callId:jobId,result:{state:'succeeded',value:{text:'private fixture result',isError:false,truncated:false}}};

/** Real HTTP proxy and AuthGuard; catalogue responses establish routing only, never private MCP call authority. */
describe.sequential('private MCP transport lane across the actual Gateway boundary',()=>{
 let fixture:Awaited<ReturnType<typeof proxyHttpFixture>>;
 beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');fixture=await proxyHttpFixture();});
 afterEach(async()=>{await fixture.close();vi.restoreAllMocks();vi.unstubAllEnvs();});
 it.each(actions)('forwards only the exact POST %s route and server-owned internal headers',async action=>{
  const response=await fixture.send(path(action),{method:'POST',headers:{...deviceHeaders,'x-neurocenter-internal':'forged','x-bridge-user-id':'forged'},body});
  expect(response.status).toBe(200);
  const upstream=fixture.calls.find(call=>call.path==='/internal/device-channel/system-role-mcp/'+action);
  expect(upstream?.body).toEqual(body);expect(upstream?.headers.authorization).toBe(deviceHeaders.authorization);
  expect(upstream?.headers['x-neurocenter-internal']).toBe('qa-proxy-internal');expect(upstream?.headers['x-bridge-user-id']).toBeUndefined();
 });
 it.each(['claim/extra','context/extra','dispatch/extra','execute','status','../internal/system-role-mcp/context'])('rejects an unlisted or nested path: %s',async action=>{
  expect((await fixture.send(path(action),{method:'POST',headers:deviceHeaders,body})).status).toBe(404);expect(fixture.calls).toEqual([]);
 });
 it.each(['GET','PUT','PATCH','DELETE'])('rejects %s even on an otherwise valid private path',async method=>{
  expect((await fixture.send(path('context'),{method,headers:deviceHeaders,...(method==='GET'?{}:{body})})).status).toBe(404);expect(fixture.calls).toEqual([]);
 });
 it.each(['claim','context','dispatch'])('denies a new %s after device revocation',async action=>{
  fixture.state.deviceStatus=401;expect((await fixture.send(path(action),{method:'POST',headers:deviceHeaders,body})).status).toBe(401);
  expect(fixture.calls.some(call=>call.path==='/internal/device-channel/system-role-mcp/'+action)).toBe(false);
 });
 it.each(['result','complete'])('forwards retained %s after revocation and flag-off for catalogue proof validation only',async action=>{
  fixture.state.deviceStatus=401;fixture.state.flags.system_role_mcp=false;fixture.state.flags.computer_connections=false;
  expect((await fixture.send(path(action),{method:'POST',headers:deviceHeaders,body})).status).toBe(200);
  expect(fixture.calls.find(call=>call.path==='/internal/device-channel/system-role-mcp/'+action)?.headers.authorization).toBe(deviceHeaders.authorization);
  expect(fixture.live.bridge).not.toHaveBeenCalled();
 });
 it('blocks a new claim with its flag off while receipt-only delivery remains available',async()=>{
  fixture.state.flags.system_role_mcp=false;
  expect((await fixture.send(path('claim'),{method:'POST',headers:deviceHeaders,body:{}})).status).toBe(403);
  expect(fixture.calls.some(call=>call.path==='/internal/device-channel/system-role-mcp/claim')).toBe(false);
  expect((await fixture.send(path('result'),{method:'POST',headers:deviceHeaders,body})).status).toBe(200);
 });
 it('preserves the catalogue denial for a foreign or changed private receipt',async()=>{
  fixture.state.deviceStatus=401;fixture.state.handler=(_req,res)=>reply(res,409,{message:'Fixture rejected the retained proof'});
  expect((await fixture.send(path('result'),{method:'POST',headers:deviceHeaders,body})).status).toBe(409);
  expect(fixture.live.sections).not.toHaveBeenCalled();
 });
 it('maps a disconnected catalogue transport to 502 without forwarding arbitrary internal paths',async()=>{
  fixture.state.handler=(req)=>{req.socket.destroy();};
  expect((await fixture.send(path('context'),{method:'POST',headers:deviceHeaders,body})).status).toBe(502);
  expect(fixture.calls.filter(call=>call.path.startsWith('/internal/device-channel/system-role-mcp/')).map(call=>call.path)).toEqual(['/internal/device-channel/system-role-mcp/context']);
 });
});
