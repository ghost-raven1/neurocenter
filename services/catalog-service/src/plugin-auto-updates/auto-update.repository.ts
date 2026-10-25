import {isDeepStrictEqual} from 'node:util';
import {ConflictException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {IAccessActor} from '../access/access.model';
import type {JobInput} from '../devices/device-job.model';
import {deviceJobRequestHash,findDeviceJobRequest} from '../devices/device-job-requests';
import {securityEvent} from '../access/security-events';
import {pendingAutoUpdate} from './auto-update.validation';
import type {AutoUpdateMutation,AutoUpdateRow,AutoUpdateStatus,AutoUpdateTarget} from './auto-update.types';
const select=`SELECT p.*,j.state AS job_state,j.message AS job_message FROM plugin_auto_update_policies p LEFT JOIN bridge_jobs j ON j.id=p.job_id AND j.email=p.owner_email`;
const tuple=(actor:IAccessActor,input:AutoUpdateTarget)=>[actor.email,input.deviceId,input.projectId,input.bindingId,input.assetId];
const match='p.owner_email=$1 AND p.device_id=$2 AND p.project_id=$3 AND p.binding_id=$4 AND p.asset_id=$5';
export class PluginAutoUpdateRepository {
 constructor(readonly pool:Pool){}
 async read(actor:IAccessActor,input:AutoUpdateTarget):Promise<AutoUpdateRow|null>{return (await this.pool.query<AutoUpdateRow>(select+' WHERE '+match,tuple(actor,input))).rows[0]??null;}
 async save(actor:IAccessActor,input:AutoUpdateMutation,authorize?:(db:PoolClient,previous:AutoUpdateRow|undefined)=>Promise<void>):Promise<AutoUpdateRow>{
  const client=await this.pool.connect(),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  try{
   await client.query('BEGIN');
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['plugin-auto-update:'+JSON.stringify(tuple(actor,input))]);
   const previous=(await client.query<AutoUpdateRow>('SELECT * FROM plugin_auto_update_policies p WHERE '+match+' FOR UPDATE',tuple(actor,input))).rows[0];
   // Re-read the authorizer after waiting for another policy mutation.
   await authorize?.(client,previous);
   if(previous?.mutation_key===input.requestKey){if(previous.mutation_hash!==hash)throw new ConflictException('Ключ уже использован с другим режимом.');const view=(await client.query<AutoUpdateRow>(select+' WHERE p.id=$1',[previous.id])).rows[0];await client.query('COMMIT');return view;}
   if(Number(previous?.revision??0)!==input.expectedRevision)throw new ConflictException('Автообновление уже изменили. Перечитайте состояние; ваш выбор сохранён.');
   let clear=false;
   if(input.enabled&&previous?.pending_input){
    const pending=pendingAutoUpdate(previous),receipt=await findDeviceJobRequest(client,'id,state,message',{email:previous.owner_email,deviceId:previous.device_id,
     requestKey:pending.requestKey,requestHash:deviceJobRequestHash(previous.pending_role!,pending)});
    // FOR UPDATE serialized with enqueue's policy share lock: absence is now a confirmed non-admission.
    clear=!receipt||['succeeded','failed','cancelled'].includes(String(receipt.state));
   }
   const values=[...tuple(actor,input),actor.activeRole,input.enabled,input.requestKey,hash,input.enabled?'waiting':'disabled',input.enabled?'Проверим закреплённую и одобренную версию проекта.':'Будущие обновления выключены. Уже принятое задание остаётся в истории.'];
   const saved=previous?(await client.query<AutoUpdateRow>(`UPDATE plugin_auto_update_policies p SET actor_role=$6,enabled=$7,revision=revision+1,
     mutation_key=$8,mutation_hash=$9,status=$10,message=$11,next_check_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END,
     pending_input=CASE WHEN $12 THEN NULL ELSE pending_input END,pending_role=CASE WHEN $12 THEN NULL ELSE pending_role END,lease_token=NULL,lease_until=NULL WHERE ${match} RETURNING *`,[...values,clear])).rows[0]
    :(await client.query<AutoUpdateRow>(`INSERT INTO plugin_auto_update_policies(id,owner_email,device_id,project_id,binding_id,asset_id,actor_role,enabled,
     mutation_key,mutation_hash,status,message,next_check_at) VALUES($12,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $7 THEN clock_timestamp() ELSE NULL END) RETURNING *`,[...values,randomUUID()])).rows[0];
   await securityEvent(client,{actor:actor.email,action:'plugin.auto-update.policy',resourceId:saved.id,
    before:previous?{enabled:previous.enabled,revision:Number(previous.revision)}:null,after:{enabled:saved.enabled,revision:Number(saved.revision),projectId:saved.project_id,deviceId:saved.device_id,bindingId:saved.binding_id,assetId:saved.asset_id}});
   const view=(await client.query<AutoUpdateRow>(select+' WHERE p.id=$1',[saved.id])).rows[0];
   await client.query('COMMIT');return view;
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 }
 async claim():Promise<AutoUpdateRow[]>{
  return (await this.pool.query<AutoUpdateRow>(`WITH due AS(SELECT id FROM plugin_auto_update_policies WHERE enabled AND next_check_at<=clock_timestamp()
    AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY next_check_at,id LIMIT 10 FOR UPDATE SKIP LOCKED)
    UPDATE plugin_auto_update_policies p SET lease_token=$1,lease_until=clock_timestamp()+interval '2 minutes',next_check_at=clock_timestamp()+interval '2 minutes'
    FROM due WHERE p.id=due.id RETURNING p.*`,[randomUUID()])).rows;
 }
 async prepare(row:AutoUpdateRow,input:JobInput):Promise<AutoUpdateRow|null>{
  return (await this.pool.query<AutoUpdateRow>(`UPDATE plugin_auto_update_policies SET pending_input=$3::jsonb,pending_role=actor_role,job_id=NULL
   WHERE id=$1 AND lease_token=$2 AND enabled AND lease_until>clock_timestamp() AND pending_input IS NULL RETURNING *`,[row.id,row.lease_token,JSON.stringify(input)])).rows[0]??null;
 }
 /** The queue transaction holds this share lock until enqueue commits; disable cannot cross admission. */
 async admit(db:PoolClient,row:AutoUpdateRow,input:JobInput):Promise<void>{
  const current=(await db.query<AutoUpdateRow>('SELECT * FROM plugin_auto_update_policies WHERE id=$1 FOR SHARE',[row.id])).rows[0];
  if(!current?.enabled||current.lease_token!==row.lease_token||Number(current.revision)!==Number(row.revision)
   ||current.pending_role!==row.actor_role||!current.lease_until||Date.parse(String(current.lease_until))<=Date.now()||!isDeepStrictEqual(pendingAutoUpdate(current),input))
   throw new ConflictException('Политика автообновления изменилась до постановки задания.');
 }
 async receipt(row:AutoUpdateRow,input:JobInput):Promise<{id:string;state:string;message:string}|undefined>{
  return await findDeviceJobRequest(this.pool,'id,state,message',{email:row.owner_email,deviceId:row.device_id,requestKey:input.requestKey,
   requestHash:deviceJobRequestHash(row.pending_role!,input)}) as {id:string;state:string;message:string}|undefined;
 }
 async finish(row:AutoUpdateRow,status:AutoUpdateStatus,message:string,seconds:number|null,jobId?:string,clear=false):Promise<void>{
  await this.pool.query(`UPDATE plugin_auto_update_policies SET status=$3,message=$4,checked_at=clock_timestamp(),
   next_check_at=CASE WHEN $5::integer IS NULL THEN NULL ELSE clock_timestamp()+$5*interval '1 second' END,
   job_id=COALESCE($6,job_id),pending_input=CASE WHEN $7 THEN NULL ELSE pending_input END,pending_role=CASE WHEN $7 THEN NULL ELSE pending_role END,lease_token=NULL,lease_until=NULL
   WHERE id=$1 AND lease_token=$2`,[row.id,row.lease_token,status,message,seconds,jobId??null,clear]);
 }
}
