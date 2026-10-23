import fs from 'node:fs/promises';
import path from 'node:path';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {configurationFixture,configurationSession} from './project-configuration.fixture.js';
import {closeConfigurationSessions} from '../src/features/project-configuration/server.js';
import {openProjectConfiguration} from '../src/features/project-configuration/index.js';
import {writeState} from '../src/bridge/state.js';
const cleanup:Array<()=>Promise<void>>=[];
async function fixture(){const f=await configurationFixture();cleanup.push(f.cleanup);return f;}
afterEach(async()=>{await closeConfigurationSessions();await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('Private project configuration browser session',()=>{
 it('serves a CSP-locked static page, one-use capability and local-only previews; completion reports only opened',async()=>{
    const f=await fixture(),s=await configurationSession(f),page=await fetch(s.url.origin),html=await page.text();expect(page.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");expect(page.headers.get('Access-Control-Allow-Origin')).toBeNull();expect(html).not.toContain('DEVICE_TOKEN');expect(html).not.toContain(s.url.hash.slice(1));expect(JSON.stringify(s.report)).not.toMatch(/http|127\.0\.0|\.md|DEVICE_TOKEN/);
    const form=await(await s.bootstrap()).json() as {csrf:string;settingsUrl:string};expect(form.settingsUrl).toBe(f.context.site+'/projects/'+f.descriptor.projectId+'?tab=store&catalogTab=models');expect((await s.bootstrap()).status).toBe(403);expect((await s.post('/inventory',{},form.csrf)).status).toBe(200);const opened=await(await s.post('/read',{path:'AGENTS.md'},form.csrf)).json() as {revision:string};
    const text='</script><img src=x onerror="globalThis.stolen=true"> LOCAL_ONLY_SECRET',preview=await(await s.post('/preview',{path:'AGENTS.md',revision:opened.revision,text},form.csrf)).json() as {after:string;previewId:string;digest:string};expect(preview.after).toBe(text);expect((await s.post('/save',{previewId:preview.previewId,digest:preview.digest},form.csrf)).status).toBe(200);expect(await fs.readFile(path.join(f.root,'AGENTS.md'),'utf8')).toBe(text);expect(JSON.stringify(s.report)).not.toContain('SECRET');
 });
 it('rejects foreign origin, hostname and CSRF before reading project text',async()=>{
    const f=await fixture(),s=await configurationSession(f);expect((await s.post('/session',{token:s.url.hash.slice(1)},'','https://foreign.test')).status).toBe(403);
    const status=await new Promise(resolve=>{const req=request(s.url.origin,{method:'GET',headers:{Host:'localhost:'+s.url.port}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.end();});expect(status).toBe(403);
    const form=await(await s.bootstrap()).json() as {csrf:string};expect((await s.post('/read',{path:'AGENTS.md'},'wrong')).status).toBe(403);expect((await s.post('/read',{path:'AGENTS.md'},form.csrf,'https://foreign.test')).status).toBe(403);
 });
 it('a revoked standalone permit blocks reads and save after ACK; close stays available',async()=>{
    const f=await fixture();let allowed=true;const permit=vi.fn(async()=>{if(!allowed)throw Error('REVOKED_PRIVATE_TOKEN');}),s=await configurationSession(f,permit),form=await(await s.bootstrap()).json() as {csrf:string};await s.post('/inventory',{},form.csrf);const opened=await(await s.post('/read',{path:'AGENTS.md'},form.csrf)).json() as {revision:string};const preview=await(await s.post('/preview',{path:'AGENTS.md',revision:opened.revision,text:'Draft'},form.csrf)).json() as {previewId:string;digest:string};allowed=false;
    const response=await s.post('/save',{previewId:preview.previewId,digest:preview.digest},form.csrf);expect(response.status).toBe(400);expect(await response.text()).not.toContain('REVOKED_PRIVATE_TOKEN');expect((await s.post('/read',{path:'AGENTS.md'},form.csrf)).status).toBe(400);expect((await s.post('/close',{},form.csrf)).status).toBe(200);await expect(fs.stat(path.join(f.root,'AGENTS.md'))).rejects.toHaveProperty('code','ENOENT');
 });
 it('changed device identity and expiry invalidate an existing wizard',async()=>{
    const f=await fixture(),s=await configurationSession(f),form=await(await s.bootstrap()).json() as {csrf:string};await writeState('credentials',{deviceId:randomUUID(),token:'PRIVATE'});expect((await s.post('/inventory',{},form.csrf)).status).toBe(400);
    await expect(openProjectConfiguration({...f.descriptor,sessionId:randomUUID(),expiresAt:new Date(Date.now()-1).toISOString()},async()=>{},async()=>{},async()=>true)).rejects.toThrow();
 });
 it('close during held admission prevents a late filesystem write',async()=>{
    const f=await fixture();let hold=false,release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),s=await configurationSession(f,async()=>{if(hold){entered();await blocked;}}),form=await(await s.bootstrap()).json() as {csrf:string};await s.post('/inventory',{},form.csrf);const opened=await(await s.post('/read',{path:'AGENTS.md'},form.csrf)).json() as {revision:string};const preview=await(await s.post('/preview',{path:'AGENTS.md',revision:opened.revision,text:'Never write'},form.csrf)).json() as {previewId:string;digest:string};hold=true;
    const pending=s.post('/save',{previewId:preview.previewId,digest:preview.digest},form.csrf).catch(()=>null);await started;await closeConfigurationSessions();release();await pending;await new Promise(r=>setImmediate(r));await expect(fs.stat(path.join(f.root,'AGENTS.md'))).rejects.toHaveProperty('code','ENOENT');
 });
 it('serializes competing browser actions while a fresh permit is pending',async()=>{
    const f=await fixture();let hold=false,release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),s=await configurationSession(f,async()=>{if(hold){entered();await blocked;}}),form=await(await s.bootstrap()).json() as {csrf:string};hold=true;const pending=s.post('/inventory',{},form.csrf);await started;expect((await s.post('/read',{path:'AGENTS.md'},form.csrf)).status).toBe(409);hold=false;release();expect((await pending).status).toBe(200);
 });
 it('failed browser launch releases its loopback listener',async()=>{
    const f=await fixture();let address='';await expect(openProjectConfiguration(f.descriptor,async()=>{},async()=>{},async url=>{address=url;return false;})).rejects.toThrow('открыть');await expect(fetch(new URL(address).origin)).rejects.toThrow();
 });
 it.each(['extra','array','oversize'])('rejects malformed %s input before project reads',async mode=>{
    const f=await fixture(),permit=vi.fn(async()=>{}),s=await configurationSession(f,permit),form=await(await s.bootstrap()).json() as {csrf:string};permit.mockClear();const input=mode==='array'?[]:mode==='oversize'?{path:'x'.repeat(610*1024)}:{path:'AGENTS.md',contents:'SECRET'};expect((await s.post('/read',input,form.csrf)).status).toBeGreaterThanOrEqual(400);expect(permit).not.toHaveBeenCalled();
 });
});
