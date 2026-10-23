import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash,hub,stateDir,writeState} from '../src/bridge/state.js';
import {install} from '../src/bridge/installer.js';
import {assetBase} from '../src/bridge/installation-receipt.js';
import {commitProjectBinding,prepareProjectBinding,projectBindingId,projectFolder,projectInstanceId,recoverPendingWorkspaceIdentity} from '../src/bridge/workspace.js';
import {verifyWorkspaceInstallations} from '../src/bridge/workspace-installations.js';
import {journalKey,projectionStorage,publicMemoryResult,recoverMemoryCompletions,saveMemoryCheckpoint} from '../src/features/project-learning-memory-sync/receipts.js';
import {memoryTarget} from '../src/features/project-learning-memory-sync/target.js';
import * as runtimeCache from '../src/features/runtime-artifacts/cache.js';
import {projectMemory} from '../src/features/project-learning-memory-sync/projection.js';
import {memoryDigest,memoryNamespace,type MemoryEntity,type MemorySyncPayload} from '../src/features/project-learning-memory-sync/contract.js';
import type {MemoryPort} from '../src/features/project-learning-memory-sync/memory-client.js';
import {writePrivateConfiguration} from '../src/features/local-configuration/private-store.js';
import {runLearningMemoryJob} from '../src/features/project-learning-memory-sync/worker.js';
import {createLearningContext} from '../../../services/shared/project-learning.cjs';
import {packageFixture,workspaceFixture} from './bridge-fixture.js';

const projectId='test-project',noop=async()=>{};
function memoryPackage():Package{
 const pkg=packageFixture('mcp');pkg.schemaVersion=5;
 pkg.config={command:'node',entrypoint:'entrypoint.mjs',extra:{learningMemory:{schemaVersion:1,package:'@modelcontextprotocol/server-memory',version:'1.0.0',projectionSchemaVersion:1}}};
 pkg.files[0]!.path='entrypoint.mjs';
 pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:pkg.files.map(({path,size,sha256})=>({path,size,sha256}))})));
 return pkg;
}

