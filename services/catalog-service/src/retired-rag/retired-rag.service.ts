import {BadRequestException,ConflictException,ForbiddenException,HttpException,Injectable,NotFoundException,ServiceUnavailableException,type OnModuleDestroy,type OnModuleInit} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createPool} from '../database/pool';
import {CatalogService} from '../catalog/catalog.service';
import {AccessDb} from '../access/access-db';
import {DeviceStore} from '../devices/device-store';
import {securityEvent} from '../access/security-events';
import {ragRequestHash} from '../../../shared/rag-index-contract.cjs';
import {retirementBlockers} from './retirement-guards';
import {publicPurge,type IPurgeRow,type IPreviewRow,type IRetiredFacts,type IRetirement} from './retired-rag.types';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.sort().join(',');

/** Catalog держит durable разрешение; RAG хранит квитанцию физического DROP и сверяет её при повторе. */
@Injectable()
export class RetiredRagService implements OnModuleInit,OnModuleDestroy {
    private readonly pool=createPool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:4},'retired-rag');
    private timer?:NodeJS.Timeout;
    private readonly running=new Set<string>();
    private readonly tasks=new Set<Promise<void>>();
    constructor(private readonly catalog:CatalogService,private readonly access:AccessDb,private readonly devices:DeviceStore){}
    async onModuleInit(){await this.catalog.ensureSchema();await this.devices.ready();
        this.timer=setInterval(()=>{const work=this.recover().catch(()=>undefined);this.tasks.add(work);void work.finally(()=>this.tasks.delete(work));},3000);this.timer.unref();}
    async onModuleDestroy(){if(this.timer)clearInterval(this.timer);await Promise.allSettled([...this.tasks]);await this.pool.end();}
    async list(){
        const inventory=await this.rag<Array<{projectId:string;databaseName:string;state:string;present:boolean;bytes:number}>>('inventory');
        // Explicitly inventory old orphans: catalog outages never imply that a project was deleted.
        for(const db of inventory){if(!db.present||db.state==='purged')continue;
            const client=await this.pool.connect();try{await client.query('BEGIN');await this.lock(client,db.projectId);
                if(!(await client.query('SELECT 1 FROM projects WHERE id=$1',[db.projectId])).rows.length)await client.query(`INSERT INTO project_retirements(project_id,project_name,actor,origin)
                    VALUES($1,$1,'system','discovered') ON CONFLICT(project_id) DO NOTHING`,[db.projectId]);await client.query('COMMIT');
            }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}
        const records=(await this.pool.query<IRetirement>(`SELECT * FROM project_retirements ORDER BY deleted_at DESC`)).rows;
        const jobs=(await this.pool.query<IPurgeRow>(`SELECT DISTINCT ON(retirement_id) * FROM retired_rag_purges ORDER BY retirement_id,created_at DESC`)).rows;
        const databases=new Map(inventory.map(db=>[db.projectId,db])),purges=new Map(jobs.map(job=>[job.retirement_id,job]));
        return {items:await Promise.all(records.filter(row=>databases.has(row.project_id)).map(async row=>({id:row.id,projectId:row.project_id,projectName:row.project_name,deletedAt:row.deleted_at,origin:row.origin,
            retention:{revision:row.retention_revision,retainUntil:row.retain_until,reason:row.retention_reason,automaticPurge:false},
            database:databases.get(row.project_id)??null,blockers:await this.blockers(this.pool,row),
            job:purges.has(row.id)?publicPurge(purges.get(row.id)!):null}))) };
    }
    async retention(id:string,input:unknown,actor:string){
        if(!exact(input,['expectedRevision','retainUntil','reason'])||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0
            ||typeof input.reason!=='string'||input.reason.length>500||input.retainUntil!==null&&(typeof input.retainUntil!=='string'||!Number.isFinite(Date.parse(input.retainUntil))||Date.parse(input.retainUntil)<=Date.now()))throw new BadRequestException('Укажите ревизию, будущую дату удержания или null, и причину до 500 символов.');
        const db=await this.pool.connect();try{await db.query('BEGIN');const row=await this.retired(id,db,true);
            if(row.retention_revision!==input.expectedRevision)throw new ConflictException('Удержание уже изменилось. Обновите сведения.');
            if((await db.query("SELECT 1 FROM retired_rag_purges WHERE retirement_id=$1 AND state IN ('queued','running')",[id])).rows.length)throw new ConflictException('Сначала дождитесь результата удаления.');
            await db.query('UPDATE project_retirements SET retain_until=$2,retention_reason=$3,retention_revision=retention_revision+1 WHERE id=$1',[id,input.retainUntil,input.reason]);
            await securityEvent(db,{actor,action:'rag.retention.update',resourceId:row.project_id,before:{revision:row.retention_revision,retainUntil:row.retain_until},after:{revision:row.retention_revision+1,retainUntil:input.retainUntil,reason:input.reason}});
            await db.query('COMMIT');return {ok:true};
        }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
    }
    async preview(id:string,actor:string){
        const row=await this.retired(id),blockers=await this.blockers(this.pool,row);if(blockers.length)throw new ConflictException(blockers.join(' '));
        const facts=await this.rag<IRetiredFacts>('preview',{projectId:row.project_id,retirementId:row.id});
        if(facts.retirementId!==id||facts.identity?.projectId!==row.project_id||!Number.isSafeInteger(facts.bytes)||facts.bytes<0)throw new ServiceUnavailableException('RAG не подтвердил точную базу.');
        const previewId=randomUUID(),digest=ragRequestHash(facts),expiresAt=new Date(Date.now()+10*60*1000).toISOString();
        await this.pool.query('INSERT INTO retired_rag_previews(id,retirement_id,digest,facts,retention_revision,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[previewId,id,digest,JSON.stringify(facts),row.retention_revision,expiresAt]);
        return {id:previewId,digest,facts,expiresAt,projectName:row.project_name,retentionRevision:row.retention_revision,
            warning:'Удаляется только серверная RAG-база. Сохранённые резервные копии, полные снимки LanceDB и локальные файлы остаются. Восстановление из копии требует отдельной проверки.'};
    }
    async purge(id:string,input:unknown,actor:string){
        if(!exact(input,['requestKey','previewId','digest'])||!uuid(input.requestKey)||!uuid(input.previewId)||!sha(input.digest))throw new BadRequestException('Передайте точный план удаления и ключ повтора.');
        const db=await this.pool.connect();let job:IPurgeRow;
        try{await db.query('BEGIN');const row=await this.retired(id,db,true);
            const previous=(await db.query<IPurgeRow>('SELECT * FROM retired_rag_purges WHERE request_key=$1',[input.requestKey])).rows[0];
            if(previous){if(previous.retirement_id!==id||previous.preview_id!==input.previewId||previous.digest!==input.digest)throw new ConflictException('Ключ повтора уже используется другим удалением.');await db.query('COMMIT');return publicPurge(previous);}
            const plan=(await db.query<IPreviewRow>('SELECT * FROM retired_rag_previews WHERE id=$1 AND retirement_id=$2',[input.previewId,id])).rows[0];
            if(!plan||plan.digest!==input.digest||Date.parse(plan.expires_at)<Date.now()||plan.retention_revision!==row.retention_revision)throw new ConflictException('План устарел. Подготовьте новый план удаления.');
            const blockers=await this.blockers(db,row);if(blockers.length)throw new ConflictException(blockers.join(' '));
            job=(await db.query<IPurgeRow>(`INSERT INTO retired_rag_purges(id,retirement_id,request_key,preview_id,digest,actor,state,message)
                VALUES($1,$2,$3,$4,$5,$6,'queued','Проверяем разрешение и использование базы.') RETURNING *`,[randomUUID(),id,input.requestKey,input.previewId,input.digest,actor])).rows[0];
            await securityEvent(db,{actor,action:'rag.purge.request',resourceId:row.project_id,before:{retirementId:id},after:{jobId:job.id,digest:job.digest,facts:plan.facts}});
            await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK').catch(()=>undefined);if((error as {code?:string}).code==='23505')throw new ConflictException('Удаление этой базы уже выполняется.');throw error;}finally{db.release();}
        this.launch(job.id);return publicPurge(job);
    }
    async get(id:string){return publicPurge(await this.job(id));}
    async authorizePreview(id:string,input:unknown){
        if(!exact(input,['projectId'])||typeof input.projectId!=='string')throw new BadRequestException('Некорректная сохранённая база.');
        const row=await this.retired(id);if(row.project_id!==input.projectId)throw new ConflictException('ID проекта не соответствует сохранённой базе.');
        const blockers=await this.blockers(this.pool,row);if(blockers.length)throw new ConflictException(blockers.join(' '));return {projectId:row.project_id,retirementId:row.id};
    }
    async retry(id:string,input:unknown,actor:string){
        if(!exact(input,['digest'])||!sha(input.digest))throw new BadRequestException('Передайте digest исходного удаления.');
        const db=await this.pool.connect();try{await db.query('BEGIN');const job=await this.job(id,db,true);
            if(job.digest!==input.digest||job.state!=='failed')throw new ConflictException('Повтор доступен только для незавершённого удаления.');
            const row=await this.retired(job.retirement_id,db,true),plan=(await db.query<IPreviewRow>('SELECT * FROM retired_rag_previews WHERE id=$1',[job.preview_id])).rows[0];
            const blockers=await this.blockers(db,row);if(blockers.length||row.retention_revision!==plan.retention_revision)throw new ConflictException(blockers.join(' ')||'Удержание изменилось. Подготовьте новый план.');
            await db.query("UPDATE retired_rag_purges SET actor=$2,state='queued',message='Повторяем сверку незавершённого удаления.',updated_at=now() WHERE id=$1",[id,actor]);
            await securityEvent(db,{actor,action:'rag.purge.retry',resourceId:row.project_id,before:{jobId:id},after:{digest:job.digest}});await db.query('COMMIT');
        }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
        this.launch(id);return this.get(id);
    }
    /** Вызывается RAG непосредственно перед DDL; роль, удержание и все refs читаются повторно. */
    async authorize(id:string,input:unknown){
        if(!exact(input,['digest'])||!sha(input.digest))throw new BadRequestException('Некорректное разрешение удаления.');
        const job=await this.job(id);if(!['queued','running'].includes(job.state)||job.digest!==input.digest)throw new ConflictException('Разрешение удаления больше не действует.');
        const claims=await this.access.claims(job.actor);if(!claims.userRoles.includes('Главный админ'))throw new ForbiddenException('Права инициатора удаления отозваны.');
        const row=await this.retired(job.retirement_id),plan=(await this.pool.query<IPreviewRow>('SELECT * FROM retired_rag_previews WHERE id=$1',[job.preview_id])).rows[0];
        if(row.retention_revision!==plan.retention_revision)throw new ConflictException('Удержание базы изменилось.');
        const blockers=await this.blockers(this.pool,row);if(blockers.length)throw new ConflictException(blockers.join(' '));return {projectId:row.project_id,digest:job.digest};
    }
    private launch(id:string){if(this.running.has(id))return;const task=this.run(id).catch(()=>undefined);this.tasks.add(task);void task.finally(()=>this.tasks.delete(task));}
    private async run(id:string){
        if(this.running.has(id))return;this.running.add(id);
        try{const job=await this.job(id);if(!['queued','running'].includes(job.state))return;
            await this.pool.query("UPDATE retired_rag_purges SET state='running',message='Сверяем базу и квитанцию удаления.',updated_at=now() WHERE id=$1 AND state IN ('queued','running')",[id]);
            const plan=(await this.pool.query<IPreviewRow>('SELECT * FROM retired_rag_previews WHERE id=$1',[job.preview_id])).rows[0];
            const receipt=await this.rag<{jobId:string;state:string;identity:IRetiredFacts['identity'];purgedAt:string}>('purge',{jobId:id,digest:job.digest,facts:plan.facts});
            if(receipt.jobId!==id||receipt.state!=='succeeded'||ragRequestHash(receipt.identity)!==ragRequestHash(plan.facts.identity)||!Number.isFinite(Date.parse(receipt.purgedAt)))throw new ServiceUnavailableException('Квитанция удаления не подтверждена.');
            const db=await this.pool.connect();try{await db.query('BEGIN');const locked=await this.job(id,db,true);if(locked.state!=='succeeded'){
                await db.query("UPDATE retired_rag_purges SET state='succeeded',message='Серверная RAG-база удалена. Резервные копии и снимки сохранены.',receipt=$2::jsonb,updated_at=now() WHERE id=$1",[id,JSON.stringify(receipt)]);
                await securityEvent(db,{actor:job.actor,action:'rag.purge.complete',resourceId:plan.facts.identity.projectId,before:{jobId:id,digest:job.digest},after:receipt});}await db.query('COMMIT');
            }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
        }catch(error){if(error instanceof HttpException&&!(error as {receiptPending?:boolean}).receiptPending&&[400,403,404,409,503].includes(error.getStatus()))await this.pool.query("UPDATE retired_rag_purges SET state='failed',message=$2,updated_at=now() WHERE id=$1 AND state IN ('queued','running')",[id,error.getStatus()===503?'База сохранена. Проверьте подключения и повторите удаление.':'Удаление не разрешено или план изменился. База сохранена; обновите план.']);
            // Network/unknown outcome retains durable running barrier. Same job reconciles receipt on recovery.
        }finally{this.running.delete(id);}
    }
    private async recover(){const jobs=(await this.pool.query<{id:string}>("SELECT id FROM retired_rag_purges WHERE state IN ('queued','running') ORDER BY created_at LIMIT 10")).rows;for(const job of jobs)this.launch(job.id);}
    private async blockers(db:Pick<PoolClient,'query'>,row:IRetirement){
        const blockers=await retirementBlockers(db,row.project_id);
        if((await db.query('SELECT 1 FROM projects WHERE id=$1',[row.project_id])).rows.length)blockers.unshift('Проект существует или восстанавливается.');
        if(row.retain_until&&new Date(row.retain_until).getTime()>Date.now())blockers.unshift('Срок удержания ещё не истёк.');return blockers;
    }
    private async retired(id:string,db:Pick<PoolClient,'query'>=this.pool,lock=false):Promise<IRetirement>{if(!uuid(id))throw new BadRequestException('Некорректный ID сохранённой базы.');const row=(await db.query<IRetirement>('SELECT * FROM project_retirements WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!row)throw new NotFoundException('Сохранённая база не найдена.');return row;}
    private async job(id:string,db:Pick<PoolClient,'query'>=this.pool,lock=false):Promise<IPurgeRow>{if(!uuid(id))throw new BadRequestException('Некорректное задание удаления.');const row=(await db.query<IPurgeRow>('SELECT * FROM retired_rag_purges WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!row)throw new NotFoundException('Задание удаления не найдено.');return row;}
    private async lock(db:PoolClient,projectId:string){await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||$1,0))",[projectId]);}
    private async rag<T>(route:string,body?:unknown):Promise<T>{
        const base=(process.env.RAG_SERVICE_URL||'http://localhost:4300').replace(/\/$/,'');let result:Response;
        try{result=await fetch(`${base}/internal/retired-rag/${route}`,{method:body===undefined?'GET':'POST',headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||'','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch{const error=new ServiceUnavailableException('Сервис баз недоступен. Результат незавершённого удаления будет проверен повторно.');Object.assign(error,{receiptPending:true});throw error;}
        if(!result.ok){if([400,403,404,409,503].includes(result.status))throw new HttpException(result.status===503?'База сохранена. Удаление не завершено.':'RAG не разрешил удаление: база используется или план изменился.',result.status);const error=new ServiceUnavailableException('Квитанция удаления ещё проверяется.');Object.assign(error,{receiptPending:true});throw error;}
        return await result.json() as T;
    }
}
