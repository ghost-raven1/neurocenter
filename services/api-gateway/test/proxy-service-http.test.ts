import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {proxyHttpFixture,deviceHeaders,jobId,lease,chatId} from './proxy-http.fixture';

describe.sequential('Proxy source dispatch with real AuthGuard, Axios and local HTTP',()=>{
 let f:Awaited<ReturnType<typeof proxyHttpFixture>>;
 beforeEach(async()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-proxy-internal');vi.stubEnv('NODE_ENV','production');vi.spyOn(console,'error').mockImplementation(()=>undefined);f=await proxyHttpFixture();});
 afterEach(async()=>{await f.close();vi.restoreAllMocks();vi.unstubAllEnvs();});
 it.each([401,403])('requires a fresh valid browser session (%s) before Catalog authorization or data access',async status=>{
  f.state.authStatus=status;const value=await f.send('/api/projects');expect(value.status).toBe(401);expect(f.business()).toEqual([]);expect(f.calls.filter(call=>call.path.startsWith('/internal/'))).toEqual([]);
 });
 it('does not reuse an earlier session or resource grant after either authority changes',async()=>{
  expect((await f.send('/api/projects')).status).toBe(200);f.state.allowed=false;expect((await f.send('/api/projects')).status).toBe(403);f.state.authStatus=401;expect((await f.send('/api/projects')).status).toBe(401);expect(f.business()).toHaveLength(1);
 });
 it.each([403,500])('fails closed on authorization service status %s',async status=>{
  f.state.accessStatus=status;const result=await f.send('/api/projects');expect(result.status).toBe(status===403?403:503);expect(f.business()).toEqual([]);
 });
 it.each([
  ['/api/projects','GET','catalog'],['/api/skills','GET','skills'],['/api/rag/projects','GET','rag'],['/api/feature-flags/evaluated','GET','flags'],
  ['/api/rag/%73ync/','POST','catalog'],
 ])('routes only the selected service and canonical RAG coordinator: %s',async(route,method,kind)=>{
  const result=await f.send(route,{method,body:method==='POST'?{projectKey:'prj-qa'}:undefined});expect(result.status).toBe(200);expect(f.business()[0].kind).toBe(kind);if(method==='POST')expect(f.business()[0].path).toBe('/api/rag/sync');
 });
 it('replaces spoofed identity/internal headers and forwards the bounded access context',async()=>{
  const body={projectKey:'prj-qa',projectName:'QA',path:'common/allowed',role:'Разработчик',prompt:'private body not needed by ACL',ignored:'payload'};
  const result=await f.send('/api/projects',{method:'POST',body,headers:{'X-BRIDGE-USER-ID':'attacker','X-Bridge-Roles':encodeURIComponent('Главный админ'),'x-bridge-policies':'forged','X-Neurocenter-Internal':'forged','x-neurocenter-device-id':'foreign','x-custom':'keep'}});expect(result.status).toBe(200);
  const request=f.business()[0];expect(request.headers['x-bridge-user-id']).toBe('user-qa');expect(request.headers['x-bridge-principal']).toBe('qa-owner');expect(decodeURIComponent(String(request.headers['x-bridge-roles']))).toBe('Главный админ');expect(request.headers['x-neurocenter-internal']).toBe('qa-proxy-internal');expect(request.headers).not.toHaveProperty('x-neurocenter-device-id');expect(request.headers['x-custom']).toBe('keep');
  expect(JSON.parse(decodeURIComponent(String(request.headers['x-bridge-actor'])))).toEqual({email:'owner@example.test',activeRole:'Главный админ'});expect(JSON.parse(decodeURIComponent(String(request.headers['x-bridge-policies'])))).toEqual({projects:['read']});
  expect(f.calls.find(call=>call.path==='/internal/access/authorize')!.body).toEqual({email:'owner@example.test',activeRole:'Главный админ',method:'POST',path:'/api/projects',query:{},body:{projectKey:'prj-qa',projectName:'QA',path:'common/allowed',role:'Разработчик'}});
 });
 it('copies only supported response headers and emits mutation after a successful non-inference write',async()=>{
  f.state.businessHeaders={'content-disposition':'attachment; filename="safe.json"','set-cookie':'attacker=never','x-private':'never'};
  const result=await f.send('/api/projects',{method:'PATCH',body:{name:'changed'}});expect(result.status).toBe(200);expect(result.headers.get('content-disposition')).toContain('safe.json');expect(result.headers.get('set-cookie')).toBeNull();expect(result.headers.get('x-private')).toBeNull();expect(f.live.mutation).toHaveBeenCalledExactlyOnceWith('/api/projects','owner@example.test',expect.any(Object),'PATCH');
 });
 it('preserves an explicit JSON null rather than sending an empty selection body',async()=>{
  f.state.businessPayload=null;const result=await f.send('/api/models/selected');expect(result.status).toBe(200);expect(result.body).toBeNull();expect(result.headers.get('content-type')).toMatch(/application\/json/);
 });
 it('filters private project data using current resource claims for non-main roles',async()=>{
  f.state.authRole='Разработчик';f.state.businessPayload=[{path:'common/allowed'},{path:'common/private'},{path:'project-prj-qa/allowed'},{path:'project-prj-foreign/private'}];
  expect((await f.send('/api/skills')).body).toEqual([{path:'common/allowed'},{path:'project-prj-qa/allowed'}]);
 });
 it.each([400,500])('never announces a mutation for a failed upstream status %s',async status=>{
  f.state.businessStatus=status;expect((await f.send('/api/projects',{method:'DELETE'})).status).toBe(status);expect(f.live.mutation).not.toHaveBeenCalled();
 });
 it.each([`/api/models/model-qa/ollama/api/chat`,`/api/model-chats/${chatId}/turns`])('excludes %s inference from catalog mutation events and disables saved-chat caching',async route=>{
  expect((await f.send(route,{method:'POST',body:{prompt:'hello'}})).status).toBe(200);expect(f.live.mutation).not.toHaveBeenCalled();if(route.includes('model-chats'))expect((await f.send(route)).headers.get('cache-control')).toBe('no-store');
 });
 it('uses current flags after authorization, while keeping historical reads available',async()=>{
  f.state.flags.tool_builds=false;const blocked=await f.send('/api/tool-builds',{method:'POST',body:{}});expect(blocked.status).toBe(403);expect(blocked.body).toMatchObject({code:'feature-disabled',feature:'tool_builds'});expect(blocked.headers.get('cache-control')).toBe('no-store');expect(f.business()).toEqual([]);
  f.state.flags.tool_builds=true;expect((await f.send('/api/tool-builds',{method:'POST',body:{}})).status).toBe(200);f.state.flags.tool_builds=false;expect((await f.send('/api/tool-builds/'+jobId)).status).toBe(200);
 });
 it('maps a malformed or unavailable feature snapshot to a generic failure before business dispatch',async()=>{
  f.state.flagsPayload={flags:{tool_builds:true}};const value=await f.send('/api/tool-builds',{method:'POST',body:{}});expect(value.status).toBe(503);expect(value.body).toMatchObject({code:'feature-flags-unavailable'});expect(f.business()).toEqual([]);
 });
 it.each([`/api/projects/prj-qa/learning`,`/api/projects/prj-qa/learning%2fprivate`,'/api/access/users','/api/models'])('does not grant device management or direct learning access for %s',async route=>{
  const value=await f.send(route,{headers:deviceHeaders});expect(value.status).toBe(403);expect(f.business()).toEqual([]);
 });
 it('forwards approved device project reads under the actual device identity',async()=>{
  expect((await f.send('/api/projects',{headers:deviceHeaders})).status).toBe(200);expect(f.business()[0].headers['x-neurocenter-device-id']).toBe('device-qa');
 });
 it.each(['bad-id','missing-lease','revoked','wrong-project'])('denies a %s job before forwarding a device RAG write',async mode=>{
  const headers={...deviceHeaders,'x-neurocenter-job-id':mode==='bad-id'?'invalid':jobId,'x-neurocenter-job-lease':mode==='missing-lease'?'':lease};if(mode==='revoked')f.state.jobStatus=403;if(mode==='wrong-project')f.state.job.projectId='prj-foreign';
  expect((await f.send('/api/rag/sync',{method:'POST',headers,body:{projectKey:'prj-qa'}})).status).toBe(403);expect(f.business()).toEqual([]);
 });
 it('uses the freshly authorized job role and does not accept a client-supplied receipt phase',async()=>{
  const headers={...deviceHeaders,'x-neurocenter-job-id':jobId,'x-neurocenter-job-lease':lease};expect((await f.send('/api/rag/sync?phase=snapshot-receipt',{method:'POST',headers,body:{projectKey:'prj-qa'}})).status).toBe(200);
  expect(decodeURIComponent(String(f.business()[0].headers['x-bridge-roles']))).toBe('Админ проекта');expect(f.calls.find(call=>call.path.endsWith('/authorize')&&call.path.includes('/jobs/'))!.url).not.toContain('snapshot-receipt');
 });
 it('reserves snapshot receipt recovery phase for exact status and complete publication routes',async()=>{
  const route='/api/projects/prj-qa/snapshot-uploads/'+jobId+'/status',headers={...deviceHeaders,'x-neurocenter-job-id':jobId,'x-neurocenter-job-lease':lease};expect((await f.send(route,{headers})).status).toBe(200);expect(f.calls.find(call=>call.path.includes('/jobs/'))!.url).toContain('?phase=snapshot-receipt');
 });
 it('returns a generic upstream failure and emits no mutation when the target connection closes',async()=>{
  f.state.handler=(req)=>{req.socket.destroy();};const value=await f.send('/api/projects',{method:'POST',body:{}});expect(value.status).toBe(502);expect(value.body).toEqual({error:'upstream-unavailable'});expect(f.live.mutation).not.toHaveBeenCalled();
 });
});
