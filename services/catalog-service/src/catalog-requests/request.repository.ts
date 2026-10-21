import {BadRequestException,ConflictException,ForbiddenException,NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {projectLevel,type IAccessActor} from '../access/access.model';
import {securityEvent} from '../access/security-events';
import {publicationHash} from '../publication/publication-validation';
import {currentActor,canRead,permissions} from './request.access';
import {checkedTarget,listTargets,targetAvailability} from './request.targets';
import {actionInput,createInput,editInput,listInput,targetQuery,uuid} from './request.validation';
import type {CatalogRequest,RequestActor,RequestDetail,RequestEvent,RequestList,RequestRow,RequestStatus} from './request.types';

const summary=(row:RequestRow)=>({id:row.id,title:row.title,kind:row.kind,assetType:row.asset_type,projectId:row.project_id,status:row.status,revision:row.revision});
/** Request state, append-only history, audit and retry receipt commit in one transaction. */
export class CatalogRequestRepository {
 constructor(readonly pool:Pool){}
 private async transaction<T>(input:IAccessActor,work:(db:PoolClient,actor:RequestActor)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();try{await db.query('BEGIN');const result=await work(db,await currentActor(db,input));await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
 }
 private async row(db:PoolClient,actor:RequestActor,id:string,lock=false):Promise<RequestRow>{
  const row=(await db.query<RequestRow>('SELECT * FROM catalog_requests WHERE id=$1'+(lock?' FOR UPDATE':' FOR SHARE'),[uuid(id)])).rows[0];
  if(!row||!canRead(actor,row))throw new NotFoundException('Заявка не найдена или недоступна.');return row;
 }
 private async views(db:PoolClient,actor:RequestActor,rows:RequestRow[]):Promise<CatalogRequest[]>{
  const available=await targetAvailability(db,rows.flatMap(row=>row.target?[row.target]:[]));
  const scoped=rows.filter(row=>row.project_id&&row.target),ids=scoped.map(row=>row.project_id);
  const projects=(await db.query<{id:string;name:string}>('SELECT id,name FROM projects WHERE id=ANY($1::text[]) AND state=\'ACTIVE\'',[ids])).rows;
  const assignments=(await db.query<{project_id:string;asset_id:string;asset_kind:string}>('SELECT project_id,asset_id,asset_kind FROM project_assets WHERE project_id=ANY($1::text[])',[ids])).rows;
  const models=(await db.query<{project_id:string;model_id:string}>('SELECT project_id,model_id FROM project_models WHERE project_id=ANY($1::text[])',[ids])).rows;
  const targetView=(row:RequestRow)=>{
   if(!row.target)return null;const target={...row.target,available:available.get(row.target.type+':'+row.target.id)??null};
   if(row.project_id){
    const project=projects.find(item=>item.id===row.project_id),assigned=target.type==='model'?models.some(item=>item.project_id===row.project_id&&item.model_id===target.id)
     :assignments.some(item=>item.project_id===row.project_id&&item.asset_id===target.id&&item.asset_kind===target.type);
    const native=target.type==='skill'&&project&&(target.id.startsWith('project-'+project.id+'/')||target.id.startsWith('project-'+project.name+'/'));
    if(!project||!assigned&&!native)target.available=false;
   }
   return target;
  };
  return rows.map(row=>({id:row.id,kind:row.kind,assetType:row.asset_type,title:row.title,description:row.description,sourceUrl:row.source_url,
   projectId:row.project_id,projectName:row.project_name,createdBy:row.created_by,status:row.status,revision:row.revision,
   createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),target:targetView(row),permissions:permissions(actor,row)}));
 }
 private async detail(db:PoolClient,actor:RequestActor,row:RequestRow):Promise<RequestDetail>{
  const events=(await db.query<Omit<RequestEvent,'at'>&{at:Date}>(`SELECT id,action,actor,comment,from_status AS "fromStatus",to_status AS "toStatus",revision,created_at AS at FROM catalog_request_events WHERE request_id=$1 ORDER BY revision`,[row.id])).rows;
  const history=events.map(event=>({...event,at:event.at.toISOString()}));
  return {...(await this.views(db,actor,[row]))[0],history};
 }
 list(input:IAccessActor,query:unknown):Promise<RequestList>{
  const filter=listInput(query);return this.transaction(input,async(db,actor)=>{
   const values:unknown[]=[],conditions:string[]=[];
   const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
   if(actor.activeRole!=='Главный админ'){
    const projects=actor.claims.projects.filter(item=>projectLevel(actor.claims,actor.activeRole,item.projectId)>0).map(item=>item.projectId);
    const reviewing=actor.claims.projects.filter(item=>projectLevel(actor.claims,actor.activeRole,item.projectId)>=3).map(item=>item.projectId);
    conditions.push('(project_id IS NULL OR project_id=ANY('+bind(projects)+'::text[]))');
    conditions.push('(created_by='+bind(actor.email)+' OR project_id=ANY('+bind(reviewing)+'::text[]))');
   }
   if(filter.scope==='mine')conditions.push('created_by='+bind(actor.email));
   for(const [column,value]of [['status',filter.status],['kind',filter.kind],['asset_type',filter.assetType],['project_id',filter.projectId]])if(value!==undefined)conditions.push(column+'='+bind(value));
   const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
   const total=Number((await db.query<{n:number}>('SELECT count(*)::int AS n FROM catalog_requests'+where,values)).rows[0].n);
   const rows=(await db.query<RequestRow>('SELECT * FROM catalog_requests'+where+' ORDER BY updated_at DESC,id LIMIT '+bind(filter.size)+' OFFSET '+bind((filter.page-1)*filter.size),values)).rows;
   return {items:await this.views(db,actor,rows),total,page:filter.page,size:filter.size};
  });
 }
 get(actor:IAccessActor,id:string):Promise<RequestDetail>{return this.transaction(actor,async(db,current)=>this.detail(db,current,await this.row(db,current,id)));}
 targets(actor:IAccessActor,raw:unknown){const query=targetQuery(raw);return this.transaction(actor,async(db,current)=>({items:await listTargets(db,current,query.assetType,query.projectId,query.q,query.limit)}));}
 private mutate(input:IAccessActor,key:string,operation:string,payload:unknown,work:(db:PoolClient,actor:RequestActor)=>Promise<RequestRow>):Promise<RequestDetail>{
  return this.transaction(input,async(db,actor)=>{
   const hash=publicationHash({operation,role:actor.activeRole,payload});
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['catalog-request:'+actor.email+':'+key]);
   const old=(await db.query<{request_hash:string;result:{id:string}}>('SELECT request_hash,result FROM catalog_request_mutations WHERE actor=$1 AND request_key=$2',[actor.email,key])).rows[0];
   if(old){if(old.request_hash!==hash)throw new ConflictException('Ключ запроса уже относится к другому изменению заявки.');return this.detail(db,actor,await this.row(db,actor,old.result.id));}
   const row=await work(db,actor);
   await db.query('INSERT INTO catalog_request_mutations(actor,request_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',[actor.email,key,hash,JSON.stringify({id:row.id})]);
   return this.detail(db,actor,row);
  });
 }
 private async event(db:PoolClient,actor:RequestActor,action:string,before:RequestRow|null,after:RequestRow,comment=''){
  await db.query('INSERT INTO catalog_request_events(id,request_id,action,actor,comment,from_status,to_status,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [randomUUID(),after.id,action,actor.email,comment,before?.status??null,after.status,after.revision]);
  await securityEvent(db,{actor:actor.email,action:'catalog_request.'+action,resourceId:after.id,before:before?summary(before):null,after:summary(after)});
 }
 create(actor:IAccessActor,raw:unknown):Promise<RequestDetail>{
  const input=createInput(raw);return this.mutate(actor,input.requestKey,'create',input,async(db,current)=>{
   let projectName:string|null=null;
   if(input.projectId){
    if(projectLevel(current.claims,current.activeRole,input.projectId)<1)throw new ForbiddenException('Нет доступа к выбранному проекту.');
    const project=(await db.query<{name:string}>('SELECT name FROM projects WHERE id=$1 AND state=\'ACTIVE\' FOR SHARE',[input.projectId])).rows[0];
    if(!project)throw new ConflictException('Проект удалён или недоступен.');projectName=project.name;
   }
   const target=input.target?await checkedTarget(db,current,input.target,input.assetType,input.projectId):null;
   const row=(await db.query<RequestRow>(`INSERT INTO catalog_requests(id,kind,asset_type,title,description,source_url,project_id,project_name,created_by,status,revision,target)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',1,$10::jsonb) RETURNING *`,[randomUUID(),input.kind,input.assetType,input.title,input.description,input.sourceUrl,input.projectId,projectName,current.email,target?JSON.stringify(target):null])).rows[0];
   await this.event(db,current,'create',null,row);return row;
  });
 }
 edit(actor:IAccessActor,id:string,raw:unknown):Promise<RequestDetail>{
  uuid(id);const input=editInput(raw);return this.mutate(actor,input.requestKey,'edit',{id,...input},async(db,current)=>{
   const before=await this.row(db,current,id,true);
   if(!permissions(current,before).canEdit)throw new ForbiddenException('Редактировать можно свою новую заявку или заявку на доработке.');
   if(before.revision!==input.expectedRevision)throw new ConflictException('Заявка уже изменилась. Обновите её перед сохранением.');
   if(before.kind==='add'&&input.target||before.kind!=='add'&&!input.target)throw new BadRequestException('Обновление и проблема требуют карточку каталога.');
   const target=input.target?await checkedTarget(db,current,input.target,before.asset_type,before.project_id):null;
   const row=(await db.query<RequestRow>(`UPDATE catalog_requests SET title=$2,description=$3,source_url=$4,target=$5::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,input.title,input.description,input.sourceUrl,target?JSON.stringify(target):null])).rows[0];
   await this.event(db,current,'edit',before,row);return row;
  });
 }
 action(actor:IAccessActor,id:string,raw:unknown):Promise<RequestDetail>{
  uuid(id);const input=actionInput(raw);return this.mutate(actor,input.requestKey,'action',{id,...input},async(db,current)=>{
   const before=await this.row(db,current,id,true),allowed=permissions(current,before);
   if(before.revision!==input.expectedRevision)throw new ConflictException('Заявка уже изменилась. Обновите её перед действием.');
   if(input.action==='cancel'?!allowed.canCancel:input.action==='resubmit'?!allowed.canResubmit:!allowed.canReview)throw new ForbiddenException('Активная роль не разрешает это действие с заявкой.');
   const next:Record<string,RequestStatus>={start:'in_progress',needs_info:'needs_info',reject:'rejected',complete:'completed',resubmit:'submitted',cancel:'cancelled'};
   if(input.action==='start'&&before.status!=='submitted'||input.action==='complete'&&before.status!=='in_progress'||next[input.action]===before.status)throw new ConflictException('Этот переход статуса заявки недоступен.');
   let target=before.target;
   if(input.action==='complete'){
    const choice=input.target??before.target;if(!choice)throw new BadRequestException('Выберите карточку каталога, по которой выполнена заявка.');
    target=await checkedTarget(db,current,choice,before.asset_type,before.project_id);
   }
   const row=(await db.query<RequestRow>('UPDATE catalog_requests SET status=$2,target=$3::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[id,next[input.action],target?JSON.stringify(target):null])).rows[0];
   await this.event(db,current,input.action,before,row,input.comment);return row;
  });
 }
}
