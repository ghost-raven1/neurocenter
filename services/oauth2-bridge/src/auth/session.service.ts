import {Injectable} from '@nestjs/common';
import {createHash,randomBytes} from 'node:crypto';
import type {IBridgeUser} from './interface';
import {CatalogSessionClient} from './catalog-session.client';

const hash=(token:unknown):string|null=>typeof token==='string'&&/^[a-f0-9]{48}$/.test(token)?createHash('sha256').update(token).digest('hex'):null;

/** Catalog owns the absolute session lifetime; this service retains no identity or grant cache. */
@Injectable()
export class SessionService {
 readonly ttlMs:number;
 constructor(private readonly store:CatalogSessionClient){
  const seconds=Number(process.env.SESSION_TTL_SECONDS||28800);
  if(!Number.isSafeInteger(seconds)||seconds<60||seconds>86400)throw new Error('SESSION_TTL_SECONDS должен быть от 60 до 86400.');
  this.ttlMs=seconds*1000;
 }
 async create(user:IBridgeUser):Promise<string>{
  const token=randomBytes(24).toString('hex');
  await this.store.create({tokenHash:hash(token)!,identity:{id:user.id,principalName:user.principalName,email:user.email,displayName:user.displayName},selectedRole:user.activeRole,ttlSeconds:this.ttlMs/1000});
  return token;
 }
 async get(token:unknown):Promise<IBridgeUser|null>{
  const key=hash(token);if(!key)return null;
  const session=await this.store.find(key);if(!session||Date.parse(session.expiresAt)<=Date.now())return null;
  return {...session.identity,activeRole:session.selectedRole,userRoles:[],projectRoles:[],routePermissions:[]};
 }
 /** Called only after fresh grants accepted the explicit role; a late write cannot revive a session. */
 async selectRole(token:unknown,role:string):Promise<boolean>{const key=hash(token);return key?this.store.selectRole(key,role):false;}
 async remove(token:unknown):Promise<void>{const key=hash(token);if(key)await this.store.revoke(key);}
}
