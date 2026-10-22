import {ConflictException,ForbiddenException,NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {publicationHash} from '../publication/publication-validation';
import type {LearningAnalysisInput} from '../../../shared/project-learning.cjs';
import {authorizeLearning} from './learning-access';
import {rollbackLearningTransaction} from './learning-transaction';
import {modelFromRow,type IModelRow} from '../models/model-history';
import {projectEmbeddingPin} from '../models/project-embedding.validation';
import type {AnalysisRow,AnalysisSnapshot} from './learning-analysis.types';

const identity=()=>randomUUID();
export const analysisRequestHash=(projectId:string,input:LearningAnalysisInput):string=>publicationHash({projectId,input});
/** Durable queue owns inference idempotency independently from the later learning mutation. */
export class LearningAnalysisRepository {
 constructor(readonly pool:Pool){}
 async byKey(projectId:string,actor:string,key:string):Promise<AnalysisRow|null>{
  return (await this.pool.query<AnalysisRow>('SELECT * FROM project_learning_analyses WHERE project_id=$1 AND actor_email=$2 AND request_key=$3',[projectId,actor,key])).rows[0]??null;
 }
 async get(projectId:string,id:string):Promise<AnalysisRow>{
  const row=(await this.pool.query<AnalysisRow>('SELECT * FROM project_learning_analyses WHERE project_id=$1 AND id=$2',[projectId,id])).rows[0];
  if(!row)throw new NotFoundException('Анализ не найден в этом проекте.');return row;
 }
 async enqueue(snapshot:AnalysisSnapshot,input:LearningAnalysisInput,modelPin:string):Promise<AnalysisRow>{
  const db=await this.pool.connect(),hash=analysisRequestHash(snapshot.projectId,input);let discard=false;
  try{
   await db.query('BEGIN');await authorizeLearning(db,snapshot.actor,snapshot.projectId,2);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['learning-analysis:'+snapshot.actor.email+':'+input.requestKey]);
   const previous=(await db.query<AnalysisRow>('SELECT * FROM project_learning_analyses WHERE actor_email=$1 AND request_key=$2',[snapshot.actor.email,input.requestKey])).rows[0];
   if(previous){if(previous.request_hash!==hash)throw new ConflictException('Ключ запроса уже относится к другому анализу.');await db.query('COMMIT');return previous;}
   await db.query('INSERT INTO project_learning_state(project_id) VALUES($1) ON CONFLICT DO NOTHING',[snapshot.projectId]);
   const revision=Number((await db.query('SELECT revision FROM project_learning_state WHERE project_id=$1 FOR UPDATE',[snapshot.projectId])).rows[0].revision);
   if(revision!==snapshot.revision||revision!==input.expectedRevision)throw new ConflictException('Опыт проекта изменился. Обновите страницу и выберите источники заново.');
   const active=(await db.query("SELECT id FROM project_learning_analyses WHERE project_id=$1 AND state IN ('queued','running')",[snapshot.projectId])).rows[0];
   if(active)throw new ConflictException('В этом проекте уже выполняется анализ. Дождитесь его результата.');
   const epoch=await this.authorizeModel(db,snapshot.projectId,input.modelId!,modelPin);
   const row=(await db.query<AnalysisRow>(`INSERT INTO project_learning_analyses(id,project_id,actor_email,actor_role,request_key,mutation_key,request_hash,model_id,model_pin,model_epoch,source_revision,input,experiences)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb) RETURNING *`,
    [identity(),snapshot.projectId,snapshot.actor.email,snapshot.actor.activeRole,input.requestKey,identity(),hash,input.modelId,modelPin,epoch,snapshot.revision,JSON.stringify(input),JSON.stringify(snapshot.experiences)])).rows[0];
   await db.query('COMMIT');return row;
  }catch(error){discard=await rollbackLearningTransaction(db);if((error as {code?:string}).code==='23505')throw new ConflictException('Анализ уже создан. Проверьте состояние запроса.');throw error;}finally{db.release(discard);}
 }
 /** SKIP LOCKED never races a live hypothesis transaction holding the same job FOR SHARE. */
 async recoverExpired():Promise<void>{
  const db=await this.pool.connect();let discard=false;try{await db.query('BEGIN');
   const rows=(await db.query<AnalysisRow>("SELECT * FROM project_learning_analyses WHERE state='running' AND lease_until<clock_timestamp() ORDER BY lease_until,id LIMIT 10 FOR UPDATE SKIP LOCKED")).rows;
   for(const row of rows){if(await this.reconcileReceipt(db,row))continue;
    await db.query(`UPDATE project_learning_analyses SET state='unknown',worker_id=NULL,lease_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
     error_code='ANALYSIS_INTERRUPTED',error_message='Исполнитель анализа прервался. Модель автоматически не запускается повторно.' WHERE id=$1`,[row.id]);
   }await db.query('COMMIT');
  }catch(error){discard=await rollbackLearningTransaction(db);throw error;}finally{db.release(discard);}
 }
 async claim(workerId:string):Promise<AnalysisRow|null>{
  const {rows}=await this.pool.query<AnalysisRow>(`WITH next AS (SELECT id FROM project_learning_analyses WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
   UPDATE project_learning_analyses a SET state='running',worker_id=$1,lease_until=now()+interval '120 seconds',started_at=now(),updated_at=now()
   FROM next WHERE a.id=next.id RETURNING a.*`,[workerId]);return rows[0]??null;
 }
 async complete(row:AnalysisRow,hypothesisIds:string[]):Promise<boolean>{
  const result=await this.pool.query(`UPDATE project_learning_analyses SET state='completed',hypothesis_ids=$3::jsonb,worker_id=NULL,lease_until=NULL,
   finished_at=now(),updated_at=now(),error_code=NULL,error_message=NULL WHERE id=$1 AND state='running' AND worker_id=$2 AND lease_until>clock_timestamp()`,[row.id,row.worker_id,JSON.stringify(hypothesisIds)]);
  return result.rowCount===1;
 }
 async fail(row:AnalysisRow,state:'failed'|'unknown',code:string,message:string):Promise<void>{
  await this.pool.query(`UPDATE project_learning_analyses SET state=$3,error_code=$4,error_message=$5,worker_id=NULL,lease_until=NULL,finished_at=now(),updated_at=now()
   WHERE id=$1 AND state='running' AND worker_id=$2`,[row.id,row.worker_id,state,code,message]);
 }
 async current(row:AnalysisRow):Promise<void>{
  const db=await this.pool.connect();let discard=false;try{await db.query('BEGIN');
   await authorizeLearning(db,{email:row.actor_email,activeRole:row.actor_role},row.project_id,2);
   await this.authorizeModel(db,row.project_id,row.model_id,row.model_pin,row.model_epoch);await this.authorizeLease(db,row);
   await db.query('COMMIT');
  }catch(error){discard=await rollbackLearningTransaction(db);throw error;}finally{db.release(discard);}
 }
 async authorizeLease(db:Pick<PoolClient,'query'>,row:AnalysisRow):Promise<void>{
  const live=(await db.query("SELECT id FROM project_learning_analyses WHERE id=$1 AND state='running' AND worker_id=$2 AND lease_until>clock_timestamp() FOR SHARE",[row.id,row.worker_id])).rows[0];
  if(!live)throw new ConflictException('Аренда анализа завершилась.');
 }
 async authorizeResult(db:Pick<PoolClient,'query'>,row:AnalysisRow):Promise<void>{
  await this.authorizeModel(db,row.project_id,row.model_id,row.model_pin,row.model_epoch);await this.authorizeLease(db,row);
 }
 private async authorizeModel(db:Pick<PoolClient,'query'>,projectId:string,modelId:string,pin:string,epoch?:string):Promise<string>{
  const raw=(await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR SHARE',[modelId])).rows[0];
  if(!raw||raw.archived_at||projectEmbeddingPin(modelFromRow(raw))!==pin)throw new ConflictException('Выбранная модель изменилась.');
  const assignment=(await db.query<{assignment_epoch:string}>('SELECT assignment_epoch FROM project_models WHERE project_id=$1 AND model_id=$2 FOR SHARE',[projectId,modelId])).rows[0];
  if(!assignment)throw new ForbiddenException('Назначение модели отозвано.');
  if(epoch&&assignment.assignment_epoch!==epoch)throw new ConflictException('Модель проекта переподключена.');return assignment.assignment_epoch;
 }
 /** The private mutation UUID and exact persisted hypotheses disambiguate a lost COMMIT reply. */
 private async reconcileReceipt(db:PoolClient,row:AnalysisRow):Promise<boolean>{
  const receipt=(await db.query<{result:unknown}>('SELECT result FROM project_learning_requests WHERE actor=$1 AND project_id=$2 AND request_key=$3',[row.actor_email,row.project_id,row.mutation_key])).rows[0]?.result;
  const saved=receipt as {projectId?:unknown;requestKey?:unknown;result?:{hypotheses?:unknown}}|undefined;
  const hypotheses=saved?.result?.hypotheses;
  if(saved?.projectId!==row.project_id||saved?.requestKey!==row.mutation_key||!Array.isArray(hypotheses)||!hypotheses.length||hypotheses.length>5)return false;
  const ids= hypothesisIds(hypotheses);if(!ids)return false;
  const persisted=(await db.query(`SELECT id FROM project_learning_hypotheses WHERE project_id=$1 AND id=ANY($2::uuid[]) AND created_by=$3
   AND data->>'origin'='llm' AND model->>'analysisId'=$4 AND model->>'modelId'=$5 AND model->>'modelPin'=$6 AND model->>'sourceRevision'=$7`,
   [row.project_id,ids,row.actor_email,row.id,row.model_id,row.model_pin,String(row.source_revision)])).rows;
  if(persisted.length!==ids.length)return false;
  await db.query(`UPDATE project_learning_analyses SET state='completed',hypothesis_ids=$2::jsonb,worker_id=NULL,lease_until=NULL,
   finished_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=NULL,error_message=NULL WHERE id=$1`,[row.id,JSON.stringify(ids)]);return true;
 }
 /** Wait for the original transaction's share lock before deciding a failed write has no receipt. */
 async reconcile(row:AnalysisRow):Promise<boolean>{
  const db=await this.pool.connect();let discard=false;try{await db.query('BEGIN');
   const current=(await db.query<AnalysisRow>("SELECT * FROM project_learning_analyses WHERE id=$1 FOR UPDATE",[row.id])).rows[0];
   if(!current){await db.query('COMMIT');return false;}
   const done=current.state==='completed'||current.state==='running'&&current.worker_id===row.worker_id&&await this.reconcileReceipt(db,current);
   await db.query('COMMIT');return done;
  }catch(error){discard=await rollbackLearningTransaction(db);throw error;}finally{db.release(discard);}
 }
}

function hypothesisIds(values:unknown[]):string[]|null{
 const ids=values.map(item=>item&&typeof item==='object'?(item as {id?:unknown}).id:undefined);
 if(!ids.every((id):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))||new Set(ids).size!==ids.length)return null;return ids;
}
