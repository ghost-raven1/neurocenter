import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {SessionService} from '../src/auth/session.service';
import {catalogSessionPort,sessionUser} from './auth-session.fixture';
import {OAuthTransactions} from '../src/auth/oauth-transactions.service';
import {loginReturn} from '../src/auth/login-return';
import {roleRoutes} from '../src/auth/roles';
import {allowBrowserOrigin,browserSecurity,panelOrigin} from '../src/security/browser-security';
import type {Request,Response,NextFunction} from 'express';
const user=sessionUser();
const sessionService=()=>new SessionService(catalogSessionPort().client());
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();});

describe('Session and single-use OAuth transaction boundaries',()=>{
 it.each(['59','86401','NaN','1.5'])('rejects invalid session lifetime: %s',value=>{vi.stubEnv('SESSION_TTL_SECONDS',value);expect(()=>sessionService()).toThrow('SESSION_TTL_SECONDS');});
 it('expires exactly at the original deadline and never reuses bearer tokens',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);vi.stubEnv('SESSION_TTL_SECONDS','60');const sessions=sessionService(),first=await sessions.create(user);
  expect(first).toMatch(/^[a-f0-9]{48}$/);expect(sessions.ttlMs).toBe(60000);expect(await sessions.get(first)).toMatchObject({id:user.id,email:user.email,userRoles:[],routePermissions:[],projectRoles:[]});
  expect(await sessions.get(undefined)).toBeNull();expect(await sessions.get('unknown')).toBeNull();await sessions.remove(undefined);
  vi.setSystemTime(59999);expect(await sessions.get(first)).toMatchObject({id:user.id,email:user.email,userRoles:[],routePermissions:[],projectRoles:[]});vi.setSystemTime(60000);expect(await sessions.get(first)).toBeNull();
  const second=await sessions.create(user);vi.setSystemTime(120000);const third=await sessions.create(user);expect(await sessions.get(second)).toBeNull();expect(third).not.toBe(second);await sessions.remove(third);expect(await sessions.get(third)).toBeNull();
  vi.stubEnv('SESSION_TTL_SECONDS','');expect(sessionService().ttlMs).toBe(28800000);
 });
 it('binds exact state/cookie/PKCE and consumes success once without consuming mismatched transactions',()=>{
  const transactions=new OAuthTransactions(),created=transactions.create('/projects/project?tab=rag#part');
  for(const [state,cookie]of [[undefined,created.state],[created.state,undefined],['invalid',created.state],[created.state,'invalid'],[created.state,'0'.repeat(64)]])expect(transactions.consume(state,cookie)).toBeNull();
  const receipt=transactions.consume(created.state,created.state)!;expect(receipt.returnTo).toBe('/projects/project?tab=rag');expect(createHash('sha256').update(receipt.verifier).digest('base64url')).toBe(created.challenge);
  expect(transactions.consume(created.state,created.state)).toBeNull();expect(transactions.consume('f'.repeat(64),'f'.repeat(64))).toBeNull();
 });
 it('expires pending logins and bounds capacity until old transactions have expired',()=>{
  vi.useFakeTimers();vi.setSystemTime(0);const transactions=new OAuthTransactions(),first=transactions.create('/start');
  vi.setSystemTime(600000);expect(transactions.consume(first.state,first.state)).toBeNull();
  for(let n=0;n<10000;n++)transactions.create('/');expect(()=>transactions.create('/')).toThrow('Слишком много');
  vi.setSystemTime(1200000);expect(transactions.create('/').state).toMatch(/^[a-f0-9]{64}$/);
 },15000);
 it.each([undefined,4,'x'.repeat(2049),'//evil.example','https://evil.example','/unknown','/store bad','/store\\evil','/store\u0000'])('refuses open redirect and unsupported return path',value=>{expect(loginReturn(value)).toBe('/');});
 it('preserves only allowed site paths and role-scoped navigation',()=>{
  expect(loginReturn('/model-usage?projectId=qa#ignored')).toBe('/model-usage?projectId=qa');
  for(const role of ['Главный админ','Админ проекта','Разработчик','Наблюдатель'])expect(roleRoutes(role)).toContain('projects');
  expect(roleRoutes('unknown')).toEqual([]);expect(roleRoutes('Наблюдатель')).not.toContain('model-usage');expect(roleRoutes('Разработчик')).not.toContain('access');
 });
});

describe('Cookie request browser origin gate',()=>{
 const invoke=(method:string,path:string,headers:Record<string,string>)=>{
  const response={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
  const next=vi.fn();browserSecurity({method,path,headers}as Request,response as unknown as Response,next as NextFunction);return {response,next};
 };
 it('compares configured origin and rejects invalid panel URLs rather than trusting forwarded hosts',()=>{
  vi.stubEnv('PANEL_URL','');expect(panelOrigin()).toBe('http://localhost:5173');expect(allowBrowserOrigin(undefined)).toBe(true);expect(allowBrowserOrigin('http://evil.example')).toBe(false);
  for(const url of ['file:///tmp/panel','https://user:password@panel.example']){vi.stubEnv('PANEL_URL',url);expect(()=>panelOrigin()).toThrow();}
 });
 it('allows read-only and non-cookie clients, adds response security headers, protects logout and unsafe cookie writes',()=>{
  vi.stubEnv('PANEL_URL','https://panel.example/path');
  for(const method of ['GET','HEAD','OPTIONS'])expect(invoke(method,'/auth/me',{cookie:'bridge_session=qa'}).next).toHaveBeenCalledOnce();
  expect(invoke('POST','/auth/role',{authorization:'Bearer qa'}).next).toHaveBeenCalledOnce();
  const allowed=invoke('POST','/auth/role',{cookie:'other=1; bridge_session=qa','x-neurocenter-request':'1',origin:'https://panel.example'});expect(allowed.next).toHaveBeenCalledOnce();
  expect(allowed.response.setHeader.mock.calls).toEqual([['Cache-Control','no-store'],['X-Content-Type-Options','nosniff'],['Referrer-Policy','no-referrer']]);
  for(const headers of [{cookie:'bridge_session=qa'},{cookie:'bridge_session=qa','x-neurocenter-request':'1',origin:'https://evil.example'},
   {cookie:'bridge_session=qa','x-neurocenter-request':'1',origin:'https://panel.example','sec-fetch-site':'cross-site'}]){
   const denied=invoke('POST','/auth/role',headers);expect(denied.response.status).toHaveBeenCalledWith(403);expect(denied.next).not.toHaveBeenCalled();
  }
  expect(invoke('GET','/auth/logout',{cookie:'bridge_session=qa'}).response.status).toHaveBeenCalledWith(403);
 });
});

it('Help is reachable by assigned roles; settings are exclusively the main administrator route',()=>{
 for(const role of ['Главный админ','Админ проекта','Разработчик','Наблюдатель']){expect(roleRoutes(role)).toContain('help');expect(roleRoutes(role).includes('settings')).toBe(role==='Главный админ');}
 expect(roleRoutes('unknown')).not.toContain('help');
});
