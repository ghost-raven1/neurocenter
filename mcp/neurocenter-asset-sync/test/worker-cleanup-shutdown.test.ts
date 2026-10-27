import fs from 'node:fs/promises';
import {existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import cleanup from '../../../services/shared/bridge-update-cleanup.cjs';
import * as state from '../src/bridge/state.js';
import {runWorker} from '../src/bridge/worker.js';
import {cleanupInstalledBridge} from '../src/features/runtime-artifacts/update-cleanup.js';
import {workspaceFixture} from './bridge-fixture.js';
import {stopFixtureWorker} from './worker-lifecycle.fixture.js';

const socket=vi.hoisted(()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}));
vi.mock('socket.io-client',()=>({io:vi.fn(()=>socket)}));
vi.mock('../src/bridge/state.js',async original=>({...await original<typeof import('../src/bridge/state.js')>(),api:vi.fn()}));
vi.mock('../src/features/system-role-mcp/poller.js',()=>({startRoleMcpPoller:()=>({wake(){},stop:async()=>{}})}));
vi.mock('../src/features/runtime-artifacts/update-cleanup.js',async original=>({...await original<typeof import('../src/features/runtime-artifacts/update-cleanup.js')>(),cleanupInstalledBridge:vi.fn()}));
vi.mock('../src/bridge/opencode-model-sync.js',()=>({synchronizeOpenCodeModels:async()=>{}}));

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
let local:Awaited<ReturnType<typeof workspaceFixture>>,previous:Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>;
let worker:Promise<void>|undefined,releases:Array<()=>void>;
beforeEach(async()=>{
 releases=[];worker=undefined;vi.clearAllMocks();
 previous=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
 local=await workspaceFixture();await state.writeState('credentials',{token:'own-worker-fixture',deviceId:'22222222-2222-4222-8222-222222222222',email:'fixture@example.test'});
 socket.disconnect.mockReturnValue(socket);socket.connect.mockReturnValue(socket);
 vi.spyOn(process,'exit').mockImplementation((()=>undefined) as never);vi.spyOn(process.stderr,'write').mockReturnValue(true);
 vi.mocked(state.api).mockImplementation(async route=>(route==='jobs/claim'?null:{}) as never);
});
afterEach(async()=>{
 for(const release of releases)release();
 try{await worker;await stopFixtureWorker(previous);await Promise.allSettled(vi.mocked(cleanupInstalledBridge).mock.results.map(value=>value.value));}
 finally{
  for(const[signal,listeners]of previous)for(const listener of process.listeners(signal))if(!listeners.has(listener))process.off(signal,listener);
  vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(local.temporary,{recursive:true,force:true});
 }
});
const gate=()=>{const value=deferred();releases.push(value.resolve);return value;};
function terminate(){const listener=process.listeners('SIGTERM').find(value=>!previous.get('SIGTERM')?.has(value));expect(listener).toBeTypeOf('function');listener!();}

/** Actual shared cleanup owns its real global lock while the worker receives its production signal handler. */
async function cleanupRuntime(largeRead=false){
 const installRoot=path.join(local.temporary,'managed-bridge');
 async function runtime(destination:string){
  const stage=await fs.mkdtemp(path.join(local.temporary,'.stage-'));await fs.mkdir(path.join(stage,'dist'));
  await fs.writeFile(path.join(stage,cleanup.OWNER_FILE),JSON.stringify({schemaVersion:1,installRoot}));
  await fs.writeFile(path.join(stage,cleanup.CAPABILITY_FILE),JSON.stringify({schemaVersion:1,entrypoints:cleanup.RUNTIME_USE_ENTRYPOINTS}));
  await fs.writeFile(path.join(stage,'dist/index.js'),largeRead?Buffer.alloc(2*1024**2,7):'owned runtime');
  await cleanup.writeInstalledRuntimeReceipt({installRoot,runtimeRoot:stage});await fs.rename(stage,destination);
 }
 await runtime(installRoot);
 for(const[index,name]of['Abc123','Def456','Ghi789'].entries()){
  const backupRoot=path.join(local.temporary,'.neurocenter-previous.'+name);await runtime(backupRoot);
  await cleanup.writeSuccessfulBackupReceipt({installRoot,backupRoot,completedAt:Date.now()-(20-index)*86400000});
 }
 return{installRoot,lock:path.join(await cleanup.controlRootForInstallRoot(installRoot),'lock.json'),backup:path.join(local.temporary,'.neurocenter-previous.Abc123')};
}

