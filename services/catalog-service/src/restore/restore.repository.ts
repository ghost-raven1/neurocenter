import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ConflictException,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {digest,previewResult,restoreReceipt,restoreFailureMessages,type RestorePreviewInput,type RestoreInput,type RestoreRunnerReport} from '../../../shared/web-restore.cjs';
import {securityEvent} from '../access/security-events';
import type {RestoreJob,RestoreRunner} from './restore.types';

const leaseSeconds=45;
const conflict=()=>new ConflictException('Проверка или назначение изменились. Выполните новую проверку перед восстановлением.');
/** Все переходы и requestKey переживают HTTP retry и перезапуск каталога; executor работает отдельно. */
export class RestoreRepository {
 constructor(readonly pool:Pool){}
 private async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(53709189)');const result=await action(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 }
 private async expire(client:PoolClient){
  const expired=(await client.query<RestoreJob>(`UPDATE web_restore_jobs SET state='interrupted',error_code='RUNNER_LOST',message='Связь с исполнителем потеряна. Результат неизвестен; повторная запись автоматически не запускается.',updated_at=now()
   WHERE state='running' AND lease_until<now() RETURNING *`)).rows;
  for(const row of expired)await securityEvent(client,{actor:'system:restore',action:'maintenance.restore.interrupted',resourceId:row.id,before:{state:'running'},after:{state:'interrupted'}});
 }
 private async runner(client:Pool|PoolClient,runnerId?:string){
  const row=(await client.query<RestoreRunner>('SELECT * FROM web_restore_runner WHERE singleton AND seen_at>now()-interval \'45 seconds\'')).rows[0];
  if(!row||runnerId&&row.runner_id!==runnerId)throw new ServiceUnavailableException('Исполнитель восстановления не подключён. Запрос не запускается.');return row;
 }
 private checkpoint(runner:RestoreRunner,input:RestorePreviewInput){
  if(!input.targetProject.startsWith(runner.target_prefix+'-')||!runner.checkpoints.some(item=>item.id===input.checkpointId&&item.sha256===input.checkpointSha256))throw conflict();
 }
 async report(input:RestoreRunnerReport){
  return this.transaction(async client=>{
   const current=(await client.query<RestoreRunner>('SELECT * FROM web_restore_runner WHERE singleton FOR UPDATE')).rows[0];
   if(current&&current.runner_id!==input.runnerId&&Date.now()-new Date(current.seen_at).getTime()<leaseSeconds*1000)throw new ConflictException('Другой исполнитель восстановления ещё на связи.');
   await client.query(`INSERT INTO web_restore_runner(singleton,runner_id,config_digest,target_prefix,checkpoints) VALUES(true,$1,$2,$3,$4)
    ON CONFLICT(singleton) DO UPDATE SET runner_id=$1,config_digest=$2,target_prefix=$3,checkpoints=$4,seen_at=now()`,[input.runnerId,input.configDigest,input.targetPrefix,JSON.stringify(input.checkpoints)]);
   return {ok:true};
  });
 }
 async status(actor:string){
  await this.transaction(client=>this.expire(client));
  const runner=(await this.pool.query<RestoreRunner>('SELECT * FROM web_restore_runner WHERE singleton')).rows[0];
  const available=!!runner&&Date.now()-new Date(runner.seen_at).getTime()<leaseSeconds*1000;
  const jobs=(await this.pool.query<RestoreJob>('SELECT * FROM web_restore_jobs WHERE actor=$1 ORDER BY created_at DESC LIMIT 20',[actor])).rows;
  return {runner:{available,targetPrefix:runner?.target_prefix,lastSeenAt:runner?.seen_at},checkpoints:available?runner.checkpoints:[],jobs};
 }
 async get(actor:string,key:string,byRequest=false){
  await this.transaction(client=>this.expire(client));
  const row=(await this.pool.query<RestoreJob>(`SELECT * FROM web_restore_jobs WHERE actor=$1 AND ${byRequest?'request_key':'id'}=$2`,[actor,key])).rows[0];
  if(!row)throw new NotFoundException('Запрос восстановления не найден.');return row;
 }
 async create(actor:string,kind:'preview'|'restore',input:RestorePreviewInput|RestoreInput){
  return this.transaction(async client=>{
   const inputHash=digest({kind,input});
   const existing=(await client.query<RestoreJob>('SELECT * FROM web_restore_jobs WHERE actor=$1 AND request_key=$2',[actor,input.requestKey])).rows[0];
   if(existing){if(existing.input_hash!==inputHash)throw new ConflictException('Этот ключ запроса уже принадлежит другому подтверждению.');return existing;}
   if((await client.query('SELECT 1 FROM web_restore_cancelled_requests WHERE actor=$1 AND request_key=$2',[actor,input.requestKey])).rowCount)throw new ConflictException('Этот сохранённый запрос отменён до запуска. Запоздалый POST не выполняется.');
   const runner=await this.runner(client);let previewId:string|undefined,preview:RestoreJob['preview']=null;
   if(kind==='preview')this.checkpoint(runner,input as RestorePreviewInput);
   else{
    const request=input as RestoreInput;
    const prior=(await client.query<RestoreJob>('SELECT * FROM web_restore_jobs WHERE actor=$1 AND id=$2 FOR UPDATE',[actor,request.previewId])).rows[0];
    if(!prior||prior.kind!=='preview'||prior.state!=='ready'||!prior.preview)throw conflict();
    preview=previewResult(prior.preview);
    if(preview.digest!==request.digest||Date.parse(preview.expiresAt)<=Date.now()||preview.configDigest!==runner.config_digest||request.confirmation!=='RESTORE '+preview.targetProject)throw conflict();
    this.checkpoint(runner,{...preview,requestKey:request.requestKey});previewId=prior.id;
    if((await client.query('SELECT 1 FROM web_restore_jobs WHERE preview_id=$1',[previewId])).rowCount)throw new ConflictException('Эта проверка уже подтверждена. Откройте существующий запрос восстановления.');
   }
   const row=(await client.query<RestoreJob>(`INSERT INTO web_restore_jobs(id,actor,request_key,kind,input,input_hash,preview_id,state,preview,message)
    VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9) RETURNING *`,[randomUUID(),actor,input.requestKey,kind,JSON.stringify(input),inputHash,previewId??null,preview?JSON.stringify(preview):null,kind==='preview'?'Ожидаем проверку копии и назначения.':'Подтверждение сохранено. Ожидаем исполнителя.'])).rows[0];
   await securityEvent(client,{actor,action:'maintenance.restore.'+(kind==='preview'?'check.requested':'requested'),resourceId:row.id,before:null,after:{kind,input:preview?{requestKey:input.requestKey,checkpointId:preview.checkpointId,checkpointSha256:preview.checkpointSha256,targetProject:preview.targetProject,digest:preview.digest}:input}});return row;
  });
 }
 async cancel(actor:string,id:string){
  return this.transaction(async client=>{
   const row=(await client.query<RestoreJob>(`UPDATE web_restore_jobs SET state='cancelled',updated_at=now(),message='Запрос отменён до запуска.' WHERE actor=$1 AND id=$2 AND state='queued' RETURNING *`,[actor,id])).rows[0];
   if(!row)throw new ConflictException('Запрос уже запущен или завершён. Прерывание записи через веб не выполняется.');
   await securityEvent(client,{actor,action:'maintenance.restore.cancelled',resourceId:id,before:{state:'queued'},after:{state:'cancelled'}});return row;
  });
 }
 /** Tombstone закрывает неизвестный POST: GET404 сам по себе не доказывает, что late request уже невозможен. */
 async cancelRequest(actor:string,key:string){
  return this.transaction(async client=>{
   let job=(await client.query<RestoreJob>('SELECT * FROM web_restore_jobs WHERE actor=$1 AND request_key=$2 FOR UPDATE',[actor,key])).rows[0];
   if(job?.state==='running'||job?.state==='interrupted')throw new ConflictException('Запрос выполняется или его результат неизвестен. Проверьте существующий запуск перед новой попыткой.');
   const inserted=await client.query('INSERT INTO web_restore_cancelled_requests(actor,request_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING request_key',[actor,key]);
   if(job?.state==='queued')job=(await client.query<RestoreJob>("UPDATE web_restore_jobs SET state='cancelled',message='Запрос отменён до запуска.',updated_at=now() WHERE id=$1 RETURNING *",[job.id])).rows[0];
   if(inserted.rowCount)await securityEvent(client,{actor,action:'maintenance.restore.request.cancelled',resourceId:key,before:null,after:{requestKey:key,jobId:job?.id??null}});
   return {cancelled:true};
  });
 }
 async claim(runnerId:string,authorized:(actor:string)=>Promise<boolean>){
  return this.transaction(async client=>{
   await this.expire(client);const runner=await this.runner(client,runnerId);
   if((await client.query("SELECT 1 FROM web_restore_jobs WHERE state='running'")).rowCount)return null;
   const row=(await client.query<RestoreJob>("SELECT * FROM web_restore_jobs WHERE state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE")).rows[0];if(!row)return null;
   let valid=await authorized(row.actor);try{this.checkpoint(runner,(row.kind==='preview'?row.input:row.preview) as RestorePreviewInput);if(row.kind==='restore'&&(!row.preview||row.preview.configDigest!==runner.config_digest||Date.parse(row.preview.expiresAt)<=Date.now()))valid=false;}catch{valid=false;}
   if(!valid){await client.query("UPDATE web_restore_jobs SET state='failed',error_code='AUTHORIZATION_OR_PREVIEW_CHANGED',message='Права, копия или проверка изменились до запуска.',updated_at=now() WHERE id=$1",[row.id]);await securityEvent(client,{actor:'system:restore',action:'maintenance.restore.rejected',resourceId:row.id,before:{state:'queued'},after:{state:'failed'}});return null;}
   return (await client.query<RestoreJob>("UPDATE web_restore_jobs SET state='running',runner_id=$2,lease_id=$3,lease_until=now()+interval '45 seconds',updated_at=now(),message=$4 WHERE id=$1 RETURNING *",[row.id,runnerId,randomUUID(),row.kind==='preview'?'Проверяем весь комплект и новое назначение.':'Восстановление в новый стек выполняется.'])).rows[0];
  });
 }
 async pulse(id:string,runnerId:string,leaseId:string,message:string){
  const row=(await this.pool.query<RestoreJob>("UPDATE web_restore_jobs SET lease_until=now()+interval '45 seconds',message=$4,updated_at=now() WHERE id=$1 AND runner_id=$2 AND lease_id=$3 AND state='running' AND lease_until>now() RETURNING *",[id,runnerId,leaseId,message])).rows[0];
  if(!row)throw new ConflictException('Аренда исполнителя потеряна. Автоматический повтор запрещён.');
  await this.pool.query('UPDATE web_restore_runner SET seen_at=now() WHERE singleton AND runner_id=$1',[runnerId]);return {ok:true};
 }
 async complete(id:string,runnerId:string,leaseId:string,result:{state:'ready'|'succeeded'|'failed';preview?:unknown;receipt?:unknown;errorCode?:string}){
  return this.transaction(async client=>{
   const row=(await client.query<RestoreJob>('SELECT * FROM web_restore_jobs WHERE id=$1 AND runner_id=$2 AND lease_id=$3 FOR UPDATE',[id,runnerId,leaseId])).rows[0];
   if(!row)throw new ConflictException('Результат принадлежит другой аренде.');
   if(['ready','succeeded','failed'].includes(row.state)){if(row.state!==result.state||result.preview&&digest(row.preview)!==digest(result.preview)||result.receipt&&digest(row.receipt)!==digest(result.receipt))throw new ConflictException('Завершённый результат нельзя заменить.');return row;}
   if(!['running','interrupted'].includes(row.state))throw conflict();
   let preview:RestoreJob['preview']=null,receipt:RestoreJob['receipt']=null;
   if(result.state==='ready'){
    if(row.kind!=='preview')throw conflict();preview=previewResult(result.preview);const input=row.input as RestorePreviewInput;
    if(preview.checkpointId!==input.checkpointId||preview.checkpointSha256!==input.checkpointSha256||preview.targetProject!==input.targetProject)throw conflict();
   }else if(result.state==='succeeded'){
    if(row.kind!=='restore'||!row.preview)throw conflict();receipt=restoreReceipt(result.receipt);
    if(receipt.projectName!==row.preview.targetProject||receipt.sha256!==row.preview.checkpointSha256||receipt.databases!==row.preview.impact.databases.length)throw conflict();
   }
   const code=result.errorCode??'EXECUTION_FAILED',failure=restoreFailureMessages[code]??restoreFailureMessages.EXECUTION_FAILED;
   const message=result.state==='ready'?'Копия и новое назначение проверены. Требуется явное подтверждение.':result.state==='succeeded'?'Данные восстановлены в новый стек. Приложения остановлены; выполните проверку новой площадки перед вводом в работу.':failure+' '+(row.kind==='preview'?'Восстановление не запускалось.':'Исходный стек сохранён; новый target может содержать частичные данные.');
   const updated=(await client.query<RestoreJob>('UPDATE web_restore_jobs SET state=$2,preview=COALESCE($3,preview),receipt=$4,error_code=$5,message=$6,updated_at=now() WHERE id=$1 RETURNING *',[id,result.state,preview?JSON.stringify(preview):null,receipt?JSON.stringify(receipt):null,result.state==='failed'?code:null,message])).rows[0];
   await securityEvent(client,{actor:row.actor,action:'maintenance.restore.'+result.state,resourceId:id,before:{state:row.state},after:{state:result.state,...receipt?{receipt}:preview?{digest:preview.digest,checkpointSha256:preview.checkpointSha256,targetProject:preview.targetProject}:{code:updated.error_code}}});return updated;
  });
 }
}
