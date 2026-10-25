import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type {ConfigService} from '@nestjs/config';
import axios from 'axios';
import {AuthService} from '../src/auth/auth.service';
import {SessionService} from '../src/auth/session.service';
import {CatalogSessionClient} from '../src/auth/catalog-session.client';
import {createSessionInput} from '../../catalog-service/src/browser-auth-sessions/browser-auth-session.validation';
import type {IBridgeUser} from '../src/auth/interface';

const http=vi.hoisted(()=>({post:vi.fn(),get:vi.fn(),request:vi.fn()}));
vi.mock('axios',async importOriginal=>{
 const original=await importOriginal<typeof import('axios')>();
 return {...original,default:{...original.default,create:vi.fn(()=>http)}};
});
const claims={userRoles:['Разработчик'],projects:[{id:'project',name:'QA',role:'Разработчик'}]};
const user=():IBridgeUser=>({id:'qa',email:'qa@example.test',principalName:'qa@example.test',displayName:'QA',userRoles:[],activeRole:'',routePermissions:[],projectRoles:[]});
const service=(values:Record<string,string>={})=>new AuthService({get:(key:string)=>values[key]}as unknown as ConfigService);

beforeEach(()=>{vi.clearAllMocks();http.post.mockResolvedValue({data:{access_token:'synthetic-token'}});http.get.mockImplementation(async(url:string)=>({data:url.includes('/blitz/oauth/me')?{sub:'id',email:'QA@EXAMPLE.TEST',name:'QA'}:claims}));});
afterEach(()=>{vi.unstubAllEnvs();});

