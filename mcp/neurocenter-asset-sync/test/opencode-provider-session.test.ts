import fs from 'node:fs/promises';
import path from 'node:path';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,providerSession,noop} from './opencode-provider.fixture.js';
import {prepareOpenCodeProvider,openOpenCodeProvider,getOpenCodeProviderStatus} from '../src/features/opencode-providers/index.js';
import {closeProviderSessions} from '../src/features/opencode-providers/server.js';
import {providerConfig} from '../src/features/opencode-providers/receipt.js';
import {readPrivateConfiguration,writePrivateConfiguration} from '../src/features/local-configuration/private-store.js';
import {hash,writeState} from '../src/bridge/state.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{await closeProviderSessions();await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(){const f=await providerFixture();cleanup.push(f.cleanup);return f;}
describe('Private loopback provider wizard',()=>{
 it('prefills catalog metadata and returns only safe public reports; actual save needs no provider call',async()=>{
  const f=await fixture(),s=await providerSession(f);expect(s.url.hostname).toBe('127.0.0.1');expect(s.url.search).toBe('');expect(s.url.hash).toHaveLength(44);
  for(const report of [s.report,s.preparation]){expect(JSON.stringify(report)).not.toContain('provider.example');expect(JSON.stringify(report)).not.toContain(s.url.hash.slice(1));expect(report).not.toHaveProperty('expectations');}
  const page=await fetch(s.url.origin);expect(page.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");expect(page.headers.get('Access-Control-Allow-Origin')).toBeNull();expect(await page.text()).not.toContain('DEVICE_TOKEN');
  const form=await (await s.bootstrap()).json() as {csrf:string;revision:null;baseUrl:string;runtimeModel:string};expect(form).toMatchObject({baseUrl:f.descriptor.expectations!.baseUrl,runtimeModel:'model-local',revision:null});
  const response=await s.post('/save',{apiKey:'ONLY_LOCAL_SECRET',expectedRevision:null},form.csrf);expect(response.status).toBe(200);expect(await response.json()).toEqual({ready:true,state:'configured'});
  expect((await getOpenCodeProviderStatus(f.descriptor,noop)).ready).toBe(true);expect(await fs.readFile(path.join(f.root,providerConfig),'utf8')).not.toContain('ONLY_LOCAL_SECRET');
 });
 it('rejects foreign Origin, hostname and csrf with no project mutation',async()=>{
  const f=await fixture(),s=await providerSession(f);expect((await s.post('/session',{token:s.url.hash.slice(1)},'','https://foreign.test')).status).toBe(403);
  const host=await new Promise<number|undefined>((resolve,reject)=>{const req=request(s.url.origin+'/session',{method:'POST',headers:{Host:'localhost:'+s.url.port,Origin:s.url.origin,'Content-Type':'application/json'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end(JSON.stringify({token:s.url.hash.slice(1)}));});expect(host).toBe(403);
  await s.bootstrap();expect((await s.post('/save',{apiKey:'NEVER_WRITE',expectedRevision:null},'wrong')).status).toBe(403);await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('reserves bootstrap before awaiting identity and permits only one competing tab',async()=>{
  const s=await providerSession(await fixture());const responses=await Promise.all([s.bootstrap(),s.bootstrap()]);expect(responses.map(r=>r.status).sort()).toEqual([200,403]);
 });
 it('reserves the one save attempt and uses fresh admission after opening',async()=>{
  const f=await fixture();let allowed=true;const admit=vi.fn(async()=>{if(!allowed)throw Error('REVOKED_PRIVATE_DETAIL');}),s=await providerSession(f,admit),form=await(await s.bootstrap()).json() as {csrf:string};allowed=false;admit.mockClear();
  const response=await s.post('/save',{apiKey:'NEVER_WRITE',expectedRevision:null},form.csrf);expect(response.status).toBe(400);expect(await response.text()).not.toContain('REVOKED_PRIVATE_DETAIL');expect(admit).toHaveBeenCalledOnce();
  expect((await s.post('/save',{apiKey:'NEVER_WRITE',expectedRevision:null},form.csrf)).status).toBe(403);await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('closure during held admission prevents a late mutation',async()=>{
  const f=await fixture();let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  let hold=false;const s=await providerSession(f,async()=>{if(hold){entered();await held;}}),form=await(await s.bootstrap()).json() as {csrf:string};hold=true;
  const pending=s.post('/save',{apiKey:'NEVER_WRITE',expectedRevision:null},form.csrf).catch(()=>null);await started;await closeProviderSessions();release();await pending;
  await new Promise(r=>setImmediate(r));await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('a disconnected save request cannot mutate after a held permit resolves',async()=>{
  const f=await fixture();let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  let hold=false;const s=await providerSession(f,async()=>{if(hold){entered();await held;}}),form=await(await s.bootstrap()).json() as {csrf:string},abort=new AbortController();hold=true;
  const pending=fetch(s.url.origin+'/save',{method:'POST',headers:{Origin:s.url.origin,'Content-Type':'application/json','X-Provider-CSRF':form.csrf},body:JSON.stringify({apiKey:'NEVER_WRITE',expectedRevision:null}),signal:abort.signal}).catch(()=>null);
  await started;abort.abort();await pending;await new Promise(r=>setTimeout(r,20));release();await new Promise(r=>setTimeout(r,20));await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('changed device identity invalidates a prepared session before bootstrap',async()=>{
  const f=await fixture(),s=await providerSession(f);await writeState('credentials',{deviceId:randomUUID(),token:'OTHER_PRIVATE'});expect((await s.bootstrap()).status).toBe(400);
 });
 it.each(['expired','different-schema','different-job'])('rejects %s preparation without opening a browser',async scenario=>{
  const f=await fixture(),prepared=await prepareOpenCodeProvider(f.descriptor,noop),open=vi.fn(async()=>true),key=hash('opencode-provider-preparation:'+prepared.preparationId);
  const initial=await readPrivateConfiguration<Record<string,unknown>>(key);let expiresAt=prepared.expiresAt;
  if(scenario==='expired'){expiresAt=new Date(Date.now()-1).toISOString();await writePrivateConfiguration(key,{...initial,expiresAt},initial);}
  if(scenario==='different-job')await writePrivateConfiguration(key,{...initial,openJobId:randomUUID()},initial);
  const descriptor=scenario==='different-schema'?{...f.descriptor,schemaDigest:'d'.repeat(64)}:f.descriptor;
  await expect(openOpenCodeProvider(descriptor,{...prepared,expiresAt,openJobId:randomUUID(),authorizeSave:noop,open},noop)).rejects.toThrow();expect(open).not.toHaveBeenCalled();
 });
 it('failed browser opening closes its bound listener and does not return a usable session',async()=>{
  const f=await fixture(),prepared=await prepareOpenCodeProvider(f.descriptor,noop);let url='';
  await expect(openOpenCodeProvider(f.descriptor,{...prepared,openJobId:randomUUID(),authorizeSave:noop,open:async address=>{url=address;return false;}},noop)).rejects.toThrow('открыть');await expect(fetch(new URL(url).origin)).rejects.toThrow();
 });
 it('a local manual collision returns an explicit safe conflict and leaves the original bytes unchanged',async()=>{
  const f=await fixture(),s=await providerSession(f),form=await(await s.bootstrap()).json() as {csrf:string},file=path.join(f.root,providerConfig),raw=JSON.stringify({provider:{[f.descriptor.providerId]:{models:{manual:{}}}}});await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,raw);
  const response=await s.post('/save',{apiKey:'NEVER_WRITE',expectedRevision:null},form.csrf);expect(response.status).toBe(409);expect(await response.text()).not.toContain(f.root);expect(await fs.readFile(file,'utf8')).toBe(raw);
 });
 it.each(['extra-field','array','oversized'])('rejects malformed form body %s before save admission',async scenario=>{
  const f=await fixture(),authorize=vi.fn(noop),s=await providerSession(f,authorize),form=await(await s.bootstrap()).json() as {csrf:string};
  authorize.mockClear();const input=scenario==='array'?[]:scenario==='oversized'?{apiKey:'x'.repeat(17000),expectedRevision:null}:{apiKey:'NEVER_WRITE',expectedRevision:null,baseUrl:'https://other.test'};
  expect((await s.post('/save',input,form.csrf)).status).toBeGreaterThanOrEqual(400);expect(authorize).not.toHaveBeenCalled();
 });
});
