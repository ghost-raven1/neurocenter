import {vi} from 'vitest';
import axios,{type AxiosRequestConfig,type AxiosInstance} from 'axios';
import type {Request,Response} from 'express';
import type {IBridgeUser} from '../src/auth/interface';
import type {SessionCreate} from '../src/auth/catalog-session.types';
import type {AuthService} from '../src/auth/auth.service';
import {CatalogSessionClient} from '../src/auth/catalog-session.client';
import {SessionService} from '../src/auth/session.service';
import {AuthController} from '../src/auth/auth.controller';
import {OAuthTransactions} from '../src/auth/oauth-transactions.service';

export const sessionUser=():IBridgeUser=>({id:'qa',email:'qa@example.test',principalName:'qa@example.test',displayName:'QA',userRoles:['Разработчик'],activeRole:'Разработчик',routePermissions:['projects'],projectRoles:[]});
export function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

/** A controlled Catalog HTTP/storage port shared by independent real session clients, never production persistence. */
export function catalogSessionPort(){
 const rows=new Map<string,{input:SessionCreate;expiresAt:number;revoked:boolean}>();
 const gates:Array<{method:string;entered:ReturnType<typeof deferred<AxiosRequestConfig>>;release:ReturnType<typeof deferred<void>>}>=[];
 const request=vi.fn(async(config:AxiosRequestConfig)=>{
  const index=gates.findIndex(gate=>gate.method===config.method),gate=index<0?undefined:gates.splice(index,1)[0];
  if(gate){gate.entered.resolve(config);await gate.release.promise;}
  const path=new URL(config.url!).pathname.replace('/internal/browser-auth-sessions',''),hash=path.split('/')[1];
  if(config.method==='post'&&path===''){
   const input=structuredClone(config.data)as SessionCreate;if(rows.has(input.tokenHash))return {status:409,data:{}};
   rows.set(input.tokenHash,{input,expiresAt:Date.now()+input.ttlSeconds*1000,revoked:false});return {status:201,data:{created:true}};
  }
  const row=rows.get(hash),live=row&&!row.revoked&&row.expiresAt>Date.now();
  if(config.method==='get')return {status:200,data:live&&row?{found:true,session:{identity:structuredClone(row.input.identity),selectedRole:row.input.selectedRole,expiresAt:new Date(row.expiresAt).toISOString()}}:{found:false}};
  if(config.method==='patch'){if(live&&row)row.input.selectedRole=config.data.selectedRole;return {status:200,data:{found:!!live}};}
  if(config.method==='delete'){if(row)row.revoked=true;return {status:200,data:{revoked:true}};}
  return {status:404,data:{}};
 });
 return {request,client(){vi.spyOn(axios,'create').mockReturnValue({request}as unknown as AxiosInstance);return new CatalogSessionClient();},
  holdNext(method:string){const gate={method,entered:deferred<AxiosRequestConfig>(),release:deferred<void>()};gates.push(gate);return {entered:gate.entered.promise,resolve:()=>gate.release.resolve(),reject:gate.release.reject};}};
}

/** Existing controller fixture with the Catalog boundary controlled and grants refreshed into a new request user. */
export function authControllerFixture(disabled=false,panelUrl='https://panel.example',store=catalogSessionPort()){
 const user=sessionUser(),auth={ssoDisabled:disabled,panelUrl,mockUser:vi.fn(async()=>user),
  authorizeUrl:vi.fn((state:string,challenge:string)=>'https://idp.example/authorize?state='+state+'&challenge='+challenge),
  exchangeCode:vi.fn(async()=>user),refreshAccess:vi.fn(async(value:IBridgeUser)=>Object.assign(value,{userRoles:[...user.userRoles],projectRoles:[...user.projectRoles],routePermissions:[...user.routePermissions]})),policies:vi.fn(()=>({allowed:['projects']})),
  logoutUrl:vi.fn(()=> 'https://idp.example/logout'),applyRole:vi.fn((value:IBridgeUser,role:string)=>{value.activeRole=role;return value;})};
 const sessions=new SessionService(store.client()),transactions=new OAuthTransactions(),controller=new AuthController(auth as unknown as AuthService,sessions,transactions);
 const response={cookie:vi.fn(),redirect:vi.fn(),clearCookie:vi.fn(),status:vi.fn(),json:vi.fn()};response.status.mockReturnValue(response);
 const res=response as unknown as Response,req=(value:Record<string,unknown>={})=>({query:{},...value})as Request;
 return {auth,user,sessions,transactions,controller,response,res,req,store};
}
