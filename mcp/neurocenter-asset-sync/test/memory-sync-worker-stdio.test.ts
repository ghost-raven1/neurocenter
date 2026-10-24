import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash,hub,readState} from '../src/bridge/state.js';
import type {Completion} from '../src/bridge/completions.js';
import {runLearningMemoryJob} from '../src/features/project-learning-memory-sync/worker.js';
import {connectMemory} from '../src/features/project-learning-memory-sync/memory-client.js';
import {journalKey,projectionStorage} from '../src/features/project-learning-memory-sync/receipts.js';
import {memoryDigest,memoryEntity,memoryNamespace,type MemorySyncPayload} from '../src/features/project-learning-memory-sync/contract.js';
import {createLearningContext} from '../../../services/shared/project-learning.cjs';
import {packageFixture} from './bridge-fixture.js';

const execute=promisify(execFile),site='https://memory-worker-fixture.invalid';
const deviceId='44444444-4444-4444-8444-444444444444',privateText='approved private fixture text';
const entrypoint=fileURLToPath(new URL('./fixtures/memory-sync-durable-server.mjs',import.meta.url));
const receiptsSource=fileURLToPath(new URL('../src/features/project-learning-memory-sync/receipts.ts',import.meta.url));
type FixtureEvent={kind:string;pid?:number;names?:string[]};

/** No installed runtime, device credential, or user workspace participates in this stdio fixture. */
function memoryPackage():Package{
 const pkg=packageFixture('mcp');pkg.schemaVersion=5;
 pkg.config={command:'node',entrypoint:'entrypoint.mjs',extra:{learningMemory:{schemaVersion:1,package:'@modelcontextprotocol/server-memory',version:'1.0.0',projectionSchemaVersion:1}}};
 pkg.files[0]!.path='entrypoint.mjs';
 pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:pkg.files.map(({path,size,sha256})=>({path,size,sha256}))})));
 return pkg;
}

