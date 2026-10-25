import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {stateDir,writeState} from '../src/bridge/state.js';
import {startRoleMcpPoller} from '../src/features/system-role-mcp/poller.js';
import {connectRoleMcp} from '../src/features/system-role-mcp/client.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
describe('owner durability survives cancellation during filesystem commit',()=>{
 let server:http.Server|undefined,temporary:string|undefined,poller:ReturnType<typeof startRoleMcpPoller>|undefined;
 afterEach(async()=>{await poller?.stop();server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));vi.restoreAllMocks();vi.unstubAllEnvs();if(temporary)await fs.rm(temporary,{recursive:true,force:true});});
 it.each(['commit','reject']as const)('does not acknowledge or resurrect an owned session while its pre-permit owner rename is still pending (%s)',async outcome=>{
  ({temporary}=await workspaceFixture());const deviceId=randomUUID(),id=randomUUID(),lease=randomUUID(),entered=deferred(),release=deferred(),retained=deferred(),runFinished=deferred();
  let allocated=false,held=false,completions=0,stopFinished=false,home='';
  server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);let value:unknown={};
   if(req.url!.endsWith('/claim')){value=allocated?null:{id,lease,requestId:body.requestId,project_id:'project',payload:{sessionId:id}};allocated=true;}
   if(req.url!.endsWith('/complete')){completions++;value={ok:true,closed:true};}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address()as {port:number}).port;
  vi.stubEnv('NEUROCENTER_URL',origin);vi.stubEnv('NEUROCENTER_API_URL',origin);await writeState('credentials',{deviceId,token:'owned-fixture',email:'fixture@example.test'});
  const rename=fs.rename.bind(fs);vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
   if(!held&&String(to).includes('system-role-mcp-sessions')){const pending=JSON.parse(await fs.readFile(from,'utf8'));if(pending.stdio){held=true;entered.resolve();await release.promise;if(outcome==='reject')throw Object.assign(new Error('controlled owner rename failure'),{code:'EIO'});}}
   return rename(from,to);
  });
  const fixture=fileURLToPath(new URL('./system-role-mcp.fixture.mjs',import.meta.url));
  poller=startRoleMcpPoller({recover:async()=>{},run:async(job,_device,_authorize,deps,signal)=>{
   const own=await deps.ownership!.home();home=own.path;let port;
   try{port=await connectRoleMcp({pkg:{config:{transport:'stdio'}}as never,command:process.execPath,args:[fixture],cwd:home,env:{PATH:process.env.PATH,HOME:home},
    ownership:{...deps.ownership!.process,async retain(owner){try{await deps.ownership!.process.retain(owner);}finally{retained.resolve();}}}},signal!,async()=>{});
   }catch{/* Cancellation before permit is the behavior under test. */}
   finally{try{await port?.close();}finally{await own.close();runFinished.resolve();}}
   return {state:'failed',message:'Cancelled before tool launch',result:{schemaVersion:1,sessionId:job.id,closed:true}};
  }});
  await entered.promise;const stopping=poller.stop().then(()=>{stopFinished=true;});
  try{await runFinished.promise;await delay(100);expect(completions).toBe(0);expect(stopFinished).toBe(false);await expect(fs.lstat(path.join(home,'tool.pid'))).rejects.toMatchObject({code:'ENOENT'});}
  finally{release.resolve();await retained.promise;await stopping;}
  expect(completions).toBe(outcome==='commit'?1:0);const files=await fs.readdir(path.join(stateDir(),'system-role-mcp-sessions'));if(outcome==='commit')expect(files).toEqual([]);else{expect(files).toHaveLength(1);expect(JSON.parse(await fs.readFile(path.join(stateDir(),'system-role-mcp-sessions',files[0]!),'utf8')).phase).toBe('claimed');}
 });
});
