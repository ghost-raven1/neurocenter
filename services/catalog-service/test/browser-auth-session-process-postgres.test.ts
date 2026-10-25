import {randomUUID,createHash} from 'node:crypto';
import {fork,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve,join,dirname} from 'node:path';
import {access} from 'node:fs/promises';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {BrowserAuthSessionController} from '../src/browser-auth-sessions/browser-auth-session.controller';
import {BrowserAuthSessionRepository} from '../src/browser-auth-sessions/browser-auth-session.repository';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {assertInternal} from '../src/access/access.controller';
import {browserSessionDatabase} from './browser-auth-session-postgres.fixture';

const connection=process.env.SYSTEM_BROWSER_AUTH_SESSION_TEST_ADMIN_URL;
type Result={status:number|null;cookies:Array<{name:string;value:string}>;cleared:string[];redirect:string|null;json:{user?:{activeRole:string;userRoles:string[]}}|null};
afterEach(()=>vi.unstubAllEnvs());
/** Real process lifetimes + Catalog controller/repository/PG; the HTTP adapter and current grant authority are controlled. */
describe.skipIf(!connection).sequential('Established browser session owned process restart',()=>{
 it('retains only established identity/preference across exits and preserves503 through real storage-pool loss/recovery',async()=>{
  if(process.env.BROWSER_AUTH_SESSION_OWNED_PROFILE!=='1')throw new Error('Use the canonical owned profile, including source/build/network and8GiB admission.');
  const built=resolve(fileURLToPath(new URL('../../oauth2-bridge/dist',import.meta.url)));
  for(const name of ['auth/session.service.js','auth/catalog-session.client.js','auth/auth.controller.js'])await access(join(built,name));
  const f=await browserSessionDatabase(connection),internal='synthetic-owned-'+randomUUID();vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',internal);
  let pool=f.pool,controller=new BrowserAuthSessionController(new BrowserAuthSessionRepository(pool)),roles=['Разработчик','Наблюдатель'];
  const children=new Set<ChildProcess>();
  const server=createServer(async(req,res)=>{
   try{
    const url=new URL(req.url!,'http://127.0.0.1'),token=req.headers['x-neurocenter-internal'];let body='';
    for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)throw new Error('Owned body limit');}
    let value:unknown;
    if(url.pathname==='/internal/access/profile'){assertInternal(token);value={userRoles:roles,projects:[]};}
    else{
     const parts=url.pathname.split('/');if(parts[1]!=='internal'||parts[2]!=='browser-auth-sessions'){res.writeHead(404).end();return;}
     if(req.method==='POST')value=await controller.create(token,JSON.parse(body));
     else if(req.method==='GET')value=await controller.find(token,parts[3]);
     else if(req.method==='PATCH')value=await controller.selectRole(token,parts[3],JSON.parse(body));
     else if(req.method==='DELETE')value=await controller.revoke(token,parts[3]);else{res.writeHead(404).end();return;}
    }
    res.writeHead(req.method==='POST'?201:200,{'content-type':'application/json'}).end(JSON.stringify(value));
   }catch(error){const status=typeof(error as {getStatus?:unknown}).getStatus==='function'?(error as {getStatus:()=>number}).getStatus():500;res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({message:'Owned boundary unavailable'}));}
  });
  const stop=async(child:ChildProcess)=>{
   if(!children.has(child))return;
   await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');no(new Error('Owned child did not exit'));},3000);child.once('exit',code=>{clearTimeout(timer);children.delete(child);code===0?yes():no(new Error('Owned child failed to stop'));});child.send({action:'stop'});});
  };
  try{
   await ensureCatalogSchema(pool);await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
   const address=server.address();if(!address||typeof address==='string')throw new Error('Owned loopback listener unavailable');
   const start=async()=>{
    const env:NodeJS.ProcessEnv={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',NODE_DISABLE_COMPILE_CACHE:'1',SESSION_TTL_SECONDS:'300',DEV_USER_EMAIL:'qa@example.test',CATALOG_SERVICE_URL:'http://127.0.0.1:'+address.port,NEUROCENTER_INTERNAL_TOKEN:internal,BROWSER_SESSION_BUILT_ROOT:built};
    for(const name of ['NODE_OPTIONS','NC_OPERATOR_FENCE_DIR','NC_OPERATOR_FENCE_NONCE','NC_OPERATOR_FENCE_POLICY_FILE'])if(process.env[name])env[name]=process.env[name];
    const child=fork(fileURLToPath(new URL('./browser-auth-session-process.fixture.cjs',import.meta.url)),[],{execPath:process.execPath,execArgv:[],env,stdio:['ignore','pipe','pipe','ipc']});children.add(child);child.once('exit',()=>children.delete(child));
    let bytes=0;for(const stream of [child.stdout,child.stderr])stream?.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>65536)child.kill('SIGKILL');});
    await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(new Error('Owned child startup deadline')),10000);child.once('error',()=>{clearTimeout(timer);no(new Error('Owned child startup failed'));});child.once('exit',()=>{clearTimeout(timer);no(new Error('Owned child exited before ready'));});child.once('message',value=>{clearTimeout(timer);(value as {ready?:boolean}).ready?yes():no(new Error('Unexpected owned startup'));});});
    const call=(action:string,token?:string,role?:string)=>new Promise<Result>((yes,no)=>{const id=randomUUID(),timer=setTimeout(()=>{child.off('message',listener);no(new Error('Owned action deadline'));},10000);const listener=(value:unknown)=>{const message=value as {id?:string;result:Result};if(message.id!==id)return;clearTimeout(timer);child.off('message',listener);yes(message.result);};child.on('message',listener);child.send({id,action,token,role});});
    return {child,call};
   };
   for(const headers of [{},{'x-neurocenter-internal':'wrong'},{cookie:'bridge_session=synthetic'}]){
    const denied=await fetch('http://127.0.0.1:'+address.port+'/internal/browser-auth-sessions/'+('a'.repeat(64)),{headers});expect(denied.status).toBe(403);
   }
   const first=await start(),login=await first.call('login'),token=login.cookies.find(row=>row.name==='bridge_session')!.value,hash=createHash('sha256').update(token).digest('hex');
   const original=(await pool.query('SELECT created_at,expires_at FROM browser_auth_sessions WHERE token_hash=$1',[hash])).rows[0];await stop(first.child);
   roles=['Наблюдатель'];const second=await start();expect((await second.call('me',token)).json?.user).toMatchObject({activeRole:'Наблюдатель',userRoles:['Наблюдатель']});
   roles=['Наблюдатель','Разработчик'];expect((await second.call('role',token,'Наблюдатель')).status).toBe(200);await stop(second.child);
   roles=['Разработчик','Наблюдатель'];const third=await start();expect((await third.call('me',token)).json?.user?.activeRole).toBe('Наблюдатель');
   expect((await pool.query('SELECT created_at,expires_at FROM browser_auth_sessions WHERE token_hash=$1',[hash])).rows[0]).toEqual(original);
   const freshToken=(await third.call('login')).cookies.find(row=>row.name==='bridge_session')!.value;
   await f.retire(pool);
   for(const action of ['me','logout','login']){const unavailable=await third.call(action,freshToken);expect(unavailable.status).toBe(503);expect(unavailable.cookies).toEqual([]);expect(unavailable.cleared).toEqual([]);expect(unavailable.json).toBeNull();expect(unavailable.redirect).toBeNull();}
   pool=f.createPool();controller=new BrowserAuthSessionController(new BrowserAuthSessionRepository(pool));roles=['Наблюдатель'];
   expect((await third.call('me',freshToken)).json?.user?.userRoles).toEqual(['Наблюдатель']);
   expect((await third.call('logout',token)).status).toBe(200);await stop(third.child);
   const fourth=await start();expect((await fourth.call('me',token)).status).toBe(401);await stop(fourth.child);
  }finally{
   try{for(const child of [...children]){if(child.exitCode!==null||child.signalCode!==null){children.delete(child);continue;}await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(new Error('Owned child cleanup deadline')),3000);child.once('exit',()=>{clearTimeout(timer);yes();});child.kill('SIGKILL');});}children.clear();await new Promise<void>(yes=>server.close(()=>yes()));}
   finally{await f.close();}
  }
 },90000);
});
