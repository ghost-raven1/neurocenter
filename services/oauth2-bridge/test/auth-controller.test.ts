import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type {Request,Response} from 'express';
import type {AuthService} from '../src/auth/auth.service';
import type {IBridgeUser} from '../src/auth/interface';
import {AuthController} from '../src/auth/auth.controller';
import {SessionService} from '../src/auth/session.service';
import {OAuthTransactions} from '../src/auth/oauth-transactions.service';

import {authControllerFixture as fixture,catalogSessionPort,sessionUser as current} from './auth-session.fixture';
beforeEach(()=>{vi.stubEnv('SESSION_TTL_SECONDS','60');});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe('OAuth routes preserve transaction and session boundaries',()=>{
 it('dev login creates a bounded HttpOnly cookie and preserves only approved return paths',async()=>{
  const f=fixture(true,'http://localhost:5173');await f.controller.login(f.req({query:{returnTo:'/start?step=1'}}),f.res);
  const [name,token,options]=f.response.cookie.mock.calls[0];expect(name).toBe('bridge_session');await f.controller.me(f.req({cookies:{bridge_session:token}}),f.res);expect(f.response.json).toHaveBeenLastCalledWith({user:f.user,policies:{allowed:['projects']}});
  expect(options).toEqual({httpOnly:true,secure:false,sameSite:'lax',path:'/',maxAge:60000});expect(f.response.redirect).toHaveBeenCalledWith('http://localhost:5173/start?step=1');
 });
 it('SSO login emits only state cookie and PKCE authorize redirect',async()=>{
  const f=fixture();await f.controller.login(f.req({query:{returnTo:'https://evil.example'}}),f.res);
  const [name,state,options]=f.response.cookie.mock.calls[0];expect(name).toBe('oauth_state');expect(options).toEqual({httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600000});
  expect(f.auth.authorizeUrl).toHaveBeenCalledWith(state,expect.any(String));expect(await f.sessions.get(state)).toBeNull();expect(f.auth.mockUser).not.toHaveBeenCalled();
 });
 it('dev callback does not trust code/query cookies or contact the provider',async()=>{
  const f=fixture(true);await f.controller.callback(f.req({query:{code:'ignored'}}),f.res);
  expect(f.response.redirect).toHaveBeenCalledWith('https://panel.example/');expect(f.auth.exchangeCode).not.toHaveBeenCalled();
 });
 it('rejects absent or mismatched state without consuming a valid transaction',async()=>{
  const f=fixture(),created=f.transactions.create('/projects/project');await f.controller.callback(f.req(),f.res);
  expect(f.response.redirect).toHaveBeenLastCalledWith('https://panel.example/?login_error=state');
  await f.controller.callback(f.req({query:{state:created.state},cookies:{oauth_state:'0'.repeat(64)}}),f.res);
  expect(f.transactions.consume(created.state,created.state)).not.toBeNull();expect(f.auth.exchangeCode).not.toHaveBeenCalled();
 });
 it('consumes successful state, clears old transaction cookies and creates the session once',async()=>{
  const f=fixture(),created=f.transactions.create('/projects/project?tab=rag');
  const req=f.req({query:{state:created.state,code:'code'},cookies:{oauth_state:created.state}});await f.controller.callback(req,f.res);
  expect(f.auth.exchangeCode).toHaveBeenCalledWith('code',expect.any(String));expect(f.response.redirect).toHaveBeenLastCalledWith('https://panel.example/projects/project?tab=rag');
  expect(f.response.clearCookie.mock.calls.map(call=>call[0])).toEqual(['oauth_state','oauth_return']);
  await f.controller.me(f.req({cookies:{bridge_session:f.response.cookie.mock.calls[0][1]}}),f.res);expect(f.response.json).toHaveBeenLastCalledWith({user:f.user,policies:{allowed:['projects']}});await f.controller.callback(req,f.res);
  expect(f.auth.exchangeCode).toHaveBeenCalledOnce();expect(f.response.redirect).toHaveBeenLastCalledWith('https://panel.example/?login_error=state');
 });
 it('provider denial consumes the state and cannot create a session',async()=>{
  const f=fixture(),created=f.transactions.create('/store');await f.controller.callback(f.req({query:{state:created.state,error:'access_denied'},cookies:{oauth_state:created.state}}),f.res);
  expect(f.response.redirect).toHaveBeenCalledWith('https://panel.example/?login_error=denied');expect(f.auth.exchangeCode).not.toHaveBeenCalled();expect(f.response.cookie).not.toHaveBeenCalled();expect(f.transactions.consume(created.state,created.state)).toBeNull();
 });
 it.each([new Error('private provider body and credential'),{private:'never log body'}])('exchange failure exposes a fixed redirect and only a safe diagnostic class',async error=>{
  const f=fixture(),created=f.transactions.create('/store'),diagnostic=vi.spyOn(console,'error').mockImplementation(()=>undefined);f.auth.exchangeCode.mockRejectedValue(error);
  await f.controller.callback(f.req({query:{state:created.state},cookies:{oauth_state:created.state}}),f.res);
  expect(f.auth.exchangeCode).toHaveBeenCalledWith('',expect.any(String));expect(f.response.redirect).toHaveBeenCalledWith('https://panel.example/?login_error=exchange');
  expect(f.response.cookie).not.toHaveBeenCalled();expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|credential/);
 });
 it('me and role switching require a session and refresh grants before returning or selecting roles',async()=>{
  const f=fixture();await f.controller.me(f.req(),f.res);expect(f.response.status).toHaveBeenLastCalledWith(401);
  await f.controller.switchRole(f.req(),f.res,{role:'Главный админ'});expect(f.response.status).toHaveBeenLastCalledWith(401);expect(f.auth.refreshAccess).not.toHaveBeenCalled();
  const token=await f.sessions.create(f.user),req=f.req({cookies:{bridge_session:token}});await f.controller.me(req,f.res);expect(f.auth.refreshAccess).toHaveBeenCalledWith(f.user);
  expect(f.response.json).toHaveBeenLastCalledWith({user:f.user,policies:{allowed:['projects']}});
  await f.controller.switchRole(req,f.res,{role:'Разработчик'});expect(f.auth.applyRole).toHaveBeenLastCalledWith(f.user,'Разработчик');
  await f.controller.switchRole(req,f.res,undefined as never);expect(f.auth.applyRole).toHaveBeenLastCalledWith(f.user,f.user.activeRole);
  f.auth.refreshAccess.mockRejectedValue(new Error('catalog unavailable'));await expect(f.controller.me(req,f.res)).rejects.toThrow('catalog unavailable');
  const before=f.auth.applyRole.mock.calls.length;await expect(f.controller.switchRole(req,f.res,{role:'Главный админ'})).rejects.toThrow();expect(f.auth.applyRole).toHaveBeenCalledTimes(before);
 });
 it.each([false,true])('both logout routes revoke server state before giving the next destination: dev=%s',async disabled=>{
  const f=fixture(disabled),first=await f.sessions.create(f.user);await f.controller.logout(f.req({cookies:{bridge_session:first}}),f.res);expect(await f.sessions.get(first)).toBeNull();
  expect(f.response.redirect).toHaveBeenLastCalledWith(disabled?'https://panel.example/':'https://idp.example/logout');
  await f.controller.logout(f.req(),f.res);const second=await f.sessions.create(f.user);await f.controller.logoutJson(f.req({cookies:{bridge_session:second}}),f.res);expect(await f.sessions.get(second)).toBeNull();
  expect(f.response.json).toHaveBeenLastCalledWith(disabled?{}:{redirectUrl:'https://idp.example/logout'});expect(f.response.status).toHaveBeenLastCalledWith(200);
  await f.controller.logoutJson(f.req(),f.res);expect(f.response.clearCookie).toHaveBeenCalledWith('bridge_session');
 });
});

