import 'reflect-metadata';
import type {ConfigService} from '@nestjs/config';
import type {Request} from 'express';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AuthGuardService} from '../src/auth/auth-guard.service';

const client=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),create:vi.fn()}));
vi.mock('axios',()=>({default:{create:client.create}}));
const req=(headers:Record<string,string>={})=>({headers}) as Request;
const valid=()=>({user:{id:'user-7',email:'owner@example.test',principalName:'owner',activeRole:'Главный админ',userRoles:['Главный админ','Разработчик']},policies:{projects:['read','write']}});
const service=(values:Record<string,string>={})=>new AuthGuardService({get:(key:string)=>values[key]} as ConfigService);

/** Each request must verify current authority; bearer identity never falls back to a browser cookie. */
describe('AuthGuardService source authority',()=>{
 beforeEach(()=>{vi.resetAllMocks();client.create.mockReturnValue(client);vi.spyOn(console,'error').mockImplementation(()=>undefined);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-private-internal-token');});
 afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
 it('uses configured origins, forwards only the cookie, and returns the checked identity',async()=>{
  const guard=service({AUTH_SERVICE_URL:'http://auth.fixture///',CATALOG_SERVICE_URL:'http://catalog.fixture/'});client.get.mockResolvedValue({status:200,data:valid()});
  expect(await guard.authenticate(req({cookie:'bridge_session=opaque','x-user-role':'Главный админ'}))).toEqual({email:'owner@example.test',activeRole:'Главный админ',userId:'user-7',principalName:'owner',userRoles:['Главный админ','Разработчик'],policies:{projects:['read','write']}});
  expect(client.get).toHaveBeenCalledWith('http://auth.fixture/auth/me',{headers:{cookie:'bridge_session=opaque'},timeout:10000});expect(client.post).not.toHaveBeenCalled();
  expect(client.create.mock.calls[0][0].validateStatus(503)).toBe(true);expect(client.create.mock.calls[0][0].timeout).toBe(10000);
 });
 it('supports SSO-off identity without a cookie through the default auth service',async()=>{
  client.get.mockResolvedValue({status:200,data:valid()});await service().authenticate(req());expect(client.get).toHaveBeenCalledWith('http://localhost:22222/auth/me',{headers:{},timeout:10000});
 });
 it.each([401,403])('rejects revoked browser authority (%s), without stale identity reuse',async status=>{
  const guard=service();client.get.mockResolvedValueOnce({status:200,data:valid()}).mockResolvedValueOnce({status,data:valid()});expect(await guard.authenticate(req())).not.toBeNull();expect(await guard.authenticate(req())).toBeNull();expect(client.get).toHaveBeenCalledTimes(2);
 });
 it.each([201,302,429,500])('maps unavailable browser authority %s to a generic 503',async status=>{
  client.get.mockResolvedValue({status,data:valid()});await expect(service().authenticate(req())).rejects.toMatchObject({status:503,message:'Проверка входа временно недоступна. Повторите запрос позже.'});
 });
 it.each([
  null,{}, {user:null}, {user:{...valid().user,id:''},policies:{}}, {user:{...valid().user,email:2},policies:{}},
  {user:{...valid().user,principalName:null},policies:{}},{user:{...valid().user,activeRole:''},policies:{}},
  {user:{...valid().user,userRoles:'Главный админ'},policies:{}},{user:{...valid().user,userRoles:[1]},policies:{}},
  {user:{...valid().user,userRoles:['Разработчик']},policies:{}},{user:valid().user},
  {user:valid().user,policies:[]},{user:valid().user,policies:{projects:'read'}},{user:valid().user,policies:{projects:[1]}},
 ])('rejects malformed browser authority %# instead of trusting caller role headers',async data=>{
  client.get.mockResolvedValue({status:200,data});await expect(service().authenticate(req({'x-user-role':'Главный админ'}))).rejects.toMatchObject({status:503});
 });
 it.each(['Basic opaque','Bearer short','bearer '+'a'.repeat(64),'Bearer '+'A'.repeat(64),'Bearer '+'a'.repeat(64)+' extra'])('never falls back to a valid cookie for malformed authorization %s',async authorization=>{
  expect(await service().authenticate(req({authorization,cookie:'bridge_session=valid'}))).toBeNull();expect(client.get).not.toHaveBeenCalled();expect(client.post).not.toHaveBeenCalled();
 });
 it.each([200,201])('checks a device token at the Catalog and accepts identity response %s',async status=>{
  const authorization='Bearer '+'a'.repeat(64);client.post.mockResolvedValue({status,data:{id:'device-1',email:'device@example.test',role:'Разработчик'}});
  expect(await service({CATALOG_SERVICE_URL:'http://catalog.fixture///'}).authenticate(req({authorization,cookie:'never-forward'}))).toEqual({deviceId:'device-1',email:'device@example.test',activeRole:'Разработчик',userId:'device@example.test',principalName:'device@example.test',userRoles:['Разработчик'],policies:{}});
  expect(client.post).toHaveBeenCalledWith('http://catalog.fixture/internal/device-channel/identity',{},{headers:{authorization,'x-neurocenter-internal':'qa-private-internal-token'}});expect(client.get).not.toHaveBeenCalled();
 });
 it.each([401,403])('rejects device revocation %s without a browser authority fallback',async status=>{
  client.post.mockResolvedValue({status});expect(await service().authenticate(req({authorization:'Bearer '+'a'.repeat(64),cookie:'bridge_session=valid'}))).toBeNull();expect(client.get).not.toHaveBeenCalled();
 });
 it.each([302,429,500])('fails closed on device identity status %s',async status=>{
  client.post.mockResolvedValue({status});await expect(service().authenticate(req({authorization:'Bearer '+'a'.repeat(64)}))).rejects.toMatchObject({status:503});
 });
 it.each([null,{}, {id:1,email:'owner@example.test',role:'Главный админ'}, {id:'device',email:'',role:'Главный админ'}, {id:'device',email:'owner@example.test',role:null}])('does not grant a partial or malformed device identity %#',async data=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');client.post.mockResolvedValue({status:200,data});await expect(service().authenticate(req({authorization:'Bearer '+'a'.repeat(64)}))).rejects.toMatchObject({status:503});expect(client.post.mock.calls[0][0]).toBe('http://localhost:4100/internal/device-channel/identity');expect(client.post.mock.calls[0][2].headers['x-neurocenter-internal']).toBe('');
 });
 it.each([new Error('synthetic unavailable'), 'synthetic non-error rejection'])('does not reuse successful authority after an upstream transport failure %#',async failure=>{
  const guard=service();client.get.mockResolvedValueOnce({status:200,data:valid()}).mockRejectedValueOnce(failure);expect(await guard.authenticate(req())).not.toBeNull();await expect(guard.authenticate(req())).rejects.toMatchObject({status:503});
 });
});