describe('Memory worker with a durable real SDK stdio boundary',()=>{
 let temporary:string,root:string,privateRoot:string,payload:MemorySyncPayload,pkg:Package;
 let context:ReturnType<typeof createLearningContext>,cancellation:AbortController,authorized:boolean;
 let running:ReturnType<typeof runLearningMemoryJob>|undefined;
 const job=()=>({id:randomUUID(),lease:randomUUID(),payload:{memory:payload}});
 const events=async():Promise<FixtureEvent[]>=>{
  try{return (await fs.readFile(path.join(root,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
 };
 const mutations=(items:FixtureEvent[])=>items.filter(item=>['create','add','remove'].includes(item.kind));
 const durableBytes=()=>Promise.all(['graph.json','events.jsonl'].map(name=>fs.readFile(path.join(root,name),'utf8')));
 const namespace=()=>memoryNamespace(hub(),payload.projectId);
 const journal=async()=>(await projectionStorage(journalKey(hub(),payload),namespace())).journal;
 const expectedEntity=()=>memoryEntity(namespace(),context.entries[0]!);
 const control=(holdCreateAck:boolean)=>fs.writeFile(path.join(root,'control.json'),JSON.stringify({fixture:'memory-sync-durable-v1',holdCreateAck}),{mode:0o600});

 beforeEach(async()=>{
  temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-memory-worker-stdio-')));
  root=path.join(temporary,'memory');privateRoot=path.join(temporary,'private');
  await fs.mkdir(root,{mode:0o700});await fs.mkdir(privateRoot,{mode:0o700});
  vi.stubEnv('NEUROCENTER_BRIDGE_HOME',privateRoot);vi.stubEnv('NEUROCENTER_URL',site);
  vi.stubEnv('NEUROCENTER_API_URL','http://127.0.0.1:1');
  pkg=memoryPackage();context=createLearningContext({projectId:'memory-worker-project',revision:1,entries:[{
   id:randomUUID(),key:'approved-fixture',version:1,kind:'lesson',title:'Approved fixture',content:privateText,targetAgentId:null,
   hypothesisId:randomUUID(),checkId:randomUUID(),approvedAt:'2026-10-24T00:00:00.000Z',
  }]});
  payload={schemaVersion:1,projectId:context.projectId,bindingId:'a'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111',
   assetId:pkg.plugin.id,version:pkg.plugin.version,manifest:pkg.manifest.sha256,learningRevision:context.revision,learningDigest:context.digest,mode:'sync'};
  cancellation=new AbortController();authorized=true;await control(false);
  await fs.writeFile(path.join(root,'graph.json'),JSON.stringify({entities:[],relations:[]}),{mode:0o600});
 });
 afterEach(async()=>{
  cancellation.abort();
  try{await running;}finally{running=undefined;vi.unstubAllEnvs();await fs.rm(temporary,{recursive:true,force:true});}
 });

 function run(value=job()){
  running=runLearningMemoryJob(value,deviceId,async()=>{if(!authorized)throw new Error('Controlled authorization revocation');}, {
   context:async()=>({schemaVersion:1,payload,context,package:pkg}),
   target:async()=>({site,root,runtime:{target:'fixture',sha256:'f'.repeat(64),root,entrypoint,executable:false},assertCurrent:async()=>{}}),
   // Cancel the actual SDK request; this does not exercise the server DeviceJobs.cancel endpoint.
   connect:(entry,cwd,signal)=>connectMemory(entry,cwd,AbortSignal.any([signal,cancellation.signal])),
  });
  return running;
 }
 /** Watch before the first read so a fast child cannot lose the durable-write barrier event. */
 async function waitForCreate(){
  const barrier=path.join(root,'create-held.json');
  await new Promise<void>((resolve,reject)=>{
   const watcher=watch(root,()=>{void check();});
   const timeout=setTimeout(()=>finish(new Error('The durable Memory create barrier was not reached')),5000);
   function finish(error?:Error){clearTimeout(timeout);watcher.close();error?reject(error):resolve();}
   async function check(){try{await fs.access(barrier);finish();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')finish(error as Error);}}
   watcher.on('error',finish);void check();
  });
 }
 async function abortAfterDurableCreate(mode:'transport'|'authorization'='transport'){
  await control(true);const first=job(),completion=run(first);await waitForCreate();
  expect((await journal()).plan?.steps.map(step=>step.state)).toEqual(['intent']);
  expect(JSON.parse(await fs.readFile(path.join(root,'graph.json'),'utf8')).entities).toEqual([expectedEntity()]);
  expect(mutations(await events())).toEqual([{kind:'create',names:[expectedEntity().name]}]);
  if(mode==='authorization')authorized=false;
  else cancellation.abort(new Error('Controlled cancellation after durable create, before ACK'));
  const result=await completion;
  expect(result).toMatchObject({state:'failed',result:{status:'partial',code:mode==='authorization'?'authorization':'unavailable',applied:0,removed:0,remaining:1}});
  expect(result.message).toContain('сохранённый план');
  expect((await journal()).plan?.steps.map(step=>step.state)).toEqual(['intent']);
  expect((await events()).filter(item=>item.kind==='create-ack')).toEqual([]);
  return {first,result};
 }
 /** A fresh process can only deliver public checkpoints; it never imports or starts the MCP client. */
 async function recoverAfterRestart():Promise<Completion[]>{
  const source=`import {recoverMemoryCompletions} from ${JSON.stringify(receiptsSource)};const results=[];await recoverMemoryCompletions(async value=>{results.push(value);});process.stdout.write(JSON.stringify(results));`;
  const {stdout,stderr}=await execute(process.execPath,['--import','tsx','--input-type=module','-e',source],{
   cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,NEUROCENTER_BRIDGE_HOME:privateRoot,NEUROCENTER_URL:site},timeout:5000,maxBuffer:1024*1024,
  });
  expect(stderr).toBe('');return JSON.parse(stdout) as Completion[];
 }

 describe('Acknowledged creation',()=>{
  it('publishes a complete public checkpoint only after the real Memory graph confirms its owned entity',async()=>{
   const current=job(),result=await run(current);
   expect(result).toMatchObject({state:'succeeded',result:{status:'complete',code:'none',applied:1,removed:0,remaining:0}});
   const saved=await journal();expect(saved.owned).toEqual({[expectedEntity().name]:expectedEntity()});
   expect(saved.plan?.steps.map(step=>step.state)).toEqual(['done']);
   expect(mutations(await events())).toEqual([{kind:'create',names:[expectedEntity().name]}]);
   const before=await durableBytes(),recovered=await recoverAfterRestart();
   expect(recovered).toMatchObject([{id:current.id,lease:current.lease,deviceId,state:'succeeded',result:result.result}]);
   expect(await durableBytes()).toEqual(before);expect(JSON.stringify(recovered)).not.toContain(privateText);
  },15000);
 });
 describe('Durable creation with an unacknowledged result',()=>{
  it('authorization revocation aborts the pending SDK call and recovery reports uncertainty without reconnecting or replaying',async()=>{
   const {first,result}=await abortAfterDurableCreate('authorization');const before=await durableBytes();
   const recovered=await recoverAfterRestart();
   expect(recovered).toMatchObject([{id:first.id,lease:first.lease,deviceId,state:'failed',result:result.result}]);
   expect(await durableBytes()).toEqual(before);expect((await events()).filter(item=>item.kind==='connect')).toHaveLength(1);
   expect((await journal()).owned).toEqual({});
   expect(JSON.stringify(await readState('learning-memory-pending'))).not.toContain(privateText);
   expect(JSON.stringify(recovered)).not.toContain(privateText);
  },15000);
  it('an explicit fresh job with the same ownership and plan reconciles the durable entity without a second create',async()=>{
   const {first,result:partial}=await abortAfterDurableCreate(),saved=await journal();
   expect(saved.plan?.digest).toBe(memoryDigest([site,payload]));
   cancellation=new AbortController();await control(false);
   const retry=job(),result=await run(retry);
   expect(retry.id).not.toBe(first.id);expect(retry.lease).not.toBe(first.lease);
   expect(result).toMatchObject({state:'succeeded',result:{status:'complete',code:'none',applied:1,removed:0,remaining:0}});
   const completed=await journal();expect(completed.plan?.digest).toBe(saved.plan?.digest);
   expect(completed.plan?.steps.map(step=>step.state)).toEqual(['done']);expect(completed.owned).toEqual({[expectedEntity().name]:expectedEntity()});
   const observed=await events(),retryEvents=observed.slice(observed.findLastIndex(item=>item.kind==='connect')+1);
   expect(observed.filter(item=>item.kind==='connect')).toHaveLength(2);
   expect(retryEvents.some(item=>item.kind==='open'&&item.names?.includes(expectedEntity().name))).toBe(true);
   expect(mutations(observed)).toEqual([{kind:'create',names:[expectedEntity().name]}]);
   expect(JSON.parse(await fs.readFile(path.join(root,'graph.json'),'utf8')).entities).toEqual([expectedEntity()]);
   const beforeRecovery=await durableBytes(),recovered=await recoverAfterRestart();
   expect(recovered).toMatchObject([{id:first.id,state:'failed',result:partial.result},{id:retry.id,state:'succeeded',result:result.result}]);
   expect(await durableBytes()).toEqual(beforeRecovery);expect(JSON.stringify(recovered)).not.toContain(privateText);
  },15000);
 });
});
