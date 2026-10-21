import {BadRequestException,ConflictException,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {canReadCommon,projectLevel} from '../access/access.model';
import type {AssetType,RequestActor,RequestTarget,TargetInput} from './request.types';
type Db=Pick<PoolClient,'query'>;
interface SkillSummary {path:string;meta:{name?:string;version:number;archivedAt?:string}}

/** Only the configured internal service is fetched; submitted source URLs are inert text. */
async function skills():Promise<SkillSummary[]>{
 const token=process.env.NEUROCENTER_INTERNAL_TOKEN;if(!token)throw new ServiceUnavailableException('Соединение со скиллами не настроено.');
 try{
  const response=await fetch((process.env.SKILLS_SERVICE_URL||'http://localhost:4200').replace(/\/$/,'')+'/api/skills',
   {headers:{'x-neurocenter-internal':token},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('unavailable');const data:unknown=await response.json();
  if(!Array.isArray(data)||data.some(row=>!row||typeof row.path!=='string'||!row.meta||!Number.isSafeInteger(row.meta.version)||row.meta.version<1
   ||row.meta.name!==undefined&&typeof row.meta.name!=='string'||row.meta.archivedAt!==undefined&&typeof row.meta.archivedAt!=='string'))throw Error('invalid');
  return data as SkillSummary[];
 }catch{throw new ServiceUnavailableException('Не удалось проверить каталог скиллов. Повторите после восстановления связи.');}
}
async function project(db:Db,actor:RequestActor,id:string){
 if(projectLevel(actor.claims,actor.activeRole,id)<1)throw new ForbiddenException('Нет доступа к выбранному проекту.');
 const row=(await db.query<{id:string;name:string}>('SELECT id,name FROM projects WHERE id=$1 AND state=\'ACTIVE\' FOR SHARE',[id])).rows[0];
 if(!row)throw new ConflictException('Проект удалён или недоступен.');return row;
}
export async function listTargets(db:Db,actor:RequestActor,type:AssetType,projectId:string|null,q='',limit=50,exactId?:string,lock=false):Promise<RequestTarget[]>{
 const scope=projectId?await project(db,actor,projectId):null;
 const projectIds=scope?[scope.id]:actor.claims.projects.filter(item=>projectLevel(actor.claims,actor.activeRole,item.projectId)>0).map(item=>item.projectId);
 const common=!scope&&canReadCommon(actor.claims,actor.activeRole),pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
 if(type==='model'){
  const rows=(await db.query<{id:string;name:string;version:number}>(`SELECT m.id,m.name,m.revision AS version FROM model_catalog m
   WHERE m.archived_at IS NULL AND ($1 OR EXISTS(SELECT 1 FROM project_models a WHERE a.model_id=m.id AND a.project_id=ANY($2::text[])))
   AND (m.name ILIKE $3 OR m.id ILIKE $3) AND ($5::text IS NULL OR m.id=$5) ORDER BY lower(m.name),m.id LIMIT $4`+(lock?' FOR SHARE OF m':''),[common,projectIds,pattern,limit,exactId??null])).rows;
  return rows.map(row=>({...row,type,available:true}));
 }
 if(type==='mcp'||type==='plugin'){
  const rows=(await db.query<{id:string;name:string;version:number}>(`SELECT p.id,p.name,p.version FROM ai_plugins p
   WHERE p.kind=$1 AND p.archived_at IS NULL AND ($2 OR EXISTS(SELECT 1 FROM project_assets a WHERE a.asset_id=p.id AND a.asset_kind=p.kind AND a.project_id=ANY($3::text[])))
   AND (p.name ILIKE $4 OR p.id ILIKE $4) AND ($6::text IS NULL OR p.id=$6) ORDER BY lower(p.name),p.id LIMIT $5`+(lock?' FOR SHARE OF p':''),[type,common,projectIds,pattern,limit,exactId??null])).rows;
  return rows.map(row=>({...row,type,available:true}));
 }
 const assignments=(await db.query<{id:string}>('SELECT DISTINCT asset_id AS id FROM project_assets WHERE asset_kind=\'skill\' AND project_id=ANY($1::text[])',[projectIds])).rows.map(row=>row.id);
 const native=scope?[scope]:[];
 return (await skills()).filter(row=>!row.meta.archivedAt&&(scope||row.path.startsWith('common/'))&&(common&&row.path.startsWith('common/')||assignments.includes(row.path)
   ||native.some(item=>row.path.startsWith('project-'+item.id+'/')||row.path.startsWith('project-'+item.name+'/'))))
  .filter(row=>!exactId||row.path===exactId)
  .filter(row=>(row.meta.name??row.path).toLowerCase().includes(q.toLowerCase())||row.path.toLowerCase().includes(q.toLowerCase()))
  .sort((left,right)=>left.path.localeCompare(right.path)).slice(0,limit)
  .map(row=>({type,id:row.path,name:row.meta.name||row.path,version:row.meta.version,available:true}));
}
/** Target identity/type/scope are checked again when a reviewer completes the request. */
export async function checkedTarget(db:Db,actor:RequestActor,input:TargetInput,type:AssetType,projectId:string|null):Promise<RequestTarget>{
 if(input.type!==type)throw new BadRequestException('Тип карточки не совпадает с заявкой.');
 const result=(await listTargets(db,actor,type,projectId,'',1,input.id,true)).find(item=>item.id===input.id);
 if(!result)throw new ConflictException('Карточка удалена, архивирована, имеет другой тип или не подключена к этому проекту.');
 if(projectId){
  const table=type==='model'?'project_models':'project_assets',column=type==='model'?'model_id':'asset_id';
  const assigned=(await db.query('SELECT 1 FROM '+table+' WHERE project_id=$1 AND '+column+'=$2'+(type==='model'?'':' AND asset_kind=$3')+' FOR SHARE',type==='model'?[projectId,input.id]:[projectId,input.id,type])).rowCount;
  if(!assigned){
   const scope=await project(db,actor,projectId);
   if(type!=='skill'||!input.id.startsWith('project-'+scope.id+'/')&&!input.id.startsWith('project-'+scope.name+'/'))throw new ConflictException('Карточка больше не подключена к выбранному проекту.');
  }
 }
 return result;
}
/** Historical snapshots remain readable; absence/outage never pretends the card is available. */
export async function targetAvailability(db:Db,targets:RequestTarget[]):Promise<Map<string,boolean|null>>{
 const result=new Map<string,boolean|null>();
 for(const type of ['plugin','mcp','model'] as const){
  const ids=targets.filter(item=>item.type===type).map(item=>item.id);if(!ids.length)continue;
  const rows=type==='model'?(await db.query<{id:string}>('SELECT id FROM model_catalog WHERE id=ANY($1::text[]) AND archived_at IS NULL',[ids])).rows
   :(await db.query<{id:string}>('SELECT id FROM ai_plugins WHERE id=ANY($1::text[]) AND kind=$2 AND archived_at IS NULL',[ids,type])).rows;
  const found=new Set(rows.map(row=>row.id));for(const id of ids)result.set(type+':'+id,found.has(id));
 }
 const ids=targets.filter(item=>item.type==='skill').map(item=>item.id);
 if(ids.length){let found:Set<string>|undefined;try{found=new Set((await skills()).filter(row=>!row.meta.archivedAt).map(row=>row.path));}catch{}
  for(const id of ids)result.set('skill:'+id,found?found.has(id):null);}
 return result;
}
