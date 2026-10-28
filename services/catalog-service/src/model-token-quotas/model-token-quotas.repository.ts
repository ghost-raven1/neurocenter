import {ConflictException,NotFoundException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {authorizeAccessWrite} from '../access/access-write-policy';
import type {IModel} from '../models/model.types';
import {emptyQuotaCounters,quotaCoverage,quotaPolicy,quotaRequestText,type ModelTokenQuotaPolicyRow} from './model-token-quotas.model';
import {MODEL_TOKEN_QUOTA_DEFAULT_PERIOD_MS,type ModelTokenQuotaInput,type ModelTokenQuotaPolicy,type ModelTokenQuotaReceipt,type ModelTokenQuotaView,type ModelTokenQuotaCounters} from './model-token-quotas.types';
import {quotaTransaction,quotaPairLock} from './quota-database';
import {quotaCounters} from './quota-counters';

export const quotaPolicyRow = async(db:Pick<PoolClient,'query'>,modelId:string,email:string):Promise<ModelTokenQuotaPolicy|null>=>{
    const row=(await db.query<ModelTokenQuotaPolicyRow>('SELECT * FROM model_user_token_quotas WHERE model_id=$1 AND user_email=$2',[modelId,email])).rows[0];
    return row?quotaPolicy(row):null;
};
/** This repository owns configuration receipts only; paid attempt accounting stays on model_usage_calls. */
export class ModelTokenQuotasRepository {
    constructor(readonly pool:Pool){}
    async read(model:IModel,email:string):Promise<ModelTokenQuotaView>{
        return quotaTransaction(this.pool,async db=>{
            const user=(await db.query('SELECT email FROM platform_users WHERE email=$1',[email])).rows[0];
            if(!user)throw new NotFoundException('Пользователь отсутствует на площадке.');
            const policy=await quotaPolicyRow(db,model.id,email),clock=(await db.query<{at:string}>('SELECT clock_timestamp()::text AS at')).rows[0].at;
            const balance=policy?await quotaCounters(db,policy,clock):undefined;
            const counters:ModelTokenQuotaCounters=balance?{actualInputTokens:balance.actualInputTokens,actualOutputTokens:balance.actualOutputTokens,
                chargedTokens:balance.chargedTokens,activeReservedTokens:balance.activeReservedTokens,unknownHeldTokens:balance.unknownHeldTokens,
                unknownCalls:balance.unknownCalls,remainingTokens:balance.remainingTokens,overrunTokens:balance.overrunTokens,nextBudgetChangeAt:balance.nextBudgetChangeAt}:emptyQuotaCounters();
            return {modelId:model.id,userEmail:email,policy,defaults:{periodMs:MODEL_TOKEN_QUOTA_DEFAULT_PERIOD_MS},counters,
                canManage:true,featureEnabled:false,coverage:quotaCoverage(model)};
        },{readOnly:true});
    }
    /** PUT may recover its own global key before looking up a now-deleted requested target. */
    async accepted(writer:string,key:string):Promise<ModelTokenQuotaReceipt|null>{
        return quotaTransaction(this.pool,async db=>{
            const row=(await db.query<{receipt:ModelTokenQuotaReceipt}>('SELECT receipt FROM model_user_token_quota_requests WHERE writer_email=$1 AND request_key=$2',[writer,key])).rows[0];
            return row?.receipt??null;
        },{readOnly:true});
    }
    async receipt(writer:string,modelId:string,email:string,key:string):Promise<ModelTokenQuotaReceipt>{
        return quotaTransaction(this.pool,async db=>{
            const row=(await db.query<{receipt:ModelTokenQuotaReceipt}>('SELECT receipt FROM model_user_token_quota_requests WHERE writer_email=$1 AND request_key=$2 AND model_id=$3 AND user_email=$4',[writer,key,modelId,email])).rows[0];
            if(!row)throw new NotFoundException('Сервер пока не подтвердил сохранение квоты.');
            return row.receipt;
        },{readOnly:true});
    }
    async save(writer:string,model:IModel,email:string,input:ModelTokenQuotaInput,signal?:AbortSignal):Promise<ModelTokenQuotaReceipt>{
        const fingerprint=createHash('sha256').update(quotaRequestText(writer,model.id,email,input)).digest('hex');
        return quotaTransaction(this.pool,async db=>{
            await authorizeAccessWrite(db,{email:writer,activeRole:'Главный админ'});
            await quotaPairLock(db,email,model.id);signal?.throwIfAborted();
            const prior=(await db.query<{request_fingerprint:string;receipt:ModelTokenQuotaReceipt}>('SELECT request_fingerprint,receipt FROM model_user_token_quota_requests WHERE writer_email=$1 AND request_key=$2',[writer,input.requestKey])).rows[0];
            if(prior){
                if(prior.request_fingerprint!==fingerprint)throw new ConflictException({code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT',message:'Ключ уже относится к другой настройке квоты.'});
                return prior.receipt;
            }
            const user=(await db.query('SELECT email FROM platform_users WHERE email=$1 FOR SHARE',[email])).rows[0];
            if(!user)throw new NotFoundException('Пользователь отсутствует на площадке.');
            const card=(await db.query<{id:string;descriptor:Pick<IModel,'runtime'|'capability'>;archived_at:string|null}>('SELECT id,descriptor,archived_at FROM model_catalog WHERE id=$1 FOR SHARE',[model.id])).rows[0];
            if(!card)throw new NotFoundException('Модель отсутствует в каталоге.');
            if(input.enabled&&(card.archived_at||!quotaCoverage(card.descriptor).managedText))throw new ConflictException({code:'MODEL_TOKEN_QUOTA_UNSUPPORTED_SURFACE',message:card.archived_at?'Модель убрана из каталога. История квоты доступна.':quotaCoverage(card.descriptor).reason});
            const current=await quotaPolicyRow(db,model.id,email);
            if((current?.revision??0)!==input.expectedRevision)throw new ConflictException({code:'MODEL_TOKEN_QUOTA_REVISION_CONFLICT',message:'Квота изменена другим администратором. Перечитайте состояние; ваш ввод сохранён.',current});
            const revision=(current?.revision??0)+1;
            if(!Number.isSafeInteger(revision))throw new ConflictException('Достигнут предел ревизий квоты.');
            const saved=(await db.query<ModelTokenQuotaPolicyRow>(`INSERT INTO model_user_token_quotas(model_id,user_email,revision,enabled,token_limit,period_ms,updated_by)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(model_id,user_email) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,
 token_limit=EXCLUDED.token_limit,period_ms=EXCLUDED.period_ms,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp() RETURNING *`,
                [model.id,email,revision,input.enabled,input.tokenLimit,input.periodMs,writer])).rows[0];
            const receipt:ModelTokenQuotaReceipt={modelId:model.id,userEmail:email,writerEmail:writer,requestKey:input.requestKey,requestFingerprint:fingerprint,input,policy:quotaPolicy(saved)};
            await db.query('INSERT INTO model_user_token_quota_requests(writer_email,request_key,model_id,user_email,request_fingerprint,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[writer,input.requestKey,model.id,email,fingerprint,JSON.stringify(receipt)]);
            return receipt;
        },{signal});
    }
}
