import {BadRequestException,ConflictException,ForbiddenException,Injectable,OnModuleInit,ServiceUnavailableException} from '@nestjs/common';
import type {Request} from 'express';
import {CatalogService} from '../catalog/catalog.service';
import type {IOperation,IOperationPage,TOperationState} from '../catalog/dto';
import {ModelsService} from '../models/models.service';
import type {IModelActor} from '../models/model-access';
import {ProjectReindexService} from '../models/project-reindex.service';
import type {IReindexRow} from '../models/project-reindex.types';
import {DeviceJobs} from '../devices/device-jobs';
import {deviceJobRetryPolicy} from '../devices/device-job-retry';
import {projectLevel} from '../access/access.model';
import {publicationHash} from '../publication/publication-validation';

type Action='retry'|'cancel';
type Capabilities=NonNullable<IOperation['actions']>;
interface IResult {operationId:string;state:TOperationState;message:string;}
interface IReceipt {operation_id:string;action:Action;digest:string;target:Record<string,unknown>;result:IResult|null;}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const no=(reason:string)=>({supported:false,reason});

/** Журнал передаёт команды реальным очередям. Изменение строки operations никогда не заменяет исполнение. */
@Injectable()
export class OperationActionsService implements OnModuleInit {
    constructor(private readonly catalog:CatalogService,private readonly models:ModelsService,private readonly jobs:DeviceJobs,private readonly reindex:ProjectReindexService){}
    async onModuleInit():Promise<void>{
        await this.catalog.ensureSchema();
        await this.models.pool.query(`CREATE TABLE IF NOT EXISTS operation_action_requests(
            actor TEXT NOT NULL,request_key UUID NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,
            target JSONB NOT NULL,result JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(actor,request_key))`);
    }
    private scope(actor:IModelActor){
        if(actor.activeRole==='Главный админ')return undefined;
        return {actor:actor.email,projectIds:actor.claims.projects.filter(p=>projectLevel(actor.claims,actor.activeRole,p.projectId)>0)
            .flatMap(p=>[p.projectId,...(!p.projectName.startsWith('prj-')?[p.projectName]:[])])};
    }
    private async snapshot(operation:IOperation,actor:IModelActor):Promise<{capabilities:Capabilities;target:Record<string,unknown>}>{
        const own=operation.actor===actor.email;
        let target:Record<string,unknown>={};
        let executor:Capabilities['executor']='history';
        let retry:Capabilities['retry']=no('Историческая запись не содержит исполняемого задания.'),cancel:Capabilities['cancel']=no('Историческая запись не содержит исполняемого задания.');
        if(operation.resourceType==='bridge'&&uuid(operation.resourceId)){
            const job=(await this.models.pool.query('SELECT * FROM bridge_jobs WHERE id=$1',[operation.resourceId])).rows[0];
            if(job&&job.email===operation.actor&&job.project_id===operation.projectId){
                executor='bridge';target={id:job.id,kind:job.kind,state:job.state,project:job.project_id,actor:job.email,payloadSha256:publicationHash(job.payload)};
                const policy=deviceJobRetryPolicy(job.kind),level=operation.projectId?projectLevel(actor.claims,actor.activeRole,operation.projectId):2;
                const exists=!operation.projectId||!!(await this.models.pool.query('SELECT 1 FROM projects WHERE id=$1',[operation.projectId])).rowCount;
                retry=!own?no('Повторить можно только собственное задание.'):!exists?no('Проект удалён.'):!policy.retrySupported?no('Повтор требует нового выбора папки или подтверждения в исходном мастере.'):
                    level<policy.minimumLevel?no('Текущая роль не разрешает повтор этого задания.'):!['failed','cancelled'].includes(job.state)?no('Повтор доступен после ошибки или отмены.'):{supported:true};
                cancel=!own?no('Отменить можно только собственное задание.'):!exists||level<1?no('Доступ к проекту отозван.'):job.state!=='queued'?no('Мост уже принял задание или оно завершено. Отмена записи файлов здесь недоступна.'):{supported:true};
            }
        }else if(operation.resourceType==='rag-reindex'&&uuid(operation.resourceId)&&operation.projectId){
            const row=(await this.models.pool.query<IReindexRow&{updated_at:string}>('SELECT * FROM project_reindex_plans WHERE id=$1 AND project_id=$2',[operation.resourceId,operation.projectId])).rows[0];
            if(row&&row.actor===operation.actor){
                executor='rag-reindex';
                const local=row.connection_job_id?(await this.models.pool.query('SELECT state FROM bridge_jobs WHERE id=$1 AND email=$2 AND project_id=$3',[row.connection_job_id,row.actor,row.project_id])).rows[0]?.state:undefined;
                target={id:row.id,state:row.state,digest:row.digest,actor:row.actor,activeRole:row.active_role,project:row.project_id,connectionJob:row.connection_job_id??null,connectionError:row.connection_error??null,local:local??null,
                    ...(['failed','cancelled'].includes(row.state)?{finishedRevision:new Date(row.updated_at).toISOString()}:{}),retryLocal:row.state==='applied'};
                const allowed=own&&row.active_role===actor.activeRole&&projectLevel(actor.claims,actor.activeRole,row.project_id)>=3;
                retry=!allowed?no('Повтор требует владельца плана и действующей роли администратора проекта.'):
                    row.state==='failed'||row.state==='applied'&&(!!row.connection_error||['failed','cancelled'].includes(local))?{supported:true}:
                    no(row.state==='needs_input'?'Подтвердите перестройку существующих данных в настройках базы знаний.':row.state==='cancelled'||row.state==='stale'?'Этот план завершён. Подготовьте новый план в настройках базы знаний.':'Дождитесь завершения текущего подключения.');
                cancel=!allowed?no('Отмена требует владельца плана и действующей роли администратора проекта.'):
                    ['preparing','needs_input','building','ready','failed','stale'].includes(row.state)?{supported:true}:no('Активное или уже отменённое поколение нельзя отменить этим действием.');
            }
        }else if(operation.resourceType==='model'){
            executor='model-hosting';retry=no('Откройте карточку модели и повторите действие с её актуальной ревизией.');cancel=no('Исполнитель хостинга не поддерживает отмену из журнала.');
        }else if(operation.resourceType==='tool-build'){
            executor='tool-build';retry=no('Откройте упаковщик и создайте новый запрос с проверенным источником.');cancel=no('Исполнитель сборки не поддерживает отмену из журнала.');
        }
        const digest=publicationHash({operationId:operation.operationId,resourceType:operation.resourceType,resourceId:operation.resourceId,projectId:operation.projectId,actor:operation.actor,executor,target});
        return {capabilities:{executor,digest,retry,cancel},target};
    }
    async decorate<T extends IOperation>(request:Request,operation:T):Promise<T>{
        const actor=await this.models.actor(request);return {...operation,actions:(await this.snapshot(operation,actor)).capabilities};
    }
    async decoratePage(request:Request,page:IOperationPage):Promise<IOperationPage>{
        const actor=await this.models.actor(request);
        return {...page,items:await Promise.all(page.items.map(async operation=>({...operation,actions:(await this.snapshot(operation,actor)).capabilities})))};
    }
    private input(raw:unknown):{requestKey:string;expectedDigest:string}{
        const input=raw as {requestKey?:unknown;expectedDigest?:unknown};
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['requestKey','expectedDigest'].includes(k))||!uuid(input.requestKey)||typeof input.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedDigest))throw new BadRequestException('Нужны ключ запроса и актуальная проверка действия.');
        return input as {requestKey:string;expectedDigest:string};
    }
    async dispatch(request:Request,id:string,action:Action,raw:unknown):Promise<IResult>{
        const input=this.input(raw),actor=await this.models.actor(request),lease=await this.models.pool.connect();let locked=false,discard=false;
        const lock='operation-action:'+actor.email+':'+id;
        try{
            await lease.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);locked=true;
            // Scope and role are re-read even for a completed idempotent response.
            const freshActor=await this.models.actor(request),operation=await this.catalog.getOperation(id,this.scope(freshActor));
            if(operation.actor!==freshActor.email)throw new ForbiddenException('Из журнала можно управлять только собственным заданием.');
            const keyed=(await lease.query<IReceipt>('SELECT * FROM operation_action_requests WHERE actor=$1 AND request_key=$2',[actor.email,input.requestKey])).rows[0];
            if(keyed&&(keyed.operation_id!==id||keyed.action!==action||keyed.digest!==input.expectedDigest))throw new ConflictException('Ключ запроса уже использован для другого действия.');
            // Two tabs with different request keys still dispatch one action for the same source CAS.
            const previous=keyed??(await lease.query<IReceipt>('SELECT * FROM operation_action_requests WHERE actor=$1 AND operation_id=$2 AND action=$3 AND digest=$4 ORDER BY created_at LIMIT 1',[actor.email,id,action,input.expectedDigest])).rows[0];
            const current=await this.snapshot(operation,freshActor);
            if(!keyed){
                if(!previous){
                if(current.capabilities.digest!==input.expectedDigest)throw new ConflictException('Задание изменилось. Обновите журнал перед действием.');
                if(!current.capabilities[action].supported)throw new ConflictException(current.capabilities[action].reason);
                }
                await lease.query('INSERT INTO operation_action_requests(actor,request_key,operation_id,action,digest,target,result) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
                    [actor.email,input.requestKey,id,action,input.expectedDigest,JSON.stringify(previous?.target??{...current.target,executionKey:input.requestKey}),previous?.result?JSON.stringify(previous.result):null]);
            }
            if(previous?.result)return previous.result;
            const target=previous?.target??current.target,executionKey=typeof target.executionKey==='string'?target.executionKey:input.requestKey;
            let result:IResult;
            if(previous&&current.capabilities.executor==='rag-reindex'&&current.capabilities.digest!==previous.digest){
                // A lost ACK never starts a second generation. Return the exact executor's new state.
                result={operationId:id,state:operation.state,message:'Сохранённый запрос проверен. Показано текущее состояние переиндексации.'};
            }else result=await this.execute(request,operation,action,executionKey,target,current.capabilities.executor,freshActor);
            await lease.query('UPDATE operation_action_requests SET result=$3::jsonb WHERE actor=$1 AND request_key=$2',[actor.email,input.requestKey,JSON.stringify(result)]);
            return result;
        }finally{try{if(locked)await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}catch(error){discard=true;throw error;}finally{lease.release(discard);}}
    }
    private async execute(request:Request,operation:IOperation,action:Action,key:string,target:Record<string,unknown>,executor:Capabilities['executor'],actor:IModelActor):Promise<IResult>{
        if(executor==='bridge'){
            if(action==='cancel'){await this.jobs.cancel(actor,operation.resourceId);return {operationId:operation.operationId,state:'CANCELLED',message:'Задание в очереди отменено.'};}
            const job=await this.jobs.retry(actor,operation.resourceId,key);
            if(typeof job.id!=='string'||typeof job.state!=='string'||!['queued','running','succeeded','failed','cancelled','reconciling'].includes(job.state)||typeof job.message!=='string')throw new ServiceUnavailableException('Исполнитель не подтвердил сохранённое задание. Повторите тот же запрос.');
            return {operationId:'bridge-'+job.id,state:job.state.toUpperCase() as TOperationState,message:job.message};
        }
        if(executor==='rag-reindex'){
            const plan=action==='cancel'?await this.reindex.cancel(request,operation.projectId!,operation.resourceId):target.retryLocal?
                await this.reindex.retryLocal(request,operation.projectId!,operation.resourceId):await this.reindex.retry(request,operation.projectId!,operation.resourceId);
            return {operationId:operation.operationId,state:plan.state==='cancelled'?'CANCELLED':plan.state==='failed'?'FAILED':plan.state==='applied'&&!plan.local?'SUCCEEDED':'RUNNING',message:plan.local?.message??plan.message};
        }
        throw new ConflictException('Эта запись не поддерживает управление исполнителем.');
    }
}
