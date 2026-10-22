import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {saveProvider} from '../src/features/opencode-providers/engine.js';
import {providerConfig} from '../src/features/opencode-providers/receipt.js';
import {createOpenCodeModelSynchronizer} from '../src/bridge/opencode-model-sync.js';
import {readOpenCodeModelMetadata} from '../src/bridge/opencode-model-scan.js';
import {readState,hash} from '../src/bridge/state.js';
import {projectFolder,projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();});
async function fixture(){const f=await providerFixture();cleanup.push(f.cleanup);return f;}
async function synchronize(f:Awaited<ReturnType<typeof providerFixture>>){
 const bodies:Array<Record<string,unknown>>=[],server=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
  expect(req.headers.authorization).toBe('Bearer TEST_DEVICE_ONLY');let value:unknown;
  if(req.url==='/api/device-channel/opencode-models/context')value={schemaVersion:2,global:{deviceId:f.descriptor.deviceId},revision:1,enabled:true,transferCredentials:true,bindings:[{projectId:f.descriptor.projectId,bindingId:f.descriptor.bindingId,instanceId:f.descriptor.instanceId}]};
  else{expect(req.url).toBe('/api/device-channel/opencode-models/sync');bodies.push(body);value={ok:true};}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{const api=async<T>(route:string,input?:unknown)=>{const res=await fetch(origin+'/api/device-channel/'+route,{method:'POST',headers:{Authorization:'Bearer TEST_DEVICE_ONLY','Content-Type':'application/json'},body:JSON.stringify(input??{})});return await res.json() as T;};
  await createOpenCodeModelSynchronizer({api,hub:()=>origin,readState,projectFolder,projectBindingId,projectInstanceId,readOpenCodeModelMetadata})();return bodies;
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));expect(server.listening).toBe(false);}
}
describe('Local-only provider credentials across automatic model synchronization',()=>{
 it('never exports a wizard-created raw key or its hash, even when manual credential transfer is enabled',async()=>{
  const f=await fixture(),key='WIZARD_KEY_MUST_NEVER_LEAVE';await saveProvider(f.context,key,null,noop);
  await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify({provider:{manual:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://manual.example.test/v1',apiKey:'MANUAL_TRANSFER_ALLOWED'},models:{manual:{}}}}}));
  const bodies=await synchronize(f),project=bodies.find(body=>(body.scan as {scope?:string}).scope==='project')!;
  const scan=project.scan as {candidates:Array<{candidateId:string;provider:string;hasKey:boolean}>},managed=scan.candidates.find(c=>c.provider===f.descriptor.providerId)!,manual=scan.candidates.find(c=>c.provider==='manual')!;
  expect(managed.hasKey).toBe(true);expect((project.credentials as Record<string,string>)[managed.candidateId]).toBeUndefined();expect((project.credentials as Record<string,string>)[manual.candidateId]).toBe('MANUAL_TRANSFER_ALLOWED');
  expect(JSON.stringify(bodies)).not.toContain(key);expect(JSON.stringify(bodies)).not.toContain(hash(key));
 });
 it('never exports a managed Codex auth reference while still synchronizing safe metadata',async()=>{
  const f=await fixture(),id='neurocenter-codex-'+'d'.repeat(16),marker='codexbridge-managed';await fs.mkdir(path.dirname(path.join(f.root,providerConfig)),{recursive:true});
  await fs.writeFile(path.join(f.root,providerConfig),JSON.stringify({provider:{[id]:{npm:'@ai-sdk/openai',options:{baseURL:'https://chatgpt.com/backend-api/codex'},models:{'qa-codex':{}}}}}));
  const auth=path.join(f.home,'.local/share/opencode/auth.json');await fs.mkdir(path.dirname(auth),{recursive:true});await fs.writeFile(auth,JSON.stringify({[id]:{type:'api',key:marker}}),{mode:0o600});
  const bodies=await synchronize(f),project=bodies.find(body=>(body.scan as {scope?:string}).scope==='project')!;expect((project.scan as {candidates:unknown[]}).candidates).toHaveLength(1);expect(project.credentials).toEqual({});expect(JSON.stringify(bodies)).not.toContain(marker);expect(JSON.stringify(bodies)).not.toContain(hash(marker));
 });
});
