import {ServiceUnavailableException} from '@nestjs/common';
import type {Pool} from 'pg';
import type {BrowserSessionIdentity,BrowserSessionLookup,CreateBrowserSession} from './browser-auth-session.types';

/** Uses the existing Catalog pool; each mutation is one committed statement, never an upsert. */
export class BrowserAuthSessionRepository {
 constructor(readonly db:Pick<Pool,'query'>){}
 private async available<T>(operation:()=>Promise<T>):Promise<T>{
  try{return await operation();}catch{throw new ServiceUnavailableException('Хранилище сессий временно недоступно.');}
 }
 async create(input:CreateBrowserSession):Promise<{created:true}>{
  return this.available(async()=>{
   const created=await this.db.query(`INSERT INTO browser_auth_sessions(token_hash,identity,selected_role,created_at,expires_at)
    VALUES($1,$2::jsonb,$3,statement_timestamp(),statement_timestamp()+$4*interval '1 second')`,
   [input.tokenHash,JSON.stringify(input.identity),input.selectedRole,input.ttlSeconds]);
   if(created.rowCount!==1)throw new Error('Session creation was not confirmed');
   return {created:true};
  });
 }
 async find(hash:string):Promise<BrowserSessionLookup>{
  return this.available(async()=>{
   const row=(await this.db.query<{identity:BrowserSessionIdentity;selected_role:string;expires_at:Date}>(`SELECT identity,selected_role,expires_at FROM browser_auth_sessions
    WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[hash])).rows[0];
   return row?{found:true,session:{identity:row.identity,selectedRole:row.selected_role,expiresAt:row.expires_at.toISOString()}}:{found:false};
  });
 }
 async selectRole(hash:string,role:string):Promise<{found:boolean}>{
  // Materialize the locked row before checking wall-clock expiry, including an unchanged preference.
  return this.available(async()=>({found:!!(await this.db.query(`WITH locked AS MATERIALIZED (
    SELECT token_hash,revoked_at,expires_at FROM browser_auth_sessions WHERE token_hash=$1 FOR UPDATE
   ) UPDATE browser_auth_sessions s SET selected_role=$2 FROM locked
   WHERE s.token_hash=locked.token_hash AND locked.revoked_at IS NULL AND locked.expires_at>clock_timestamp() RETURNING s.token_hash`,[hash,role])).rowCount}));
 }
 async revoke(hash:string):Promise<{revoked:true}>{
  return this.available(async()=>{
   await this.db.query('UPDATE browser_auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE token_hash=$1',[hash]);
   return {revoked:true};
  });
 }
}
