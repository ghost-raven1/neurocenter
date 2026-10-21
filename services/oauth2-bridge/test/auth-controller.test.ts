import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request,Response} from 'express';
import type {AuthService} from '../src/auth/auth.service';
import type {IBridgeUser} from '../src/auth/interface';
import {AuthController} from '../src/auth/auth.controller';
import {SessionService} from '../src/auth/session.service';
import {OAuthTransactions} from '../src/auth/oauth-transactions.service';

const current=():IBridgeUser=>({id:'qa',email:'qa@example.test',principalName:'qa@example.test',displayName:'QA',userRoles:['Разработчик'],activeRole:'Разработчик',routePermissions:['projects'],projectRoles:[]});
function fixture(disabled=false,panelUrl='https://panel.example'){
 const user=current(),auth={ssoDisabled:disabled,panelUrl,mockUser:vi.fn(async()=>user),
  authorizeUrl:vi.fn((state:string,challenge:string)=>'https://idp.example/authorize?state='+state+'&challenge='+challenge),
  exchangeCode:vi.fn(async()=>user),refreshAccess:vi.fn(async()=>user),policies:vi.fn(()=>({allowed:['projects']})),
  logoutUrl:vi.fn(()=> 'https://idp.example/logout'),applyRole:vi.fn()};
 const sessions=new SessionService(),transactions=new OAuthTransactions(),controller=new AuthController(auth as unknown as AuthService,sessions,transactions);
 const response={cookie:vi.fn(),redirect:vi.fn(),clearCookie:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 const res=response as unknown as Response,req=(value:Record<string,unknown>={})=>({query:{},...value})as Request;
 return {auth,user,sessions,transactions,controller,response,res,req};
}
beforeEach(()=>{vi.stubEnv('SESSION_TTL_SECONDS','60');});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe('OAuth routes preserve transaction and session boundaries',()=>{
 it('dev login creates a bounded HttpOnly cookie and preserves only approved return paths',async()=>{
  const f=fixture(true,'http://localhost:5173');await f.controller.login(f.req({query:{returnTo:'/start?step=1'}}),f.res);
  const [name,token,options]=f.response.cookie.mock.calls[0];expect(name).toBe('bridge_session');expect(f.sessions.get(token)).toBe(f.user);
  expect(options).toEqual({httpOnly:true,secure:false,sameSite:'lax',path:'/',maxAge:60000});expect(f.response.redirect).toHaveBeenCalledWith('http://localhost:5173/start?step=1');
 });
 it('SSO login emits only state cookie and PKCE authorize redirect',async()=>{
  const f=fixture();await f.controller.login(f.req({query:{returnTo:'https://evil.example'}}),f.res);
  const [name,state,options]=f.response.cookie.mock.calls[0];expect(name).toBe('oauth_state');expect(options).toEqual({httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600000});
  expect(f.auth.authorizeUrl).toHaveBeenCalledWith(state,expect.any(String));expect(f.sessions.get(state)).toBeNull();expect(f.auth.mockUser).not.toHaveBeenCalled();
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
  expect(f.sessions.get(f.response.cookie.mock.calls[0][1])).toBe(f.user);await f.controller.callback(req,f.res);
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
  const token=f.sessions.create(f.user),req=f.req({cookies:{bridge_session:token}});await f.controller.me(req,f.res);expect(f.auth.refreshAccess).toHaveBeenCalledWith(f.user);
  expect(f.response.json).toHaveBeenLastCalledWith({user:f.user,policies:{allowed:['projects']}});
  await f.controller.switchRole(req,f.res,{role:'Разработчик'});expect(f.auth.applyRole).toHaveBeenLastCalledWith(f.user,'Разработчик');
  await f.controller.switchRole(req,f.res,undefined as never);expect(f.auth.applyRole).toHaveBeenLastCalledWith(f.user,f.user.activeRole);
  f.auth.refreshAccess.mockRejectedValue(new Error('catalog unavailable'));await expect(f.controller.me(req,f.res)).rejects.toThrow('catalog unavailable');
  const before=f.auth.applyRole.mock.calls.length;await expect(f.controller.switchRole(req,f.res,{role:'Главный админ'})).rejects.toThrow();expect(f.auth.applyRole).toHaveBeenCalledTimes(before);
 });
 it.each([false,true])('both logout routes revoke server state before giving the next destination: dev=%s',disabled=>{
  const f=fixture(disabled),first=f.sessions.create(f.user);f.controller.logout(f.req({cookies:{bridge_session:first}}),f.res);expect(f.sessions.get(first)).toBeNull();
  expect(f.response.redirect).toHaveBeenLastCalledWith(disabled?'https://panel.example/':'https://idp.example/logout');
  f.controller.logout(f.req(),f.res);const second=f.sessions.create(f.user);f.controller.logoutJson(f.req({cookies:{bridge_session:second}}),f.res);expect(f.sessions.get(second)).toBeNull();
  expect(f.response.json).toHaveBeenLastCalledWith(disabled?{}:{redirectUrl:'https://idp.example/logout'});expect(f.response.status).toHaveBeenLastCalledWith(200);
  f.controller.logoutJson(f.req(),f.res);expect(f.response.clearCookie).toHaveBeenCalledWith('bridge_session');
 });
});