describe('OAuth provider and current catalog authorization',()=>{
 it('uses PKCE, bounded redirect-free transport and no secret in browser URLs',()=>{
  const auth=service({SSO_HOST:'https://idp.example///',PANEL_URL:'https://panel.example///',SSO_CLIENT_ID:'client & id',SSO_CLIENT_SECRET:'synthetic-secret',REDIRECT_URI:'https://panel.example/auth/callback',SSO_SCOPE:'openid email',SSO_DISABLE:'true'});
  expect(axios.create).toHaveBeenCalledWith({timeout:15000,maxRedirects:0});expect(auth.ssoDisabled).toBe(true);expect(auth.panelUrl).toBe('https://panel.example');
  const authorize=new URL(auth.authorizeUrl('state','challenge'));expect(authorize.pathname).toBe('/blitz/oauth/ae');
  expect(Object.fromEntries(authorize.searchParams)).toEqual({response_type:'code',client_id:'client & id',redirect_uri:'https://panel.example/auth/callback',scope:'openid email',state:'state',code_challenge:'challenge',code_challenge_method:'S256'});
  expect(authorize.href).not.toContain('synthetic-secret');
  const logout=new URL(auth.logoutUrl());expect(logout.searchParams.get('post_logout_redirect_uri')).toBe('https://panel.example/');
  expect(service().panelUrl).toBe('http://localhost:5173');expect(service().ssoDisabled).toBe(false);
 });
 it('exchanges the code with form-encoded Basic components and trusts current catalog roles only',async()=>{
  vi.stubEnv('CATALOG_SERVICE_URL','http://127.0.0.1:49999/');vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','synthetic-internal');
  const auth=service({SSO_HOST:'https://idp.example',SSO_CLIENT_ID:'client +:/',SSO_CLIENT_SECRET:'synthetic +:/',REDIRECT_URI:'https://panel.example/auth/callback'});
  const result=await auth.exchangeCode('code','verifier');expect(result).toMatchObject({id:'id',email:'qa@example.test',principalName:'qa@example.test',activeRole:'Разработчик',projectRoles:claims.projects});
  const [url,body,options]=http.post.mock.calls[0];expect(url).toBe('https://idp.example/blitz/oauth/te');
  expect(Object.fromEntries(body)).toEqual({grant_type:'authorization_code',code:'code',redirect_uri:'https://panel.example/auth/callback',code_verifier:'verifier'});
  expect(Buffer.from(options.headers.Authorization.slice(6),'base64').toString()).toBe('client+%2B%3A%2F:synthetic+%2B%3A%2F');
  expect(http.get.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-token');
  expect(http.get.mock.calls[1]).toEqual(['http://127.0.0.1:49999/internal/access/profile',{params:{email:'qa@example.test'},headers:{'x-neurocenter-internal':'synthetic-internal'}}]);
 });
 it.each(['','x'.repeat(4097),'code\n','code\u0000'])('rejects malformed authorization code before any provider call',async code=>{
  await expect(service().exchangeCode(code,'v')).rejects.toBeInstanceOf(ForbiddenException);expect(http.post).not.toHaveBeenCalled();expect(http.get).not.toHaveBeenCalled();
 });
 it.each([null,{}, {access_token:0},{access_token:''},{access_token:'token with-space'},{access_token:'token\n'}])('rejects malformed token without sending userinfo',async data=>{
  http.post.mockResolvedValue({data});await expect(service().exchangeCode('code','v')).rejects.toBeInstanceOf(ForbiddenException);expect(http.get).not.toHaveBeenCalled();
 });
 it.each([null,{email_verified:false,sub:'id',email:'qa@example.test'},{email:'qa@example.test'},{sub:' ' ,email:'qa@example.test'},
  {sub:'x'.repeat(513),email:'qa@example.test'},{sub:-1,email:'qa@example.test'},{sub:0.5,email:'qa@example.test'},{sub:'id',email:42},{sub:'id',email:'invalid'}])('rejects an unconfirmed or malformed profile before catalog authorization',async profile=>{
  http.get.mockResolvedValueOnce({data:profile});await expect(service().exchangeCode('code','v')).rejects.toBeInstanceOf(ForbiddenException);expect(http.get).toHaveBeenCalledTimes(1);
 });
 it.each([{uid:0,mail:' QA@EXAMPLE.TEST '},{preferred_username:'preferred',email:'qa@example.test'}])('accepts documented profile aliases, normalizes email and supplies a safe display name',async profile=>{
  http.get.mockResolvedValueOnce({data:profile});const result=await service().exchangeCode('code','v');
  expect(result.id).toBe(String('uid'in profile?profile.uid:profile.preferred_username));expect(result.email).toBe('qa@example.test');expect(result.displayName).toBe('qa@example.test');
 });
 it.each(['','   ',undefined,null,42,'x'.repeat(513),'QA\u0000name'])('an optional unusable provider name cannot prevent durable session creation: %s',async name=>{
  http.get.mockResolvedValueOnce({data:{sub:'id',email:' QA@EXAMPLE.TEST ',name}});
  http.request.mockImplementation(async({data}:{data:unknown})=>{createSessionInput(data);return {status:201,data:{created:true}};});
  const sessions=new SessionService(new CatalogSessionClient()),profile=await service().exchangeCode('code','v');
  await expect(sessions.create(profile)).resolves.toMatch(/^[a-f0-9]{48}$/);
  expect(http.request.mock.calls[0][0].data.identity.displayName).toBe('qa@example.test');
 });
 it('trims a usable optional display name before the durable session boundary',async()=>{
  http.get.mockResolvedValueOnce({data:{sub:'id',email:'qa@example.test',name:'  QA 名字  '}});
  http.request.mockImplementation(async({data}:{data:unknown})=>{createSessionInput(data);return {status:201,data:{created:true}};});
  const sessions=new SessionService(new CatalogSessionClient()),profile=await service().exchangeCode('code','v');
  await expect(sessions.create(profile)).resolves.toMatch(/^[a-f0-9]{48}$/);
  expect(http.request.mock.calls[0][0].data.identity.displayName).toBe('QA 名字');
 });
 it('keeps an assigned selected role, replaces revoked selection and never trusts a requested role',async()=>{
  const auth=service(),selected={...user(),activeRole:'Наблюдатель'};
  http.get.mockResolvedValue({data:{userRoles:['Разработчик','Наблюдатель'],projects:[]}});
  expect((await auth.refreshAccess(selected)).activeRole).toBe('Наблюдатель');
  http.get.mockResolvedValue({data:claims});expect((await auth.refreshAccess(selected)).activeRole).toBe('Разработчик');
  expect(()=>auth.applyRole(selected,'Главный админ')).toThrow(ForbiddenException);expect(selected.activeRole).toBe('Разработчик');
  expect(auth.applyRole({...user(),userRoles:['Главный админ']},'Главный админ').routePermissions).toContain('maintenance');
 });
 it('fails closed for missing membership, disabled accounts, malformed claims and catalog outages',async()=>{
  const auth=service();http.get.mockResolvedValue({data:{userRoles:[],projects:[]}});await expect(auth.refreshAccess(user())).rejects.toBeInstanceOf(ForbiddenException);
  http.get.mockRejectedValue({isAxiosError:true,response:{status:403}});await expect(auth.refreshAccess(user())).rejects.toBeInstanceOf(ForbiddenException);
  http.get.mockRejectedValue(new Error('synthetic outage'));await expect(auth.refreshAccess(user())).rejects.toBeInstanceOf(ServiceUnavailableException);
  http.get.mockResolvedValue({data:{projects:[]}});await expect(auth.refreshAccess(user())).rejects.toBeInstanceOf(ServiceUnavailableException);
 });
 it('dev login still requires actual catalog grants and respects configured account identity',async()=>{
  vi.stubEnv('DEV_USER_EMAIL','');expect((await service().mockUser()).email).toBe('dev@localhost');
  vi.stubEnv('DEV_USER_EMAIL','configured@example.test');expect((await service().mockUser()).principalName).toBe('configured@example.test');
  http.get.mockRejectedValue(new Error('offline'));await expect(service().mockUser()).rejects.toBeInstanceOf(ServiceUnavailableException);
 });
 it.each(['Главный админ','Админ проекта','Разработчик','Наблюдатель','unknown'])('returns role policies without promoting a lesser role: %s',role=>{
  const policies=service().policies(role);expect(policies.GET_PERMISSIONS_LANCEDB_OPERATIONS).toEqual(role==='Главный админ'?['operations#manage']:[]);
  expect(policies.GET_PERMISSIONS_LANCEDB_PROJECTS.includes('projects#create')).toBe(role==='Главный админ');
  expect(policies.GET_PERMISSIONS_LANCEDB_RAG.includes('rag#sync')).toBe(['Главный админ','Админ проекта','Разработчик'].includes(role));
 });
});
