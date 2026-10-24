import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {writeState,stateDir} from '../src/bridge/state.js';
import {startRoleMcpPoller} from '../src/features/system-role-mcp/poller.js';
import {captureRoleMcpIdentity,roleMcpApi} from '../src/features/system-role-mcp/api.js';
import {saveRoleMcpResult} from '../src/features/system-role-mcp/receipts.js';
import type {SessionJob} from '../src/features/system-role-mcp/worker.js';

describe('durable session completion across actual loopback transport uncertainty',()=>{
 let server:http.Server|undefined,temporary:string|undefined;const pollers:ReturnType<typeof startRoleMcpPoller>[]=[];
 afterEach(async()=>{await Promise.all(pollers.splice(0).map(poller=>poller.stop()));server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));vi.restoreAllMocks();vi.unstubAllEnvs();if(temporary)await fs.rm(temporary,{recursive:true,force:true});});
 async function setup(handle:(route:string,body:any,req:http.IncomingMessage,res:http.ServerResponse)=>Promise<void>,token=()=> 'private-fixture-token'){
  ({temporary}=await workspaceFixture());server=http.createServer(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;expect(req.headers.authorization).toBe('Bearer '+token());await handle(req.url!.split('/').at(-1)!,JSON.parse(body),req,res);}catch(error){res.destroy(error as Error);}});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address()as {port:number}).port;
  vi.stubEnv('NEUROCENTER_URL',origin);vi.stubEnv('NEUROCENTER_API_URL',origin);await writeState('credentials',{deviceId:randomUUID(),token:'private-fixture-token',email:'fixture@example.test'});
 }
 const answer=(res:http.ServerResponse,body:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 const jobs=(requestId:string):SessionJob=>{const id=randomUUID();return {id,lease:randomUUID(),requestId,project_id:'project',payload:{sessionId:id}};};
 it('replays the same post-cleanup completion after a lost HTTP acknowledgement without running the tool twice',async()=>{
  let allocated:SessionJob|undefined,accept=false;const bodies:unknown[]=[];let runs=0,home='';
  await setup(async(route,body,req,res)=>{
   if(route==='claim'){if(body.recoveryOnly)return answer(res,allocated&&body.requestId===allocated.requestId?{...allocated,recoveryOnly:true}:null);if(!allocated){allocated=jobs(body.requestId);return answer(res,allocated);}return answer(res,null);}
   if(route==='complete'){bodies.push(body);await expect(fs.lstat(home)).rejects.toMatchObject({code:'ENOENT'});const files=await fs.readdir(path.join(stateDir(),'system-role-mcp-sessions'));const records=await Promise.all(files.map(async file=>JSON.parse(await fs.readFile(path.join(stateDir(),'system-role-mcp-sessions',file),'utf8'))));const saved=records.find(item=>item.job?.id===body.jobId);expect(saved.phase).toBe('closed');expect(JSON.stringify(saved)).not.toContain('private-fixture-token');if(!accept){req.socket.destroy();return;}return answer(res,{ok:true,closed:true});}
   answer(res,{});
  });
  const first=startRoleMcpPoller({recover:async()=>{},run:async(job,_device,_authorize,deps)=>{
   runs++;const own=await deps.ownership!.home();home=own.path;await fs.writeFile(path.join(home,'private.tmp'),'owned-only');await own.close();
   return {state:'succeeded',message:'cleaned',result:{schemaVersion:1,sessionId:job.id,closed:true}};
  }});pollers.push(first);
  await vi.waitFor(()=>expect(bodies.length).toBeGreaterThan(0));await first.stop();expect(runs).toBe(1);const exact=bodies[0];accept=true;
  const second=startRoleMcpPoller({recover:async()=>{},run:async()=>{throw new Error('recovery must not execute');}});pollers.push(second);
  await vi.waitFor(()=>expect(bodies.length).toBeGreaterThan(1));await vi.waitFor(async()=>expect(await fs.readdir(path.join(stateDir(),'system-role-mcp-sessions'))).toEqual([]));await second.stop();
  expect(bodies.slice(1).every(body=>JSON.stringify(body)===JSON.stringify(exact))).toBe(true);expect(runs).toBe(1);
 });
 it('recovers a claim whose allocation reply was lost without acquiring execution authority',async()=>{
  let allocated:SessionJob|undefined,recovered=false,completed=false;const requests:any[]=[];
  await setup(async(route,body,req,res)=>{
   if(route==='claim'){requests.push(body);if(body.recoveryOnly){recovered=true;return answer(res,allocated?{...allocated,recoveryOnly:true}:null);}if(!allocated){allocated=jobs(body.requestId);req.socket.destroy();return;}return answer(res,null);}
   if(route==='complete'){expect(recovered).toBe(true);completed=true;return answer(res,{ok:true,closed:true});}answer(res,{});
  });
  const run=vi.fn(async()=>{throw new Error('no tool may run after an unconfirmed claim');}),first=startRoleMcpPoller({recover:async()=>{},run});pollers.push(first);
  await vi.waitFor(()=>expect(allocated).toBeDefined());await first.stop();const second=startRoleMcpPoller({recover:async()=>{},run});pollers.push(second);
  await vi.waitFor(()=>expect(completed).toBe(true));await second.stop();expect(run).not.toHaveBeenCalled();expect(requests).toContainEqual({requestId:allocated!.requestId,recoveryOnly:true});
 });
 it('recovers a claimed session after a transient private work-directory setup failure without restart or tool launch',async()=>{
  let allocated:SessionJob|undefined,failed=false,completed=false,recovered=false;
  await setup(async(route,body,_req,res)=>{
   if(route==='claim'){if(body.recoveryOnly){expect(body.requestId).toBe(allocated!.requestId);recovered=true;return answer(res,{...allocated,recoveryOnly:true});}if(!allocated){allocated=jobs(body.requestId);return answer(res,allocated);}return answer(res,null);}
   if(route==='complete'){completed=true;return answer(res,{ok:true,closed:true});}answer(res,{});
  });
  const original=fs.mkdir.bind(fs);vi.spyOn(fs,'mkdir').mockImplementation(async(directory,...options)=>{if(!failed&&String(directory).endsWith('system-role-mcp-work')){failed=true;throw Object.assign(new Error('transient private work setup failure'),{code:'ENOSPC'});}return original(directory,...options as never);});
  const run=vi.fn(async()=>{throw new Error('setup failed before execution');}),poller=startRoleMcpPoller({recover:async()=>{},run});pollers.push(poller);
  await vi.waitFor(()=>expect(failed).toBe(true));poller.wake();await vi.waitFor(()=>expect(completed).toBe(true),{timeout:2500});expect(recovered).toBe(true);expect(run).not.toHaveBeenCalled();
 });
 it('does not deliver a retained completion to a replaced token, API origin or physical profile',async()=>{
  let requests=0;await setup(async(_route,_body,_req,res)=>{requests++;answer(res,{ok:true,closed:true});});const identity=await captureRoleMcpIdentity();
  vi.stubEnv('NEUROCENTER_API_URL','http://127.0.0.1:9');await expect(roleMcpApi('complete',{},undefined,identity)).rejects.toThrow('другому');vi.stubEnv('NEUROCENTER_API_URL',identity.apiUrl);
  await writeState('credentials',{deviceId:identity.deviceId,token:'replacement',email:'fixture@example.test'});await expect(roleMcpApi('complete',{},undefined,identity)).rejects.toThrow('другому');
  await writeState('credentials',{deviceId:identity.deviceId,token:'private-fixture-token',email:'fixture@example.test'});
  await fs.rename(identity.profile,identity.profile+'.previous');await fs.mkdir(identity.profile,{mode:0o700});await writeState('credentials',{deviceId:identity.deviceId,token:'private-fixture-token',email:'fixture@example.test'});
  await expect(roleMcpApi('complete',{},undefined,identity)).rejects.toThrow('другому');expect(requests).toBe(0);
 });
 it('archives only already closed old-token proof and preserves uncertain result files after renewal',async()=>{
  let allocated:SessionJob|undefined,token='private-fixture-token',completes=0,newClaims=0;
  await setup(async(route,body,req,res)=>{
   if(route==='claim'){if(token==='replacement'){newClaims++;return answer(res,null);}if(!allocated){allocated=jobs(body.requestId);return answer(res,allocated);}return answer(res,null);}
   if(route==='complete'){completes++;req.socket.destroy();return;}answer(res,{});
  },()=>token);
  const first=startRoleMcpPoller({recover:async()=>{},run:async job=>({state:'succeeded',message:'cleaned',result:{schemaVersion:1,sessionId:job.id,closed:true}})});pollers.push(first);
  await vi.waitFor(()=>expect(completes).toBeGreaterThan(0));await first.stop();const before=await fs.readFile(path.join(stateDir(),'system-role-mcp-sessions',allocated!.requestId+'.json'));
  const identity=await captureRoleMcpIdentity(),callId=randomUUID();await saveRoleMcpResult({jobId:allocated!.id,lease:allocated!.lease,callId,result:{state:'unknown',message:'Unknown fixture result'}},identity.deviceId,'call',identity);
  const unknown=path.join(stateDir(),'system-role-mcp-receipts',callId+'.json'),unknownBefore=await fs.readFile(unknown);
  token='replacement';await writeState('credentials',{deviceId:identity.deviceId,token,email:'fixture@example.test'});const previous=completes;
  const second=startRoleMcpPoller({run:async()=>{throw new Error('no allocation');}});pollers.push(second);
  await vi.waitFor(()=>expect(newClaims).toBeGreaterThan(0));await second.stop();expect(completes).toBe(previous);
  expect(await fs.readFile(path.join(stateDir(),'system-role-mcp-closed-archive',allocated!.requestId+'.json'))).toEqual(before);expect(await fs.readFile(unknown)).toEqual(unknownBefore);
 });
});
