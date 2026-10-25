import {Injectable,ServiceUnavailableException} from '@nestjs/common';
import axios,{type AxiosInstance} from 'axios';
import type {SessionCreate,SessionIdentity,StoredSession} from './catalog-session.types';

function exact(value:unknown,keys:string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}
function text(value:unknown,max:number):value is string{return typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);}
function identity(value:unknown):value is SessionIdentity{
 return exact(value,['id','principalName','email','displayName'])&&text(value.id,512)&&text(value.principalName,512)
  &&text(value.email,320)&&/^[^\s@]+@[^\s@]+$/.test(value.email)&&text(value.displayName,512)&&Buffer.byteLength(JSON.stringify(value))<=8192;
}
const unavailable=()=>new ServiceUnavailableException('Хранилище сессий временно недоступно. Повторите запрос позже.');

/** A missing row is an explicit200 envelope;404/transport/protocol errors remain503, never logout. */
@Injectable()
export class CatalogSessionClient {
 private readonly http:AxiosInstance=axios.create({timeout:5000,maxRedirects:0,maxContentLength:16384,maxBodyLength:16384,validateStatus:()=>true});
 private readonly url=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/+$/,'')+'/internal/browser-auth-sessions';
 private async request(method:'get'|'post'|'patch'|'delete',path:string,data?:unknown):Promise<unknown>{
  try{
   const response=await this.http.request({method,url:this.url+path,...(data===undefined?{}:{data}),headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''}});
   if(response.status!==200&&!(method==='post'&&response.status===201))throw unavailable();
   return response.data;
  }catch{throw unavailable();}
 }
 async create(input:SessionCreate):Promise<void>{
  const value=await this.request('post','',input);if(!exact(value,['created'])||value.created!==true)throw unavailable();
 }
 async find(hash:string):Promise<StoredSession|null>{
  const value=await this.request('get','/'+hash);
  if(exact(value,['found'])&&value.found===false)return null;
  if(!exact(value,['found','session'])||value.found!==true||!exact(value.session,['identity','selectedRole','expiresAt']))throw unavailable();
  const session=value.session;
  if(!identity(session.identity)||!text(session.selectedRole,128)||typeof session.expiresAt!=='string'
   ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(session.expiresAt)||(!Number.isFinite(Date.parse(session.expiresAt))||new Date(session.expiresAt).toISOString()!==session.expiresAt))throw unavailable();
  return {identity:session.identity,selectedRole:session.selectedRole,expiresAt:session.expiresAt};
 }
 async selectRole(hash:string,selectedRole:string):Promise<boolean>{
  const value=await this.request('patch','/'+hash+'/selected-role',{selectedRole});
  if(!exact(value,['found'])||typeof value.found!=='boolean')throw unavailable();return value.found;
 }
 async revoke(hash:string):Promise<void>{
  const value=await this.request('delete','/'+hash);if(!exact(value,['revoked'])||value.revoked!==true)throw unavailable();
 }
}
