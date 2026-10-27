import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
import {writeState} from '../src/bridge/state.js';
import {cleanupInstalledBridge,updateCleanup} from '../src/features/runtime-artifacts/update-cleanup.js';
import {workspaceFixture} from './bridge-fixture.js';

let local:Awaited<ReturnType<typeof workspaceFixture>>|undefined,server:http.Server|undefined;
afterEach(async()=>{
 vi.restoreAllMocks();syncBuiltinESMExports();
 if(server){server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));}
 vi.unstubAllEnvs();if(local)await fs.rm(local.temporary,{recursive:true,force:true});local=undefined;server=undefined;
});

/** Only install readiness and the GC delegate are controlled; authority cancellation crosses real HTTP. */
it('installed maintenance forwards cancellation through GC and a pending authority request',async()=>{
 local=await workspaceFixture();await writeState('credentials',{deviceId:'22222222-2222-4222-8222-222222222222',token:'own-cleanup-fixture',email:'fixture@example.test'});
 let arrived=false;
 server=http.createServer((request)=>{request.resume();arrived=true;});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('Own cleanup fixture did not listen.');
 vi.stubEnv('NEUROCENTER_API_URL','http://127.0.0.1:'+address.port);
 const marker=path.join(local.temporary,'own-install-marker');await fs.writeFile(marker,'owned readiness fixture');
 vi.spyOn(fs,'lstat').mockResolvedValueOnce(await fs.lstat(marker,{bigint:true}));
 syncBuiltinESMExports();
 let passedSignal:AbortSignal|undefined;
 vi.spyOn(updateCleanup,'cleanupSuccessfulBackups').mockImplementation(async input=>{passedSignal=input.signal;await input.beforeDelete!();return{removed:[],kept:[],warnings:[]};});
 const controller=new AbortController();let failure:unknown;
 void cleanupInstalledBridge(updateCleanup.normalizeCleanupPolicy(),{signal:controller.signal}).catch(error=>{failure=error;});
 await vi.waitFor(()=>expect(arrived).toBe(true),{timeout:1000});controller.abort();await vi.waitFor(()=>expect(failure).toBe(controller.signal.reason),{timeout:1000});
 expect(passedSignal).toBe(controller.signal);
});
