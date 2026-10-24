import fs from 'node:fs/promises';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {isolateAgentHome} from './project-agents.fixture.js';
import {writeState} from '../src/bridge/state.js';
import * as workspace from '../src/bridge/workspace.js';
import {runWorker} from '../src/bridge/worker.js';
import {DEVICE_CODEX_JOB} from '../src/features/device-codex-inference/contract.js';
const controls=vi.hoisted(()=>({entered:undefined as undefined|(()=>void),codex:vi.fn(),mcpStopped:false}));
vi.mock('socket.io-client',()=>({io:()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()})}));
vi.mock('../src/features/device-codex-inference/executor.js',()=>({runDeviceCodexJob:async(...args:unknown[])=>{
 controls.codex(...args);return {state:'succeeded',message:'Synthetic model dispatch completed',result:{}};
}}));
vi.mock('../src/features/system-role-mcp/worker.js',()=>({runSystemRoleMcpJob:async(_job:unknown,_device:unknown,_authorize:unknown,_deps:unknown,signal:AbortSignal)=>{
 controls.entered?.();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{controls.mcpStopped=true;resolve();},{once:true}));
 return {state:'failed',message:'Cancelled fixture transport',result:{closed:true}};
}}));

describe('ordinary worker dispatch remains independent of a stalled MCP transport lease',()=>{
 let server:http.Server|undefined,temporary:string|undefined,signals=new Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>();
 afterEach(async()=>{
  const stop=process.listeners('SIGTERM').find(listener=>!signals.get('SIGTERM')?.has(listener));stop?.();
  if(stop)await vi.waitFor(()=>expect(process.exit).toHaveBeenCalled());
  for(const [signal,previous]of signals)for(const listener of process.listeners(signal))if(!previous.has(listener))process.off(signal,listener);
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  vi.restoreAllMocks();vi.unstubAllEnvs();if(temporary)await fs.rm(temporary,{recursive:true,force:true});
 });
 it('claims a Codex job on the same device while its separate browser session is still blocked',async()=>{
  controls.codex.mockReset();controls.mcpStopped=false;let entered!:()=>void;const browserEntered=new Promise<void>(resolve=>entered=resolve);controls.entered=entered;
  signals=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
  const deviceId=randomUUID(),sessionId=randomUUID(),lease=randomUUID(),modelId=randomUUID();let sessionClaimed=false,modelClaimed=false;
  server=http.createServer(async(req,res)=>{
   const route=req.url!.replace('/api/device-channel/','');for await(const _chunk of req){/* Drain bounded fixture body. */}
   expect(req.headers.authorization).toBe('Bearer fixture');let value:unknown={};
   if(route==='system-role-mcp/claim'){value=sessionClaimed?null:{id:sessionId,lease,kind:'system-role-mcp-session',project_id:'test-project',payload:{sessionId}};sessionClaimed=true;}
   if(route==='jobs/claim'){
    await browserEntered;
    value=modelClaimed?null:{id:modelId,lease,kind:DEVICE_CODEX_JOB,payload:{},project_id:'test-project'};modelClaimed=true;
   }
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const fixture=await workspaceFixture();temporary=fixture.temporary;await isolateAgentHome(fixture.temporary);
  vi.stubEnv('NEUROCENTER_URL','http://127.0.0.1:'+(server.address()as {port:number}).port);
  await writeState('credentials',{token:'fixture',deviceId,email:'fixture@example.test'});
  vi.spyOn(workspace,'workspaceReport').mockResolvedValue({}as never);vi.spyOn(process.stderr,'write').mockReturnValue(true);vi.spyOn(process,'exit').mockImplementation((()=>undefined)as never);
  await runWorker();expect(sessionClaimed).toBe(true);expect(controls.mcpStopped).toBe(false);
  expect(controls.codex).toHaveBeenCalledOnce();expect(controls.codex.mock.calls[0]?.[1]).toBe(deviceId);
 },10000);
});
