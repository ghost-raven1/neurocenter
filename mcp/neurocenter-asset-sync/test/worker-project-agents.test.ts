import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isolateAgentHome} from './project-agents.fixture.js';
import {runWorker} from '../src/bridge/worker.js';
import {writeState} from '../src/bridge/state.js';
import * as workspace from '../src/bridge/workspace.js';
import {workspaceFixture} from './bridge-fixture.js';
import {BRIDGE_CAPABILITIES} from '../src/bridge/protocol.js';
import {PROJECT_AGENTS_NOTE,compileProjectAgents,createProjectAgentsPayload,validateProjectAgentsResult,type ProjectAgent,type ProjectAgentsPayload} from '../src/features/project-agents/contract.js';
import {agentFile} from '../src/features/project-agents/receipt.js';
const socket=vi.hoisted(()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}));
vi.mock('socket.io-client',()=>({io:vi.fn(()=>socket)}));

describe('Native agent jobs over the actual HTTP polling transport',()=>{
 let fixture:Awaited<ReturnType<typeof workspaceFixture>>,server:http.Server,signals:Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>;
 let payload:ProjectAgentsPayload,job:Record<string,unknown>|null,completionAttempts:Record<string,unknown>[],requests:string[],deny:boolean,loseAck:boolean,responseBytes:number;
 const id=randomUUID(),lease=randomUUID(),deviceId=randomUUID();
 const agent:ProjectAgent={id:'agent-review',slug:'nc-review',version:1,enabled:true,description:'Reviewer',prompt:'Review code.',mode:'subagent',permission:{edit:'deny',bash:'ask'}};
 beforeEach(async()=>{
  requests=[];completionAttempts=[];job=null;deny=false;loseAck=false;responseBytes=0;vi.clearAllMocks();
  signals=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
  server=http.createServer(async(req,res)=>{
   const route=req.url!.replace('/api/device-channel/','');requests.push(route);
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   expect(req.headers.authorization).toBe('Bearer fixture');let output:unknown={};
   if(route==='jobs/claim'){output=job;job=null;responseBytes=Math.max(responseBytes,Buffer.byteLength(JSON.stringify(output)));}
   if(route.endsWith('/authorize')&&deny){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({message:'revoked /Users/private/FAKE_SECRET'}));return;}
   if(route==='agents/compile'){output=compileProjectAgents(payload,body.mappings);payload.compilation=output as NonNullable<ProjectAgentsPayload['compilation']>;}
   if(route.endsWith('/complete')){
    expect(body.lease).toBe(lease);completionAttempts.push(body);
    if(loseAck){loseAck=false;res.writeHead(503,{'content-type':'application/json'});res.end('{"message":"lost ACK"}');return;}
   }
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(output));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  fixture=await workspaceFixture();await isolateAgentHome(fixture.temporary);const address=server.address() as {port:number};vi.stubEnv('NEUROCENTER_URL','http://127.0.0.1:'+address.port);
  await fs.rm(path.join(fixture.root,'.opencode'),{recursive:true});
  await workspace.setRoot(path.dirname(fixture.root));await workspace.bindProject('test-project',path.basename(fixture.root));
  await writeState('credentials',{token:'fixture',deviceId,email:'fixture@example.test'});
  payload=createProjectAgentsPayload({schemaVersion:2,projectId:'test-project',bindingId:await workspace.projectBindingId('test-project'),instanceId:await workspace.projectInstanceId('test-project'),revision:1,agents:[agent]});
  vi.spyOn(workspace,'workspaceReport').mockResolvedValue({} as never);vi.spyOn(process.stderr,'write').mockReturnValue(true);vi.spyOn(process,'exit').mockImplementation((()=>undefined) as never);
 });
 afterEach(async()=>{
  const stop=process.listeners('SIGTERM').find(listener=>!signals.get('SIGTERM')!.has(listener));stop?.();if(stop)await vi.waitFor(()=>expect(process.exit).toHaveBeenCalled());
  for(const [signal,previous]of signals)for(const listener of process.listeners(signal))if(!previous.has(listener))process.off(signal,listener);
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});
 });
 const queue=(project='test-project')=>{job={id,lease,kind:'configure-project-agents',project_id:project,payload};};
 it('polls and atomically applies a near-limit 32-agent snapshot with a durable compact completion',async()=>{
  const {manifestSha256:_manifest,...body}=payload;
  payload=createProjectAgentsPayload({...body,agents:Array.from({length:32},(_,index)=>({...agent,id:'agent-'+index,slug:'nc-review-'+index,prompt:'x'.repeat(65000)}))});
  queue();await runWorker();expect(BRIDGE_CAPABILITIES).toContain('project-agents-v2');expect(responseBytes).toBeGreaterThan(2_000_000);
  expect(completionAttempts).toHaveLength(1);const completed=completionAttempts[0]!;expect(completed.state).toBe('succeeded');expect(completed.message).toBe(PROJECT_AGENTS_NOTE);
  expect(validateProjectAgentsResult(completed.result,payload).agents).toHaveLength(32);expect(Buffer.byteLength(JSON.stringify(completed.result))).toBeLessThan(10000);
  for(const current of payload.agents)expect(await fs.readFile(path.join(fixture.root,agentFile(current.slug)),'utf8')).toContain(current.prompt);
  expect(requests).toContain(`jobs/${id}/authorize`);expect(requests).toContain(`jobs/${id}/progress`);
 });
 it('redelivers the exact committed receipt after a lost completion ACK',async()=>{
  loseAck=true;queue();await runWorker();expect(completionAttempts).toHaveLength(2);expect(completionAttempts[0]).toEqual(completionAttempts[1]);
  expect(completionAttempts[1]).toMatchObject({state:'succeeded',result:{revision:1,manifestSha256:payload.manifestSha256}});
  expect(await fs.readFile(path.join(fixture.root,agentFile(agent.slug)),'utf8')).toContain(agent.prompt);
 });
 it.each(['project','binding','instance','lease'])('rejects an invalid %s before changing project files',async issue=>{
  if(issue==='binding'||issue==='instance'){
   const {manifestSha256:_manifest,...body}=payload;payload=createProjectAgentsPayload({...body,...(issue==='binding'?{bindingId:'b'.repeat(64)}:{instanceId:randomUUID()})});
  }
  if(issue==='lease')deny=true;queue(issue==='project'?'another-project':'test-project');await runWorker();
  expect(completionAttempts[0]).toMatchObject({state:'failed',result:{}});expect(JSON.stringify(completionAttempts)).not.toMatch(/FAKE_SECRET|\/Users/);
  await expect(fs.stat(path.join(fixture.root,agentFile(agent.slug)))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('reports a safe local conflict without overwriting a user agent',async()=>{
  await fs.mkdir(path.join(fixture.root,'.opencode/agents'));await fs.writeFile(path.join(fixture.root,agentFile(agent.slug)),'user prompt /Users/private/FAKE_SECRET');queue();await runWorker();
  expect(completionAttempts[0]).toMatchObject({state:'failed',result:{},message:expect.stringContaining('Конфликт')});expect(JSON.stringify(completionAttempts)).not.toMatch(/FAKE_SECRET|\/Users/);
  expect(await fs.readFile(path.join(fixture.root,agentFile(agent.slug)),'utf8')).toBe('user prompt /Users/private/FAKE_SECRET');
 });
});