it('SIGTERM retains the worker until actual cleanup releases its global lock',async()=>{
 const runtime=await cleanupRuntime(),entered=gate(),release=gate();
 vi.mocked(cleanupInstalledBridge).mockImplementation(async()=>cleanup.cleanupSuccessfulBackups({installRoot:runtime.installRoot,
  beforeDelete:async()=>{entered.resolve();await release.promise;}}));
 worker=runWorker();await entered.promise;
 expect(JSON.parse(await fs.readFile(runtime.lock,'utf8')).pid).toBe(process.pid);
 terminate();
 // Give the asynchronous exit path a chance to run while the controlled cleanup gate remains closed.
 await new Promise(resolve=>setTimeout(resolve,100));
 expect(process.exit).not.toHaveBeenCalled();await expect(fs.access(runtime.lock)).resolves.toBeUndefined();
 await expect(fs.access(path.join(state.stateDir(),'worker.lock'))).resolves.toBeUndefined();
 release.resolve();await worker;await vi.waitFor(()=>expect(process.exit).toHaveBeenCalledWith(0));
 await expect(fs.access(runtime.lock)).rejects.toHaveProperty('code','ENOENT');
 await expect(fs.access(path.join(state.stateDir(),'worker.lock'))).rejects.toHaveProperty('code','ENOENT');
});

it('SIGTERM aborts an actual readonly snapshot stream and closes its FD and gates before worker exit',async()=>{
 const runtime=await cleanupRuntime(true),target=path.join(runtime.backup,'dist/index.js'),control=await cleanup.controlRootForInstallRoot(runtime.installRoot);
 const open=fs.open.bind(fs),beforeDelete=vi.fn(async()=>{throw Error('Readonly cancellation must precede deletion.');});
 let captured:Awaited<ReturnType<typeof fs.open>>|undefined,failure:unknown,entered=false;
 let atExit:{fd:number|undefined;global:boolean;installer:boolean;gates:string[]}|undefined;
 vi.mocked(process.exit).mockImplementation((()=>{atExit={fd:captured?.fd,global:existsSync(runtime.lock),installer:existsSync(runtime.installRoot+'.install-lock'),gates:readdirSync(path.join(control,'locks'))};}) as never);
 vi.spyOn(fs,'open').mockImplementation(async(...args)=>{
  const handle=await open(...args);
  if(args[0]===target&&!captured){captured=handle;const read=handle.createReadStream.bind(handle);
   vi.spyOn(handle,'createReadStream').mockImplementation(options=>{const stream=read({...options,highWaterMark:1024});stream.once('data',()=>{entered=true;terminate();});return stream;});
  }
  return handle;
 });
 vi.mocked(cleanupInstalledBridge).mockImplementation(async(_policy,options)=>{
  try{return await cleanup.cleanupSuccessfulBackups({installRoot:runtime.installRoot,signal:options?.signal,beforeDelete});}
  catch(error){failure=error;throw error;}
 });
 worker=runWorker();await vi.waitFor(()=>expect(entered).toBe(true),{timeout:1000});await worker;await vi.waitFor(()=>expect(process.exit).toHaveBeenCalledWith(0));
 expect(failure).toMatchObject({name:'AbortError'});expect(beforeDelete).not.toHaveBeenCalled();expect(atExit).toEqual({fd:-1,global:false,installer:false,gates:[]});
 await expect(captured!.stat()).rejects.toHaveProperty('code','EBADF');expect((await fs.readFile(target)).equals(Buffer.alloc(2*1024**2,7))).toBe(true);
 await expect(fs.access(runtime.lock)).rejects.toHaveProperty('code','ENOENT');await expect(fs.access(runtime.installRoot+'.install-lock')).rejects.toHaveProperty('code','ENOENT');
 expect(await fs.readdir(path.join(await cleanup.controlRootForInstallRoot(runtime.installRoot),'locks'))).toEqual([]);
 expect(process.stderr.write).not.toHaveBeenCalled();
});

it('SIGTERM waits for an admitted heartbeat and prevents cleanup from starting after its response',async()=>{
 const entered=gate(),release=gate();
 vi.mocked(state.api).mockImplementation(async route=>{if(route==='heartbeat'){entered.resolve();await release.promise;}return(route==='jobs/claim'?null:{}) as never;});
 vi.mocked(cleanupInstalledBridge).mockResolvedValue(undefined);
 worker=runWorker();await entered.promise;terminate();
 await new Promise(resolve=>setTimeout(resolve,100));expect(process.exit).not.toHaveBeenCalled();
 release.resolve();await worker;await vi.waitFor(()=>expect(process.exit).toHaveBeenCalledWith(0));
 expect(cleanupInstalledBridge).not.toHaveBeenCalled();
});
