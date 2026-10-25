import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {BadRequestException,ForbiddenException} from '@nestjs/common';
import type {Pool} from 'pg';
import {BrowserAuthSessionController} from '../src/browser-auth-sessions/browser-auth-session.controller';
import {BrowserAuthSessionRepository} from '../src/browser-auth-sessions/browser-auth-session.repository';

const token='synthetic-session-internal',hash='a'.repeat(64);
const input=()=>({tokenHash:hash,identity:{id:'qa',principalName:'qa@example.test',email:'qa@example.test',displayName:'QA'},selectedRole:'Разработчик',ttlSeconds:60});
function fixture(){
 const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[],rowCount:1})),repository=new BrowserAuthSessionRepository({query}as unknown as Pool),controller=new BrowserAuthSessionController(repository);
 return {query,repository,controller};
}
const invoke=(controller:BrowserAuthSessionController,operation:string,internal:unknown)=>operation==='create'?controller.create(internal,input()):operation==='find'?controller.find(internal,hash):operation==='selectRole'?controller.selectRole(internal,hash,{selectedRole:'Наблюдатель'}):controller.revoke(internal,hash);
beforeEach(()=>vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token));afterEach(()=>vi.unstubAllEnvs());

describe('Catalog browser session internal owner',()=>{
 for(const operation of ['create','find','selectRole','revoke']){
  it.each([undefined,'wrong-token',{cookie:'bridge_session=synthetic'}])('denies '+operation+' without the exact internal credential before storage',internal=>{
   const f=fixture();expect(()=>invoke(f.controller,operation,internal)).toThrow(ForbiddenException);expect(f.query).not.toHaveBeenCalled();
  });
  it('does not expose private storage errors through '+operation,async()=>{
   const f=fixture();f.query.mockRejectedValueOnce(new Error('postgresql://private-credential'));
   await expect(invoke(f.controller,operation,token)).rejects.toMatchObject({status:503,message:expect.not.stringContaining('private-credential')});
  });
 }
 it('denies every route while the internal credential is unconfigured',()=>{
  vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');const f=fixture();for(const operation of ['create','find','selectRole','revoke'])expect(()=>invoke(f.controller,operation,token)).toThrow(ForbiddenException);expect(f.query).not.toHaveBeenCalled();
 });
 it('does not acknowledge creation when the database did not insert a row',async()=>{
  const f=fixture();f.query.mockResolvedValueOnce({rows:[],rowCount:0});await expect(f.controller.create(token,input())).rejects.toHaveProperty('status',503);
 });
 it('distinguishes a missing session from storage failure with a typed200 envelope',async()=>{
  const f=fixture();expect(await f.controller.find(token,hash)).toEqual({found:false});
  expect(await f.controller.selectRole(token,hash,{selectedRole:'Наблюдатель'})).toEqual({found:true});
  expect(await f.controller.revoke(token,hash)).toEqual({revoked:true});
 });
 it('accepts the bounded identity without sending grants, credentials or the raw cookie into SQL',async()=>{
  const f=fixture();expect(await f.controller.create(token,input())).toEqual({created:true});
  expect(f.query.mock.calls[0][1]).toEqual([hash,JSON.stringify(input().identity),'Разработчик',60]);
 });
 it.each([null,{}, {...input(),cookie:'raw-cookie'}, {...input(),tokenHash:'A'.repeat(64)}, {...input(),tokenHash:'a'.repeat(63)},
  {...input(),identity:{...input().identity,userRoles:['Главный админ']}}, {...input(),identity:{...input().identity,access_token:'private'}},
  {...input(),identity:{...input().identity,id:''}}, {...input(),identity:{...input().identity,email:'invalid'}},
  {...input(),identity:{...input().identity,displayName:'x'.repeat(513)}}, {...input(),selectedRole:'role\n'},
  ...[59,86401,1.5,'60',null].map(ttlSeconds=>({...input(),ttlSeconds}))])('rejects malformed or widened creation before SQL',value=>{
  const f=fixture();expect(()=>f.controller.create(token,value)).toThrow(BadRequestException);expect(f.query).not.toHaveBeenCalled();
 });
 it.each(['',undefined,'a'.repeat(63),'A'.repeat(64),hash+'/other'])('rejects a malformed hash on every existing-session route',value=>{
  const f=fixture();for(const call of [()=>f.controller.find(token,value),()=>f.controller.selectRole(token,value,{selectedRole:'Наблюдатель'}),()=>f.controller.revoke(token,value)])expect(call).toThrow(BadRequestException);
  expect(f.query).not.toHaveBeenCalled();
 });
 it.each([{},null,{selectedRole:''},{selectedRole:'Наблюдатель',ttlSeconds:86400},{selectedRole:'x'.repeat(129)}])('rejects invalid preference changes without storage writes',value=>{
  const f=fixture();expect(()=>f.controller.selectRole(token,hash,value)).toThrow(BadRequestException);expect(f.query).not.toHaveBeenCalled();
 });
});
