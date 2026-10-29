import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {afterEach,expect,it,vi} from 'vitest';
import {startGlobalProvidersSession,closeGlobalProvidersSessions} from '../src/features/opencode-local-providers/server.js';
import {contract} from '../src/features/opencode-local-providers/contract.js';
const roots:string[]=[];const secret='SYNTHETIC_HTTP_SECRET_123';
afterEach(async()=>{await closeGlobalProvidersSessions();vi.restoreAllMocks();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
    const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc global session ')));roots.push(home);let url='',revoked=false,rotated=false,incompatible=false;
    const authorize=vi.fn(async(_signal?:AbortSignal)=>{if(revoked)throw Error(secret);}),assertCurrent=vi.fn(async()=>{if(rotated)throw Error(secret);});
    await startGlobalProvidersSession({id:home,home,environment:{},expiresAt:new Date(Date.now()+60000).toISOString(),limits:contract.globalProvidersLimits(),authorize,assertCurrent,assertCompatibleCli:async()=>{if(incompatible)throw Object.assign(Error(secret),{code:'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'});return{assertCurrent:async()=>{}};},open:async value=>{url=value;return true;}});
    const address=new URL(url),origin=address.origin;let csrf='';
    const post=async(route:string,value:unknown,headers:Record<string,string>={})=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(csrf?{'X-Global-Providers-CSRF':csrf}:{}),...headers},body:JSON.stringify(value)});
    const session=async()=>{const response=await post('/session',{token:address.hash.slice(1)});const result=await response.json() as {csrf:string};csrf=result.csrf;return response;};
    return{home,origin,address,post,session,authorize,get csrf(){return csrf;},revoke:()=>{revoked=true;},rotate:()=>{rotated=true;},replaceCli:()=>{incompatible=true;}};
}
it('uses one fragment token, strict Host/Origin and CSRF; public page and responses never contain credentials',async()=>{
    const f=await fixture(),page=await fetch(f.origin);expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");expect(await page.text()).not.toContain(secret);
    expect((await f.post('/session',{token:f.address.hash.slice(1)},{Origin:'https://foreign.invalid'})).status).toBe(403);
    await f.session();expect((await f.post('/session',{token:f.address.hash.slice(1)})).status).toBe(400);
    expect((await f.post('/inventory',{}, {'X-Global-Providers-CSRF':'wrong'})).status).toBe(403);
    const result=await f.post('/inventory',{});expect(result.status).toBe(200);expect(await result.text()).not.toContain(secret);
});
it('revoked authority or rotated device credentials rejects save and never returns the underlying sensitive error',async()=>{
    for(const mode of ['revoke','rotate'] as const){const f=await fixture();await f.session();const preview=await(await f.post('/prepare',{providerId:'openai',authentication:'api',apiKey:secret})).json() as {previewId:string};f[mode]();
        const response=await f.post('/save',{previewId:preview.previewId});expect(response.status).toBeGreaterThanOrEqual(400);expect(await response.text()).not.toContain(secret);await expect(fs.stat(path.join(f.home,'.local/share/opencode/auth.json'))).rejects.toMatchObject({code:'ENOENT'});
    }
});
it('session expiry is checked again before mutation, independently of a live timer',async()=>{
    const f=await fixture();await f.session();const preview=await(await f.post('/prepare',{providerId:'openai',authentication:'api',apiKey:secret})).json() as {previewId:string};
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+120000);const response=await f.post('/save',{previewId:preview.previewId});expect(response.status).toBeGreaterThanOrEqual(400);await expect(fs.stat(path.join(f.home,'.local/share/opencode/auth.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('a dropped save response reconciles the private committed intent and never repeats auth publication',async()=>{
    const f=await fixture();await f.session();const preview=await(await f.post('/prepare',{providerId:'openai',authentication:'api',apiKey:secret})).json() as {previewId:string};
    await new Promise<void>((resolve,reject)=>{const request=http.request(f.origin+'/save',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Global-Providers-CSRF':f.csrf}},response=>{response.destroy();resolve();});request.once('error',reject);request.end(JSON.stringify({previewId:preview.previewId}));});
    const file=path.join(f.home,'.local/share/opencode/auth.json'),before=(await fs.stat(file)).ino;
    const result=await(await f.post('/inventory',{})).json() as {lastSave:{status:string;intentId:string}};expect(result.lastSave.status).toBe('saved');expect(JSON.stringify(result)).not.toContain(secret);
    expect((await f.post('/resume',{intentId:result.lastSave.intentId})).status).toBe(200);expect((await fs.stat(file)).ino).toBe(before);
});
it('a CLI becoming unsupported after opening denies save with a readonly explanation and no credential echo',async()=>{
    const f=await fixture();await f.session();const preview=await(await f.post('/prepare',{providerId:'openai',authentication:'api',apiKey:secret})).json() as {previewId:string};f.replaceCli();
    const response=await f.post('/save',{previewId:preview.previewId}),text=await response.text();expect(response.status).toBe(400);expect(text).toContain('OpenCode1.14.48');expect(text).not.toContain(secret);await expect(fs.stat(path.join(f.home,'.local/share/opencode/auth.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('a preserved OAuth credential explains the local next action without echoing the attempted API key',async()=>{
    const f=await fixture();await f.session();const file=path.join(f.home,'.local/share/opencode/auth.json');await fs.mkdir(path.dirname(file),{recursive:true});const original=JSON.stringify({openai:{type:'oauth',access:'PRIVATE_OAUTH',refresh:'PRIVATE_OAUTH',expires:42}});await fs.writeFile(file,original,{mode:0o600});
    const response=await f.post('/prepare',{providerId:'openai',authentication:'api',apiKey:secret}),text=await response.text();expect(response.status).toBe(400);expect(text).toContain('OAuth');expect(text).toContain('через OpenCode');expect(text).not.toContain(secret);expect(text).not.toContain('PRIVATE_OAUTH');expect(await fs.readFile(file,'utf8')).toBe(original);
});
it('closing waits for an already admitted rename before an installer may replace configuration',async()=>{
    const f=await fixture();await f.session();const preview=await(await f.post('/prepare',{providerId:'openai',authentication:'api',apiKey:secret})).json() as {previewId:string};
    const destination=path.join(f.home,'.local/share/opencode/auth.json'),rename=fs.rename.bind(fs);let release!:()=>void,entered!:()=>void,closed=false;
    const held=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{entered=resolve;});
    vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(to===destination){entered();await held;expect(closed).toBe(false);}return rename(from,to);});
    const save=f.post('/save',{previewId:preview.previewId}).catch(()=>undefined);await reached;
    const closing=closeGlobalProvidersSessions().then(()=>{closed=true;});
    try{await new Promise(resolve=>setTimeout(resolve,30));expect(closed).toBe(false);}
    finally{release();await Promise.all([closing,save]);}
    expect(closed).toBe(true);expect(JSON.parse(await fs.readFile(destination,'utf8')).openai.key).toBe(secret);
});
it('closing aborts an in-flight authority request and an explicit close never waits for its own handler',async()=>{
    const f=await fixture();await f.session();let entered!:()=>void,received:AbortSignal|undefined;const reached=new Promise<void>(resolve=>{entered=resolve;});
    f.authorize.mockImplementationOnce(signal=>new Promise<void>((_resolve,reject)=>{received=signal;entered();const timer=setTimeout(()=>reject(Error('FIXTURE_PERMIT_TIMEOUT')),500);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('ABORTED'));},{once:true});}));
    const request=f.post('/inventory',{}).catch(()=>undefined);await reached;await closeGlobalProvidersSessions();await request;expect(received?.aborted).toBe(true);
    const second=await fixture();await second.session();const response=await second.post('/close',{});expect(response.status).toBe(200);await closeGlobalProvidersSessions();
});
