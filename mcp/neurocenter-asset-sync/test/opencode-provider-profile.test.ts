import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerProfileFixture} from './opencode-provider-profile.fixture.js';
import {profileCleanup,profileSite} from './bridge-cli-profile.fixture.js';
const fixtures:Array<Awaited<ReturnType<typeof providerProfileFixture>>>=[];
afterEach(async()=>{for(const f of fixtures.splice(0))await f.close();expect(profileCleanup.every(f=>f.removed&&!f.remaining.length)).toBe(true);});
async function fixture(kind:'http'|'https'|'proxy'='http'){const f=await providerProfileFixture(kind);fixtures.push(f);return f;}
const input=()=>({providerId:'neurocenter-codex-'+'a'.repeat(16),projectRoot:'/owned/project',preparationId:randomUUID(),setupJobId:randomUUID(),schemaDigest:'b'.repeat(64),phase:'request'});
describe('Managed provider permit from a clean OpenCode parent environment',()=>{
 it.each(['http','https','proxy'] as const)('loads saved HOME/site/API/CA/proxy before actual %s child request',async kind=>{
  const f=await fixture(kind),before=await fs.readFile(f.config,'utf8'),credentials=await fs.readFile(f.credentials,'utf8');
  const result=await f.run([JSON.stringify(input())],process.env.OPENCODE_PROVIDER_PROFILE_BASELINE==='1'?{QA_PROVIDER_ORIGINAL:'1'}:{});
  expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual({ok:true,allowed:true});expect(f.requests.map(r=>r.route)).toEqual(['/api/device-channel/identity']);
  expect(JSON.parse((await fs.readFile(f.capture,'utf8')).trim())).toMatchObject({home:f.runtimeHome,site:profileSite,api:f.api,ca:kind==='https',proxy:kind==='proxy'});
  expect(await fs.readFile(f.config,'utf8')).toBe(before);expect(await fs.readFile(f.credentials,'utf8')).toBe(credentials);await expect(fs.stat(f.callerCredentials)).rejects.toMatchObject({code:'ENOENT'});expect(await f.workers()).toEqual([]);
  if(kind==='proxy'){expect(f.proxyTunnels).toEqual([new URL(f.api).host]);expect(f.directRequests).toEqual([]);}
 });
 it.each(['command','duplicate','invalid-site'])('refuses a %s collision without executing the provider boundary',async kind=>{
  const f=await fixture();if(kind==='command')f.own.command[1]+='.foreign';if(kind==='invalid-site')f.savedEnvironment.NEUROCENTER_URL='https://user:secret@foreign.test';
  const raw=JSON.stringify(f.configuration);await fs.writeFile(f.config,kind==='duplicate'?raw.replace('"enabled":false','"enabled":false,"enabled":true'):raw);
  const result=await f.run([JSON.stringify(input())]);expect(result.code).toBe(1);expect(f.requests).toEqual([]);await expect(fs.stat(f.capture)).rejects.toMatchObject({code:'ENOENT'});expect(result.stdout+result.stderr).not.toContain('user:secret');
 });
 it('SIGTERM cancels and reaps the nested owned authorization child',async()=>{
  const f=await fixture(),pending=f.run([JSON.stringify(input())],{QA_PROVIDER_HOLD:'1'});
  await vi.waitFor(async()=>expect(await fs.readFile(f.capture,'utf8')).toContain('"pid"'));
  const pids=(await fs.readFile(f.root+'/pids.jsonl','utf8')).trim().split('\n').map(line=>(JSON.parse(line) as {pid:number}).pid);expect(pids).toHaveLength(2);process.kill(pids[0]!,'SIGTERM');const result=await pending;expect(result.code).toBe(1);expect(f.requests).toEqual([]);
  for(const pid of pids)await vi.waitFor(()=>{expect(()=>process.kill(pid,0)).toThrow();});
 });
});
