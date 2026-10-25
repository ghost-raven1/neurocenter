import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {deviceHeaders,jobId,proxyHttpFixture,reply} from './proxy-http.fixture';
const routes=['/api/agent-tools/capabilities?projectId=prj-qa','/api/agent-tools/steps?projectId=prj-qa&turnId='+jobId,'/api/agent-tools/steps/'+jobId];
/** The real gateway retains fresh owner boundaries and never caches a previous user's tool receipt. */
describe.sequential('Agent tool metadata and receipts through the browser gateway',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
 beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');f=await proxyHttpFixture();});
 afterEach(async()=>{await f?.close();vi.unstubAllEnvs();});
 it.each(routes)('forwards %s as a fresh read without starting work',async route=>{
  f.state.businessHeaders={'cache-control':'public, max-age=3600'};const result=await f.send(route);
  expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');expect(f.business()).toHaveLength(1);expect(f.business()[0]).toMatchObject({kind:'catalog',method:'GET',path:route.split('?')[0]});expect(f.live.mutation).not.toHaveBeenCalled();
 });
 it.each(['session','role','device'])('keeps a %s denial uncached and away from tool metadata',async cause=>{
  if(cause==='session')f.state.authStatus=401;if(cause==='role')f.state.allowed=false;
  const result=await f.send(routes[2],cause==='device'?{headers:deviceHeaders}:{});expect(result.status).toBe(cause==='session'?401:403);expect(result.headers.get('cache-control')).toBe('no-store');expect(f.business()).toEqual([]);
 });
 it('preserves read-only history when execution flags are off and never replays a model request',async()=>{
  for(const key of Object.keys(f.state.flags))f.state.flags[key as keyof typeof f.state.flags]=false;
  expect((await f.send(routes[2])).status).toBe(200);expect(f.calls.some(call=>call.path==='/internal/feature-flags/evaluated')).toBe(false);expect(f.business().map(call=>call.method)).toEqual(['GET']);
 });
 it('uses the new owner after a session switch instead of serving the previous private result',async()=>{
  f.state.handler=(_req,res,call)=>{const actor=JSON.parse(decodeURIComponent(String(call.headers['x-bridge-actor'])));reply(res,actor.email==='owner@example.test'?200:404,{owner:actor.email});};
  expect((await f.send(routes[2])).status).toBe(200);f.state.authEmail='other@example.test';const foreign=await f.send(routes[2]);expect(foreign.status).toBe(404);expect(foreign.headers.get('cache-control')).toBe('no-store');
 });
});
