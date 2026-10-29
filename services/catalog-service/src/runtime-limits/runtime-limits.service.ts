import {BadRequestException,ConflictException,ForbiddenException,HttpException,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {Request} from 'express';
import type {PoolClient} from 'pg';
import {ModelsService} from '../models/models.service';
import {securityEvent} from '../access/security-events';
import {requireFeatureEnabled} from '../features/require-feature-enabled';
import {readFeatures} from '../../../shared/feature-client.cjs';
import {configuredGgufImportPolicy,type GgufImportPolicy} from '../../../shared/gguf-import-policy.cjs';
import {DEFAULT_RUNTIME_LIMIT_POLICY,RUNTIME_LIMIT_CEILINGS,runtimeLimitPolicy,runtimeLimitInput,
 type RuntimeLimitView,type RuntimeLimitAdminView,type RuntimeLimitReceipt,type RuntimeLimitInput} from '../../../shared/runtime-limits.cjs';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const unavailable=()=>new ServiceUnavailableException('Действующие лимиты не подтверждены. Сохранённые операции и квитанции продолжают действовать.');
const fingerprint=(writer:string,input:RuntimeLimitInput)=>createHash('sha256').update(JSON.stringify({writer,...input})).digest('hex');

/** Catalog owns policy authority; accepted operations keep their own immutable admission snapshots. */
@Injectable()
export class RuntimeLimitsService {
    constructor(private readonly models:ModelsService){}
    async effective(db:Pick<PoolClient,'query'>=this.models.pool):Promise<RuntimeLimitView>{
        try{
            const row=(await db.query('SELECT revision,policy,updated_at FROM runtime_limit_settings WHERE singleton')).rows[0];
            const policy=runtimeLimitPolicy(row?.policy??{...DEFAULT_RUNTIME_LIMIT_POLICY,ggufImport:configuredGgufImportPolicy()});
            return {revision:Number(row?.revision??0),policy,ceilings:RUNTIME_LIMIT_CEILINGS,updatedAt:row?new Date(row.updated_at).toISOString():null};
        }catch{throw unavailable();}
    }
    async ggufPolicy():Promise<Readonly<GgufImportPolicy>>{return (await this.effective()).policy.ggufImport;}
    private async main(req:Request,expected?:string):Promise<string>{
        if(req.headers.authorization||req.headers['x-neurocenter-device-id'])throw new ForbiddenException('Общие лимиты изменяет главный администратор через интерфейс.');
        const writer=await this.models.requireMain(req);
        if(expected&&writer!==expected)throw new ForbiddenException('Учётная запись изменилась. Перечитайте лимиты.');return writer;
    }
    async read(req:Request):Promise<RuntimeLimitView>{
        const actor=await this.models.actor(req),result=await this.effective(),current=await this.models.actor(req);
        if(actor.email!==current.email||actor.activeRole!==current.activeRole)throw new ForbiddenException('Учётная запись изменилась. Перечитайте лимиты.');return result;
    }
    async admin(req:Request):Promise<RuntimeLimitAdminView>{
        const writer=await this.main(req),result=await this.effective();
        const configurationEnabled=(await readFeatures(process.env,globalThis.fetch)).flags.runtime_limit_configuration;
        await this.main(req,writer);return {...result,configurationEnabled};
    }
    async receipt(req:Request,key:string):Promise<RuntimeLimitReceipt>{
        if(!uuid(key))throw new BadRequestException('Нужен ключ сохранения лимитов.');
        const writer=await this.main(req),row=(await this.models.pool.query('SELECT result FROM runtime_limit_requests WHERE actor=$1 AND request_key=$2',[writer,key])).rows[0];
        await this.main(req,writer);if(!row)throw new NotFoundException('Квитанция этого сохранения не найдена.');return row.result;
    }
    async save(req:Request,raw:unknown):Promise<RuntimeLimitReceipt>{
        let input:RuntimeLimitInput;try{input=runtimeLimitInput(raw);}catch(error){throw new BadRequestException((error as Error).message);}
        const writer=await this.main(req),hash=fingerprint(writer,input),db=await this.models.pool.connect();let discard=false;
        try{
            await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='7s'");
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:runtime-limits',0))");
            const account=(await db.query('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[writer])).rows[0];
            if(!account?.enabled||!account.is_main_admin)throw new ForbiddenException('Права главного администратора отозваны.');
            const prior=(await db.query('SELECT request_hash,result FROM runtime_limit_requests WHERE actor=$1 AND request_key=$2',[writer,input.requestKey])).rows[0];
            if(prior){
                if(prior.request_hash!==hash)throw new ConflictException('Ключ уже относится к другим лимитам или ревизии.');
                await db.query('COMMIT');await this.main(req,writer);return prior.result;
            }
            await requireFeatureEnabled('runtime_limit_configuration');
            const current=await this.effective(db);
            if(current.revision!==input.expectedRevision)throw new ConflictException('Лимиты уже изменились. Перечитайте действующие значения; введённое сохранено.');
            const row=(await db.query(`INSERT INTO runtime_limit_settings(singleton,revision,policy) VALUES(true,1,$1::jsonb)
                ON CONFLICT(singleton) DO UPDATE SET revision=runtime_limit_settings.revision+1,policy=EXCLUDED.policy,updated_at=clock_timestamp()
                RETURNING revision,updated_at`,[JSON.stringify(input.policy)])).rows[0];
            const result:RuntimeLimitReceipt={requestKey:input.requestKey,requestHash:hash,revision:Number(row.revision),policy:input.policy,acceptedAt:new Date(row.updated_at).toISOString()};
            await securityEvent(db,{actor:writer,action:'runtime.limits.update',resourceId:'runtime-limits',before:{revision:current.revision,policy:current.policy},after:result});
            await db.query('INSERT INTO runtime_limit_requests(actor,request_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',[writer,input.requestKey,hash,JSON.stringify(result)]);
            await db.query('COMMIT');await this.main(req,writer);return result;
        }catch(error){
            await db.query('ROLLBACK').catch(()=>{discard=true;});
            if(error instanceof HttpException&&error.getStatus()<500)throw error;
            throw new ServiceUnavailableException({code:'RUNTIME_LIMIT_SAVE_UNCONFIRMED',message:'Сохранение лимитов не подтверждено. Проверьте квитанцию или повторите тот же запрос; ввод сохранён.'});
        }finally{db.release(discard);}
    }
}
