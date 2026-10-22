import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {jobId,proxyHttpFixture} from './proxy-http.fixture';

/** Exercise recovery through the browser gateway, including fresh authorization and unavailable flags. */
describe.sequential('Packaging cancellation through the real gateway and HTTP peers',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
 beforeEach(async()=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');vi.stubEnv('NODE_ENV','production');
  vi.spyOn(console,'error').mockImplementation(()=>undefined);f=await proxyHttpFixture();
 });
 afterEach(async()=>{await f.close();vi.restoreAllMocks();vi.unstubAllEnvs();});

 it.each([`/api/tool-builds/${jobId}`,`/api/tool-builds/requests/${jobId}`])('keeps DELETE %s available when creation is disabled and the flag service is down',async route=>{
  f.state.flags.tool_builds=false;f.state.flags.tool_catalog=false;f.state.flagsStatus=503;
  f.state.businessPayload={requestKey:jobId,state:'CANCELLING',build:{id:jobId,state:'CANCELLING'}};
  const result=await f.send(route,{method:'DELETE'});
  expect(result.status).toBe(200);expect(result.body).toEqual(f.state.businessPayload);
  expect(f.business()).toHaveLength(1);expect(f.business()[0]).toMatchObject({kind:'catalog',path:route,method:'DELETE'});
  expect(f.calls.filter(call=>call.path==='/internal/feature-flags/evaluated')).toEqual([]);
  expect(f.calls.find(call=>call.path==='/internal/access/authorize')?.body).toMatchObject({email:'owner@example.test',activeRole:'Главный админ',method:'DELETE',path:route});
 });

 it('rechecks a revoked resource grant on retry without forwarding a second cancellation',async()=>{
  const route=`/api/tool-builds/requests/${jobId}`;
  expect((await f.send(route,{method:'DELETE'})).status).toBe(200);
  f.state.allowed=false;
  expect((await f.send(route,{method:'DELETE'})).status).toBe(403);
  expect(f.business()).toHaveLength(1);
  expect(f.calls.filter(call=>call.path==='/internal/access/authorize')).toHaveLength(2);
 });

 it('rechecks the browser session before recovery and never relies on a previous successful request',async()=>{
  const route=`/api/tool-builds/${jobId}`;
  expect((await f.send(route,{method:'DELETE'})).status).toBe(200);
  f.state.authStatus=401;
  expect((await f.send(route,{method:'DELETE'})).status).toBe(401);
  expect(f.business()).toHaveLength(1);
 });

 it('preserves an upstream publication fence response without inventing a terminal cancellation',async()=>{
  f.state.businessPayload={id:jobId,state:'RUNNING',publicationStartedAt:'2026-10-23T00:00:00.000Z'};
  expect((await f.send(`/api/tool-builds/${jobId}`,{method:'DELETE'})).body).toEqual(f.state.businessPayload);
 });

 it('reports an unknown cancellation acknowledgement as a recoverable upstream failure',async()=>{
  f.state.handler=req=>{req.socket.destroy();};
  const result=await f.send(`/api/tool-builds/requests/${jobId}`,{method:'DELETE'});
  expect(result.status).toBe(502);expect(result.body).toEqual({error:'upstream-unavailable'});
  expect(f.live.mutation).not.toHaveBeenCalled();
 });
});