/** Real session/controller instances share only the controlled Catalog HTTP/storage boundary.
 * This component fixture is not physical PostgreSQL/process durability evidence.
 */
describe('Browser sessions across an OAuth bridge instance change',()=>{
 type Authority={enabled:boolean;roles:string[];unavailable:boolean;store:ReturnType<typeof catalogSessionPort>};
 const authority=():Authority=>({enabled:true,roles:['Разработчик','Наблюдатель'],unavailable:false,store:catalogSessionPort()});
 const permissions=(role:string)=>role==='Разработчик'?['projects','help']:['projects'];
 function instance(currentAuthority:Authority){
  const refreshAccess=vi.fn(async(user:IBridgeUser)=>{
   if(currentAuthority.unavailable)throw new ServiceUnavailableException('Role authority unavailable');
   if(!currentAuthority.enabled||!currentAuthority.roles.length)throw new ForbiddenException('Account access revoked');
   user.userRoles=[...currentAuthority.roles];user.projectRoles=[];
   if(!user.userRoles.includes(user.activeRole))user.activeRole=user.userRoles[0];
   user.routePermissions=permissions(user.activeRole);return user;
  });
  const auth={ssoDisabled:true,panelUrl:'http://localhost:5173',refreshAccess,
   mockUser:vi.fn(()=>refreshAccess({...current(),userRoles:[],activeRole:'',routePermissions:[]})),
   policies:vi.fn((role:string)=>({allowed:permissions(role)})),
   applyRole:vi.fn((user:IBridgeUser,role:string)=>{
    if(!user.userRoles.includes(role))throw new ForbiddenException('Role access revoked');
    user.activeRole=role;user.routePermissions=permissions(role);return user;
   }),logoutUrl:vi.fn(()=>'http://localhost:5173/')};
  const sessions=new SessionService(currentAuthority.store.client()),controller=new AuthController(auth as unknown as AuthService,sessions,new OAuthTransactions());
  const response={cookie:vi.fn(),redirect:vi.fn(),clearCookie:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
  const res=response as unknown as Response;
  const req=(token?:string)=>({query:{returnTo:'/store?tab=agents'},cookies:token?{bridge_session:token}:{}})as unknown as Request;
  return {auth,sessions,controller,response,res,req};
 }
 type Instance=ReturnType<typeof instance>;
 async function login(value:Instance):Promise<string>{
  await value.controller.login(value.req(),value.res);
  const calls=value.response.cookie.mock.calls,token=calls[calls.length-1]?.[1];
  expect(token).toMatch(/^[a-f0-9]{48}$/);return token as string;
 }
 afterEach(()=>{vi.useRealTimers();});

 it('keeps the accepted identity in a fresh instance, refreshes current grants and remembers an explicit role choice',async()=>{
  const grants=authority(),first=instance(grants),token=await login(first),second=instance(grants);
  grants.roles=['Наблюдатель'];
  await second.controller.me(second.req(token),second.res);
  expect(second.response.status).toHaveBeenLastCalledWith(200);
  expect(second.response.json).toHaveBeenLastCalledWith({user:expect.objectContaining({id:'qa',email:'qa@example.test',
   activeRole:'Наблюдатель',userRoles:['Наблюдатель'],routePermissions:['projects']}),policies:{allowed:['projects']}});
  expect(second.auth.refreshAccess).toHaveBeenCalledOnce();expect(second.auth.mockUser).not.toHaveBeenCalled();
  grants.roles=['Наблюдатель','Разработчик'];
  await second.controller.switchRole(second.req(token),second.res,{role:'Наблюдатель'});
  grants.roles=['Разработчик','Наблюдатель'];
  const third=instance(grants);await third.controller.me(third.req(token),third.res);
  expect(third.response.status).toHaveBeenLastCalledWith(200);
  expect(third.response.json).toHaveBeenLastCalledWith(expect.objectContaining({user:expect.objectContaining({activeRole:'Наблюдатель'})}));
 });

 it('revokes the same cookie in another instance without leaving the first instance authorized',async()=>{
  const grants=authority(),first=instance(grants),token=await login(first),second=instance(grants);
  await second.controller.logoutJson(second.req(token),second.res);expect(second.response.status).toHaveBeenLastCalledWith(200);
  await first.controller.me(first.req(token),first.res);
  expect(first.response.status).toHaveBeenLastCalledWith(401);expect(first.response.json).toHaveBeenLastCalledWith({message:'Unauthorized'});
 });

 it('keeps the original absolute expiry rather than renewing it on successful reads',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const value=instance(authority()),token=await login(value);
  vi.setSystemTime(59999);await value.controller.me(value.req(token),value.res);expect(value.response.status).toHaveBeenLastCalledWith(200);
  const checks=value.auth.refreshAccess.mock.calls.length;value.response.json.mockClear();
  vi.setSystemTime(60000);await value.controller.me(value.req(token),value.res);
  expect(value.response.status).toHaveBeenLastCalledWith(401);expect(value.auth.refreshAccess).toHaveBeenCalledTimes(checks);
  expect(value.response.json).toHaveBeenLastCalledWith({message:'Unauthorized'});
 });

 it('does not return previously accepted grants after the account authority revokes access',async()=>{
  const grants=authority(),value=instance(grants),token=await login(value);
  await value.controller.me(value.req(token),value.res);expect(value.response.status).toHaveBeenLastCalledWith(200);
  grants.enabled=false;value.response.json.mockClear();
  await expect(value.controller.me(value.req(token),value.res)).rejects.toHaveProperty('status',403);
  expect(value.response.json).not.toHaveBeenCalled();
 });

 it.each(['read','create','revoke']as const)('does not turn a controlled session-store %s outage into identity or successful logout',async operation=>{
  const value=instance(authority()),token=operation==='create'?undefined:await login(value);
  value.response.cookie.mockClear();value.response.redirect.mockClear();value.response.clearCookie.mockClear();value.response.json.mockClear();value.auth.refreshAccess.mockClear();
  const outage=()=>{throw new ServiceUnavailableException('Session store unavailable');};
  if(operation==='read')vi.spyOn(value.sessions,'get').mockImplementation(outage);
  else if(operation==='create')vi.spyOn(value.sessions,'create').mockImplementation(outage);
  else vi.spyOn(value.sessions,'remove').mockImplementation(outage);
  const request=async()=>{if(operation==='read')await value.controller.me(value.req(token),value.res);
   else if(operation==='create')await value.controller.login(value.req(),value.res);else await value.controller.logoutJson(value.req(token),value.res);};
  await expect(request()).rejects.toHaveProperty('status',503);
  expect(value.response.json).not.toHaveBeenCalled();expect(value.response.cookie).not.toHaveBeenCalled();
  expect(value.response.clearCookie).not.toHaveBeenCalled();expect(value.response.redirect).not.toHaveBeenCalled();
  if(operation==='read')expect(value.auth.refreshAccess).not.toHaveBeenCalled();
 });

 it('keeps an authority outage distinct from logout and rechecks the same cookie after recovery',async()=>{
  const grants=authority(),value=instance(grants),token=await login(value);
  await value.controller.me(value.req(token),value.res);expect(value.response.status).toHaveBeenLastCalledWith(200);
  value.response.json.mockClear();grants.unavailable=true;
  await expect(value.controller.me(value.req(token),value.res)).rejects.toHaveProperty('status',503);
  expect(value.response.json).not.toHaveBeenCalled();expect(value.response.clearCookie).not.toHaveBeenCalled();
  grants.unavailable=false;grants.roles=['Наблюдатель'];await value.controller.me(value.req(token),value.res);
  expect(value.response.json).toHaveBeenLastCalledWith(expect.objectContaining({user:expect.objectContaining({userRoles:['Наблюдатель'],activeRole:'Наблюдатель'})}));
 });
});