describe('Memory ownership across verified workspace identity transitions',()=>{
 let fixture:Awaited<ReturnType<typeof workspaceFixture>>,pkg:Package,namespace:string;
 let graph:Map<string,MemoryEntity>,mutations:string[],port:MemoryPort;
 beforeEach(async()=>{
  fixture=await workspaceFixture();pkg=memoryPackage();namespace=memoryNamespace(hub(),projectId);
  await install(projectId,pkg,noop,noop);graph=new Map();mutations=[];
  port={nodes:async names=>names.flatMap(name=>graph.has(name)?[structuredClone(graph.get(name)!)]:[]),
   create:async entity=>{mutations.push('create');graph.set(entity.name,structuredClone(entity));},
   add:async(name,values)=>{mutations.push('add');graph.get(name)!.observations.push(...values);},
   remove:async(name,values)=>{mutations.push('remove');const entity=graph.get(name);if(entity)entity.observations=entity.observations.filter(value=>!values.includes(value));},close:noop};
 });
 afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
 const entity=(text='approved v1'):MemoryEntity=>({name:namespace+'stable-approved-key',entityType:'neurocenter.approved-project-knowledge.v1',observations:[text]});
 async function payload():Promise<MemorySyncPayload>{return {schemaVersion:1,projectId,bindingId:await projectBindingId(projectId),instanceId:await projectInstanceId(projectId),assetId:pkg.plugin.id,
  version:pkg.plugin.version,manifest:pkg.manifest.sha256,learningRevision:1,learningDigest:memoryDigest('fixture'),mode:'sync'};}
 async function sync(desired:MemoryEntity[],cleanup=false){
  const current=await payload(),storage=await projectionStorage(journalKey(hub(),current),namespace);
  const authorize=async()=>{expect(await projectBindingId(projectId)).toBe(current.bindingId);expect(await projectInstanceId(projectId)).toBe(current.instanceId);};
  return projectMemory(port,storage.journal,desired,memoryDigest([current,desired,cleanup]),cleanup,storage.save,authorize,noop);
 }
 async function switchToCopy(){
  const copy=path.join(path.dirname(fixture.root),'copy B');await fs.cp(fixture.root,copy,{recursive:true});
  await commitProjectBinding(await prepareProjectBinding({projectId,folderName:path.basename(copy),mode:'new-copy'}),context=>verifyWorkspaceInstallations(context,[pkg]));
  return copy;
 }
 const resume=()=>prepareProjectBinding({projectId,folderName:path.basename(fixture.root),mode:'resume'});
 async function killDuringBinding(phase:'prepared'|'committed'|'destination'|'retired',prepared:Awaited<ReturnType<typeof resume>>,original:MemorySyncPayload){
  const pending=path.join(stateDir(),'workspace-identity-pending.json'),oldFile=path.join(stateDir(),'local-configuration',journalKey(hub(),original)+'.json');
  const source=`
   import fs from 'node:fs/promises';
   import path from 'node:path';
   import {commitProjectBinding} from ${JSON.stringify(path.resolve('src/bridge/workspace.ts'))};
   import {verifyWorkspaceInstallations} from ${JSON.stringify(path.resolve('src/bridge/workspace-installations.ts'))};
   import {journalKey} from ${JSON.stringify(path.resolve('src/features/project-learning-memory-sync/receipts.ts'))};
   const pending=${JSON.stringify(pending)},phase=${JSON.stringify(phase)},rename=fs.rename.bind(fs);
   let count=0,target;
   fs.rename=async(from,to)=>{
    await rename(from,to);
    if(to===pending){
     count++;
     if(count===2){
      const handoff=JSON.parse(await fs.readFile(to,'utf8')).memoryOwnership[0];
      target=path.join(${JSON.stringify(stateDir())},'local-configuration',journalKey(handoff.site,handoff)+'.json');
     }
    }
    if(phase==='prepared'&&to===${JSON.stringify(path.join(stateDir(),'workspace-instances.json'))}
     ||phase==='committed'&&count===2&&to===pending
     ||phase==='destination'&&to===target
     ||phase==='retired'&&count===2&&to===${JSON.stringify(oldFile)})process.kill(process.pid,'SIGKILL');
   };
   await commitProjectBinding(${JSON.stringify(prepared)},context=>verifyWorkspaceInstallations(context,${JSON.stringify([pkg])}));
  `;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{env:process.env,stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',value=>{error+=String(value);});const [,signal]=await once(child,'exit');expect(signal,error).toBe('SIGKILL');
  return {pending,saved:JSON.parse(await fs.readFile(pending,'utf8'))};
 }

 it('sync → A → B → resume A retains ownership for noop, replacement and revoked cleanup without touching manual observations',async()=>{
  const original=await payload(),approved=entity();await sync([approved]);graph.get(approved.name)!.observations.push('manual observation');
  await switchToCopy();
  await expect(sync([approved])).rejects.toMatchObject({code:'conflict'});expect(mutations).toEqual(['create']);
  const returned=await commitProjectBinding(await resume(),context=>verifyWorkspaceInstallations(context,[pkg]));
  expect(returned.instanceId).toBe(original.instanceId);expect(returned.bindingId).not.toBe(original.bindingId);
  expect(await sync([approved])).toEqual({applied:0,removed:0,remaining:0});expect(mutations).toEqual(['create']);
  await sync([entity('approved v2')]);expect(graph.get(approved.name)!.observations).toEqual(['manual observation','approved v2']);
  await sync([],true);expect(graph.get(approved.name)!.observations).toEqual(['manual observation']);expect(mutations).toEqual(['create','add','remove','remove']);
 });
 it('same-instance physical rename transfers ownership while a stale source writer cannot recreate the old journal',async()=>{
  const original=await payload(),approved=entity();await sync([approved]);
  const stale=await projectionStorage(journalKey(hub(),original),namespace),renamed=path.join(path.dirname(fixture.root),'renamed A');
  await fs.rename(fixture.root,renamed);
  const moved=await commitProjectBinding(await prepareProjectBinding({projectId,folderName:path.basename(renamed),mode:'transfer',expectedBindingId:original.bindingId,expectedInstanceId:original.instanceId}),context=>verifyWorkspaceInstallations(context,[pkg]));
  expect(moved.instanceId).toBe(original.instanceId);expect(moved.bindingId).not.toBe(original.bindingId);
  expect(await sync([approved])).toEqual({applied:0,removed:0,remaining:0});expect(mutations).toEqual(['create']);
  await expect(stale.save(stale.journal)).rejects.toThrow();
  const deviceId='44444444-4444-4444-8444-444444444444';await writeState('credentials',{deviceId});
  await expect(memoryTarget(original,pkg,deviceId)).rejects.toThrow('привязка Memory изменились');
 });
 it('changed installed source is denied before adopting its private ownership',async()=>{
  await sync([entity()]);const copy=await switchToCopy(),selected=await projectBindingId(projectId),prepared=await resume();
  await fs.appendFile(path.join(fixture.root,assetBase(pkg),'entrypoint.mjs'),'\nmanual source change');
  await expect(commitProjectBinding(prepared,context=>verifyWorkspaceInstallations(context,[pkg]))).rejects.toThrow('Локальные файлы');
  expect(await projectFolder(projectId)).toBe(copy);expect(await projectBindingId(projectId)).toBe(selected);expect(mutations).toEqual(['create']);
 });
 it('a foreign namespace journal cannot be handed off even with unchanged installed files',async()=>{
  const original=await payload();await sync([entity()]);const key=journalKey(hub(),original),storage=await projectionStorage(key,namespace);
  await writePrivateConfiguration(key,{...storage.journal,namespace:memoryNamespace('https://foreign.invalid',projectId)},storage.journal);
  const copy=await switchToCopy();
  await expect(commitProjectBinding(await resume(),context=>verifyWorkspaceInstallations(context,[pkg]))).rejects.toThrow();
  expect(await projectFolder(projectId)).toBe(copy);expect(mutations).toEqual(['create']);
 });
 it('handoff retains an uncertain applied mutation and the old public checkpoint without resending it',async()=>{
  const original=await payload(),approved=entity(),create=port.create;
  port.create=async value=>{await create(value);throw new Error('MCP ACK lost');};
  await expect(sync([approved])).rejects.toThrow('MCP ACK lost');port.create=create;
  const pending={id:'22222222-2222-4222-8222-222222222222',lease:'33333333-3333-4333-8333-333333333333',deviceId:'44444444-4444-4444-8444-444444444444',payload:original,
   result:publicMemoryResult(original,memoryDigest('lost ACK'),{applied:0,removed:0,remaining:1},false,'unavailable')};
  await saveMemoryCheckpoint(pending);await switchToCopy();
  await commitProjectBinding(await resume(),context=>verifyWorkspaceInstallations(context,[pkg]));
  const delivered:unknown[]=[];await recoverMemoryCompletions(async value=>{delivered.push(value);});
  expect(delivered).toEqual([expect.objectContaining({id:pending.id,lease:pending.lease,state:'failed',result:pending.result})]);
  await sync([approved]);expect(mutations).toEqual(['create']);await sync([],true);expect(graph.get(approved.name)!.observations).toEqual([]);
 });
 it('changed ownership after installation verification fails CAS before publishing the new binding',async()=>{
  const original=await payload();await sync([entity()]);const source=await projectionStorage(journalKey(hub(),original),namespace),copy=await switchToCopy();
  await expect(commitProjectBinding(await resume(),async context=>{
   const lease=await verifyWorkspaceInstallations(context,[pkg]);source.journal.owned[entity().name]!.observations=['changed concurrent ownership'];
   await source.save(source.journal);return lease;
  })).rejects.toThrow('Memory');
  expect(await projectFolder(projectId)).toBe(copy);expect(mutations).toEqual(['create']);
 });
 it('an occupied destination journal fails CAS and is never merged into this instance ownership',async()=>{
  await sync([entity()]);const copy=await switchToCopy();
  await expect(commitProjectBinding(await resume(),async context=>{
   const lease=await verifyWorkspaceInstallations(context,[pkg]);
   const destination={...(await payload()),bindingId:context.bindingId!,instanceId:context.instanceId!};
   await writePrivateConfiguration(journalKey(hub(),destination),{schemaVersion:1,namespace:memoryNamespace('https://foreign.invalid',projectId),owned:{}},undefined);
   return lease;
  })).rejects.toThrow('Memory');
  expect(await projectFolder(projectId)).toBe(copy);expect(mutations).toEqual(['create']);
 });
 it('the real Memory executor holds the identity lock until its private projection completes',async()=>{
  const current=await payload(),context=createLearningContext({projectId,revision:1,entries:[]}),memory={...current,learningRevision:context.revision,learningDigest:context.digest};
  let entered!:()=>void,release!:()=>void;
  const connected=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const operation=runLearningMemoryJob({id:'22222222-2222-4222-8222-222222222222',lease:'33333333-3333-4333-8333-333333333333',payload:{memory,package:pkg}},'44444444-4444-4444-8444-444444444444',noop,{
   context:async()=>({schemaVersion:1,payload:memory,context,package:pkg}),
   target:vi.fn().mockResolvedValue({site:hub(),root:fixture.root,runtime:{entrypoint:'fixture-only.mjs'},assertCurrent:noop}),
   connect:async()=>{entered();await gate;return port;},
  });
  try{
   await connected;const prepared=await prepareProjectBinding({projectId,folderName:path.basename(fixture.root),mode:'resume'});
   await expect(commitProjectBinding(prepared,context=>verifyWorkspaceInstallations(context,[pkg]))).rejects.toThrow('Привязка уже изменяется');
   expect(await projectBindingId(projectId)).toBe(current.bindingId);
  }finally{release();}
  expect(await operation).toMatchObject({state:'succeeded'});expect(mutations).toEqual([]);
 });
 it.each(['prepared','committed','destination','retired'] as const)('SIGKILL at %s restores identity and its private ownership together',async phase=>{
  const approved=entity();await sync([approved]);const original=await payload(),copy=await switchToCopy(),prepared=await resume();
  const {pending}=await killDuringBinding(phase,prepared,original);
  const recovered=await recoverPendingWorkspaceIdentity();
  if(phase==='prepared'){
   expect(recovered).toBeUndefined();expect(await projectFolder(projectId)).toBe(copy);
   await commitProjectBinding(await resume(),context=>verifyWorkspaceInstallations(context,[pkg]));
  }else expect(recovered).toMatchObject({mode:'resume',instanceId:original.instanceId,previousBindingId:original.bindingId});
  expect(await sync([approved])).toEqual({applied:0,removed:0,remaining:0});expect(mutations).toEqual(['create']);
  await sync([],true);expect(graph.get(approved.name)!.observations).toEqual([]);await expect(fs.stat(pending)).rejects.toMatchObject({code:'ENOENT'});
 },15000);
 it.each(['prepared','committed','destination'] as const)('the first action after %s SIGKILL is a real executor: recover first, then authorize the current binding',async phase=>{
  const approved=entity();await sync([approved]);graph.get(approved.name)!.observations.push('manual observation');
  const original=await payload(),copy=await switchToCopy(),{pending,saved}=await killDuringBinding(phase,await resume(),original);
  const context=createLearningContext({projectId,revision:2,entries:[]}),memory={...original,bindingId:saved.result.bindingId,learningRevision:context.revision,learningDigest:context.digest,mode:'cleanup' as const};
  const deviceId='44444444-4444-4444-8444-444444444444';await writeState('credentials',{deviceId});
  vi.spyOn(runtimeCache,'resolvePreparedRuntimeArtifact').mockResolvedValue({target:'fixture',sha256:'f'.repeat(64),root:fixture.root,entrypoint:'fixture-only.mjs',executable:false});
  const target=vi.fn(memoryTarget),connect=vi.fn(async()=>port),job={id:'22222222-2222-4222-8222-222222222222',lease:'33333333-3333-4333-8333-333333333333',payload:{memory,package:pkg}};
  const result=await runLearningMemoryJob(job,deviceId,noop,{context:async()=>({schemaVersion:1,payload:memory,context,package:pkg}),target,connect});
  if(phase==='prepared'){
   expect(result.state).toBe('failed');expect(connect).not.toHaveBeenCalled();expect(await projectFolder(projectId)).toBe(copy);
   expect(graph.get(approved.name)!.observations).toEqual(['approved v1','manual observation']);
  }else{
   await expect(target.mock.results[0]!.value).resolves.toBeDefined();
   expect(result.state).toBe('succeeded');expect(connect).toHaveBeenCalledOnce();expect(await projectBindingId(projectId)).toBe(memory.bindingId);
   expect(graph.get(approved.name)!.observations).toEqual(['manual observation']);
  }
  await expect(memoryTarget(original,pkg,deviceId)).rejects.toThrow('привязка Memory изменились');
  await expect(fs.stat(pending)).rejects.toMatchObject({code:'ENOENT'});
 },15000);
});
