import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {authControllerFixture as fixture} from './auth-session.fixture';

beforeEach(()=>vi.stubEnv('SESSION_TTL_SECONDS','60'));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
function create(mode:'dev'|'callback'){
 const f=fixture(mode==='dev'),gate=f.store.holdNext('post');
 const transaction=mode==='callback'?f.transactions.create('/store'):null;
 const req=transaction?f.req({query:{state:transaction.state,code:'code'},cookies:{oauth_state:transaction.state}}):f.req();
 const pending=transaction?f.controller.callback(req,f.res):f.controller.login(req,f.res);
 return {f,gate,pending,transaction};
}
const request=(f:ReturnType<typeof fixture>,token:string)=>f.req({cookies:{bridge_session:token}});

/** Commit barriers exercise the real controller, async session service and Catalog HTTP client. */
describe('Browser session acknowledgement boundaries',()=>{
 it.each(['dev','callback']as const)('%s login cannot issue the cookie or redirect before the store accepts creation',async mode=>{
  const {f,gate,pending}=create(mode);await gate.entered;
  expect(f.response.cookie).not.toHaveBeenCalled();expect(f.response.redirect).not.toHaveBeenCalled();
  expect(f.response.clearCookie.mock.calls.map(row=>row[0])).toEqual(mode==='callback'?['oauth_state','oauth_return']:[]);
  gate.resolve();await pending;expect(f.response.cookie).toHaveBeenCalledWith('bridge_session',expect.stringMatching(/^[a-f0-9]{48}$/),expect.any(Object));
  expect(f.response.redirect).toHaveBeenCalledWith(mode==='callback'?'https://panel.example/store':'https://panel.example/');
 });
 it.each(['dev','callback']as const)('%s rejected create Promise stays503 without a cookie, exchange-error redirect or private diagnostic',async mode=>{
  const diagnostic=vi.spyOn(console,'error').mockImplementation(()=>undefined),{f,gate,pending,transaction}=create(mode);await gate.entered;
  const rejected=expect(pending).rejects.toHaveProperty('status',503);gate.reject(new Error('private database credential'));await rejected;
  expect(f.response.cookie).not.toHaveBeenCalled();expect(f.response.redirect).not.toHaveBeenCalled();expect(diagnostic).not.toHaveBeenCalled();
  if(transaction)expect(f.transactions.consume(transaction.state,transaction.state)).toBeNull();
 });
 it('holds identity and grant lookup until a pending read commits',async()=>{
  const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('get'),pending=f.controller.me(request(f,token),f.res);await gate.entered;
  expect(f.response.json).not.toHaveBeenCalled();expect(f.auth.refreshAccess).not.toHaveBeenCalled();gate.resolve();await pending;
  expect(f.response.status).toHaveBeenCalledWith(200);expect(f.response.json).toHaveBeenCalledWith({user:f.user,policies:{allowed:['projects']}});
 });
 it('a rejected read Promise preserves the cookie and returns no identity or stale grants',async()=>{
  const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('get'),pending=f.controller.me(request(f,token),f.res);await gate.entered;
  const rejected=expect(pending).rejects.toHaveProperty('status',503);gate.reject(new Error('private unavailable'));await rejected;
  expect(f.response.json).not.toHaveBeenCalled();expect(f.response.clearCookie).not.toHaveBeenCalled();expect(f.auth.refreshAccess).not.toHaveBeenCalled();
  await f.controller.me(request(f,token),f.res);expect(f.response.status).toHaveBeenCalledWith(200);
 });
 it.each(['logout','logoutJson']as const)('%s does not clear or acknowledge the cookie until revoke commits',async method=>{
  const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('delete'),pending=f.controller[method](request(f,token),f.res);await gate.entered;
  expect(f.response.clearCookie).not.toHaveBeenCalled();expect(f.response.redirect).not.toHaveBeenCalled();expect(f.response.json).not.toHaveBeenCalled();
  gate.resolve();await pending;expect(f.response.clearCookie).toHaveBeenCalledWith('bridge_session');
  if(method==='logout')expect(f.response.redirect).toHaveBeenCalledWith('https://panel.example/');else expect(f.response.json).toHaveBeenCalledWith({});
  await f.controller.me(request(f,token),f.res);expect(f.response.status).toHaveBeenLastCalledWith(401);
 });
 it.each(['logout','logoutJson']as const)('%s rejected revoke Promise leaves the same cookie usable without a false logout ACK',async method=>{
  const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('delete'),pending=f.controller[method](request(f,token),f.res);await gate.entered;
  const rejected=expect(pending).rejects.toHaveProperty('status',503);gate.reject(new Error('private revoke failure'));await rejected;
  expect(f.response.clearCookie).not.toHaveBeenCalled();expect(f.response.redirect).not.toHaveBeenCalled();expect(f.response.json).not.toHaveBeenCalled();
  await f.controller.me(request(f,token),f.res);expect(f.response.status).toHaveBeenCalledWith(200);
 });
 it('returns a role choice only after fresh grants and the preference commit',async()=>{
  const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('patch'),pending=f.controller.switchRole(request(f,token),f.res,{role:'Разработчик'});await gate.entered;
  expect(f.auth.refreshAccess).toHaveBeenCalledOnce();expect(f.auth.applyRole).toHaveBeenCalledOnce();expect(f.response.json).not.toHaveBeenCalled();
  gate.resolve();await pending;expect(f.response.status).toHaveBeenCalledWith(200);
 });
 it('a rejected preference Promise gives503 and no successful identity response',async()=>{
  const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('patch'),pending=f.controller.switchRole(request(f,token),f.res,{role:'Разработчик'});await gate.entered;
  const rejected=expect(pending).rejects.toHaveProperty('status',503);gate.reject(new Error('private preference failure'));await rejected;
  expect(f.response.json).not.toHaveBeenCalled();expect(f.response.clearCookie).not.toHaveBeenCalled();
 });
 it('a late preference update cannot resurrect a session revoked after fresh grant validation',async()=>{
  const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('patch'),pending=f.controller.switchRole(request(f,token),f.res,{role:'Разработчик'});await gate.entered;
  await f.sessions.remove(token);gate.resolve();await pending;
  expect(f.response.status).toHaveBeenCalledWith(401);expect(f.response.json).toHaveBeenCalledWith({message:'Unauthorized'});
  expect(await f.sessions.get(token)).toBeNull();
 });
 it('an expired session cannot receive a late preference ACK',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);
  try{
   const f=fixture(true),token=await f.sessions.create(f.user),gate=f.store.holdNext('patch'),pending=f.controller.switchRole(request(f,token),f.res,{role:'Разработчик'});await gate.entered;
   vi.setSystemTime(60000);gate.resolve();await pending;expect(f.response.status).toHaveBeenCalledWith(401);expect(f.response.json).toHaveBeenCalledWith({message:'Unauthorized'});
  }finally{vi.useRealTimers();}
 });
 it('a newly forbidden role never reaches preference storage',async()=>{
  const f=fixture(true),token=await f.sessions.create(f.user);f.auth.applyRole.mockImplementation(()=>{throw new ForbiddenException('Role revoked');});f.store.request.mockClear();
  await expect(f.controller.switchRole(request(f,token),f.res,{role:'Главный админ'})).rejects.toHaveProperty('status',403);
  expect(f.store.request.mock.calls.map(([config])=>config.method)).toEqual(['get']);expect(f.response.json).not.toHaveBeenCalled();
 });
});
