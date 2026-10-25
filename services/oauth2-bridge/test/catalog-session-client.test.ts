import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import axios from 'axios';
import {SessionService} from '../src/auth/session.service';
import type {CatalogSessionClient} from '../src/auth/catalog-session.client';
import {catalogSessionPort,sessionUser} from './auth-session.fixture';

beforeEach(()=>{vi.stubEnv('SESSION_TTL_SECONDS','60');vi.stubEnv('CATALOG_SERVICE_URL','http://127.0.0.1:49999/');vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','synthetic-internal');});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const input={tokenHash:'a'.repeat(64),identity:{id:'qa',principalName:'qa@example.test',email:'qa@example.test',displayName:'QA'},selectedRole:'Разработчик',ttlSeconds:60};
const invoke=(client:CatalogSessionClient,operation:string)=>operation==='create'?client.create(input):operation==='find'?client.find(input.tokenHash):operation==='selectRole'?client.selectRole(input.tokenHash,'Наблюдатель'):client.revoke(input.tokenHash);

describe('Catalog session transport and protocol boundary',()=>{
 it('sends only the cookie hash and minimal identity, with bounded redirect-free transport and internal authentication',async()=>{
  const port=catalogSessionPort(),sessions=new SessionService(port.client()),user=sessionUser(),token=await sessions.create(user);
  const [request]=port.request.mock.calls[0];
  expect(request).toEqual({method:'post',url:'http://127.0.0.1:49999/internal/browser-auth-sessions',headers:{'x-neurocenter-internal':'synthetic-internal'},data:{...input,tokenHash:createHash('sha256').update(token).digest('hex')}});
  expect(JSON.stringify(request.data)).not.toContain(token);expect(Object.keys(request.data.identity).sort()).toEqual(['displayName','email','id','principalName']);
  expect(axios.create).toHaveBeenCalledWith({timeout:5000,maxRedirects:0,maxContentLength:16384,maxBodyLength:16384,validateStatus:expect.any(Function)});
  const fresh=new SessionService(port.client());expect(await fresh.get(token)).toEqual({...input.identity,activeRole:'Разработчик',userRoles:[],projectRoles:[],routePermissions:[]});
 });
 it('accepts only the explicit missing-row envelope as unauthenticated and makes no calls for malformed cookies',async()=>{
  const port=catalogSessionPort(),sessions=new SessionService(port.client());
  for(const token of [undefined,null,{},'unknown','A'.repeat(48),'a'.repeat(49)])expect(await sessions.get(token)).toBeNull();
  await sessions.remove(undefined);expect(port.request).not.toHaveBeenCalled();expect(await sessions.get('a'.repeat(48))).toBeNull();
 });
 for(const operation of ['create','find','selectRole','revoke']){
  it.each([401,403,404,429,500,503])('keeps '+operation+' HTTP%s distinct from an unknown/revoked session',async status=>{
   const port=catalogSessionPort(),client=port.client();port.request.mockResolvedValueOnce({status,data:{private:'credential'}}as never);
   await expect(invoke(client,operation)).rejects.toMatchObject({status:503,message:expect.not.stringContaining('credential')});
  });
  it('maps '+operation+' transport rejection to a fixed503 without a private body',async()=>{
   const port=catalogSessionPort(),client=port.client();port.request.mockRejectedValueOnce(new Error('private credential'));
   await expect(invoke(client,operation)).rejects.toMatchObject({status:503,message:expect.not.stringContaining('credential')});
  });
 }
 it.each([null,{}, {found:false,session:{}},{found:true,session:null},
  {found:true,session:{identity:input.identity,selectedRole:'Разработчик',expiresAt:'invalid'}},
  {found:true,session:{identity:{...input.identity,userRoles:['Главный админ']},selectedRole:'Главный админ',expiresAt:'2030-01-01T00:00:00.000Z'}},
  {found:true,session:{identity:{...input.identity,access_token:'private'},selectedRole:'Разработчик',expiresAt:'2030-01-01T00:00:00.000Z'}}])('rejects a malformed or widened lookup envelope',async data=>{
  const port=catalogSessionPort(),client=port.client();port.request.mockResolvedValueOnce({status:200,data}as never);
  await expect(client.find(input.tokenHash)).rejects.toHaveProperty('status',503);
 });
 it.each([['create',{created:false}],['create',{created:true,identity:input.identity}],['selectRole',{found:null}],['revoke',{revoked:false}],['revoke',{revoked:true,identity:input.identity}]])('rejects malformed %s acknowledgement',async(operation,data)=>{
  const port=catalogSessionPort(),client=port.client();port.request.mockResolvedValueOnce({status:200,data}as never);
  await expect(invoke(client,String(operation))).rejects.toHaveProperty('status',503);
 });
});
