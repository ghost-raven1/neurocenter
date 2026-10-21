import 'reflect-metadata';
import express from 'express';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {vi} from 'vitest';
import type {ConfigService} from '@nestjs/config';
import type {LiveService} from '../src/live/live.service';
import {AuthGuardService} from '../src/auth/auth-guard.service';
import {ProxyService} from '../src/proxy/proxy.service';
import {sourceUploadConnection} from '../src/proxy/source-upload-stream';
import {sourceUploadContentRoute} from '../../shared/source-upload-route.cjs';
import {assetSourceArchiveRoute} from '../../shared/asset-source-archive-route.cjs';
import {snapshotContentRoute} from '../../shared/snapshot-content-route.cjs';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
export const jobId='01234567-89ab-4cde-8f01-23456789abcd',lease='12345678-89ab-4cde-8f01-23456789abcd',chatId='23456789-89ab-4cde-8f01-23456789abcd';
export const browserHeaders={'content-type':'application/json',cookie:'bridge_session=qa-only'};
export const deviceHeaders={'content-type':'application/json',authorization:'Bearer '+'a'.repeat(64)};
const listen=async(server:ReturnType<typeof createServer>)=>{server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Missing fixture port');return 'http://127.0.0.1:'+address.port;};
const close=async(server:ReturnType<typeof createServer>)=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
export const reply=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
const readJson=async(req:IncomingMessage)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);return chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;};
type Call={kind:string;path:string;url:string;method:string;headers:IncomingMessage['headers'];body?:any};
type Handler=(req:IncomingMessage,res:ServerResponse,call:Call)=>Promise<void>|void;

/** Real Proxy/AuthGuard/Axios and local HTTP peers; only service-owned data and live notifications are fixtures. */
export async function proxyHttpFixture(){
 const writes:Array<{path:string;status:number;destroyed:boolean}>=[];
 const calls:Call[]=[],live={mutation:vi.fn(),bridge:vi.fn(),sections:vi.fn()};
 const state={authStatus:200,authRole:'Главный админ',authEmail:'owner@example.test',authDelay:undefined as Promise<void>|undefined,
  accessStatus:200,allowed:true,accessDelay:undefined as Promise<void>|undefined,
  flags:defaultFeatureFlags(),flagsStatus:200,flagsPayload:undefined as unknown,flagsDelay:undefined as Promise<void>|undefined,flagsRedirect:undefined as string|undefined,
  deviceStatus:200,device:{id:'device-qa',email:'owner@example.test',role:'Главный админ'},
  jobStatus:200,job:{projectId:'prj-qa',role:'Админ проекта',snapshotId:jobId,snapshotProtocol:'project-snapshots-v1'},
  businessStatus:200,businessPayload:undefined as unknown,businessHeaders:{} as Record<string,string>,handler:undefined as Handler|undefined,
  claims:{email:'owner@example.test',userRoles:['Главный админ'],projects:[{projectId:'prj-qa',projectName:'QA',role:'Разработчик'}],pluginIds:[],skillPaths:['common/allowed']},
 };
 const upstream=createServer(async(req,res)=>{
  const parsed=new URL(req.url||'','http://fixture'),parts=parsed.pathname.split('/'),kind=parts[1],route='/'+parts.slice(2).join('/');
  const call:Call={kind,path:route,url:parsed.pathname+parsed.search,method:req.method||'GET',headers:{...req.headers}};calls.push(call);
  try{
   if(kind==='auth'&&route==='/auth/me'){
    if(state.authDelay)await state.authDelay;
    reply(res,state.authStatus,{user:{id:'user-qa',email:state.authEmail,principalName:'qa-owner',activeRole:state.authRole,userRoles:[state.authRole]},policies:{projects:['read']}});return;
   }
   if(route.startsWith('/internal/')&&req.headers['x-neurocenter-internal']!=='qa-proxy-internal'){reply(res,403,{message:'Private fixture token required.'});return;}
   if(route==='/internal/feature-flags/evaluated'){if(state.flagsDelay)await state.flagsDelay;if(state.flagsRedirect){res.writeHead(302,{location:state.flagsRedirect});res.end();return;}reply(res,state.flagsStatus,state.flagsPayload??evaluateFeatureFlags(state.flags));return;}
   const raw=sourceUploadContentRoute(call.method,route)||snapshotContentRoute(call.method,route)||assetSourceArchiveRoute(call.method,route);
   if(!raw)call.body=await readJson(req);
   if(route==='/internal/access/authorize'){if(state.accessDelay)await state.accessDelay;reply(res,state.accessStatus,{allowed:state.allowed,claims:state.claims});return;}
   if(route==='/internal/device-channel/identity'){if(state.authDelay)await state.authDelay;reply(res,state.deviceStatus,state.device);return;}
   if(/^\/internal\/device-channel\/jobs\/[^/]+\/authorize$/.test(route)){reply(res,state.jobStatus,state.job);return;}
   if(state.handler){await state.handler(req,res,call);return;}
   for(const[key,value]of Object.entries(state.businessHeaders))res.setHeader(key,value);
   if(raw){let bytes=0;for await(const chunk of req)bytes+=chunk.length;reply(res,state.businessStatus,{ok:true,bytes});return;}
   reply(res,state.businessStatus,state.businessPayload===undefined?{kind,path:route,body:call.body,query:parsed.search}:state.businessPayload);
  }catch{if(!res.headersSent)reply(res,503,{message:'Synthetic service unavailable.'});else res.destroy();}
 });
 const origin=await listen(upstream),values={AUTH_SERVICE_URL:origin+'/auth/',CATALOG_SERVICE_URL:origin+'/catalog///',SKILLS_SERVICE_URL:origin+'/skills/',RAG_SERVICE_URL:origin+'/rag/',FEATURE_FLAGS_SERVICE_URL:origin+'/flags/'};
 const config={get:(key:string)=>values[key as keyof typeof values]} as ConfigService;
 const auth=new AuthGuardService(config),proxy=new ProxyService(config,auth,live as unknown as LiveService);
 const active=new Set<Promise<unknown>>();
 const app=express(),json=express.json({limit:'50mb'});app.use(sourceUploadConnection);app.use((req,res,next)=>sourceUploadContentRoute(req.method,req.path)||snapshotContentRoute(req.method,req.path)||assetSourceArchiveRoute(req.method,req.path)?next():json(req,res,next));
 app.use((req,res)=>{const status=res.status.bind(res);res.status=(code:number)=>{writes.push({path:req.path,status:code,destroyed:res.destroyed});return status(code);};const pending=proxy.forward(req,res).catch(()=>{if(!res.headersSent)res.status(503).json({message:'Synthetic outer error boundary.'});else res.destroy();}).finally(()=>active.delete(pending));active.add(pending);});
 const gateway=createServer(app),url=await listen(gateway);
 return {state,calls,writes,live,proxy,url,origin,
  idle:async()=>{await Promise.allSettled([...active]);},
  business:()=>calls.filter(call=>!call.path.startsWith('/internal/')&&call.kind!=='auth'),
  async send(route:string,options:{method?:string;body?:unknown;headers?:Record<string,string>;signal?:AbortSignal}={}){
   const response=await fetch(url+route,{method:options.method||'GET',headers:{...browserHeaders,...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:options.signal});
   const text=await response.text();let body:unknown;try{body=text?JSON.parse(text):null;}catch{body=text;}return {status:response.status,headers:response.headers,body};
  },
  async close(){await close(gateway);await close(upstream);},
 };
}
