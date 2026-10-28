import {ConflictException,ForbiddenException,HttpException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {UsageTerminal} from '../model-usage/model-usage.types';
import {quotaPolicyRow} from './model-token-quotas.repository';
import {quotaCounters} from './quota-counters';
import {quotaTransaction,quotaPairLock,quotaUnavailable} from './quota-database';
import type {ModelTokenQuotaAdmission,ModelTokenQuotaEstimate,ModelTokenQuotaState} from './model-token-quotas.types';

interface QuotaUsageRow {
    id:string;worker_id:string;actor_email:string|null;model_id:string;status:string;dispatch_count:number|null;
    quota_state:ModelTokenQuotaState|null;quota_reserved_tokens:string|null;quota_debit_tokens:string|null;
    quota_metadata:Record<string,unknown>|null;quota_settlement_digest:string|null;active_lease:boolean|null;
}
const positiveEstimate=(estimate:ModelTokenQuotaEstimate):boolean=>[estimate.inputTokens,estimate.outputTokens,estimate.totalTokens].every(n=>Number.isSafeInteger(n)&&n>=0)
    &&/^[a-f0-9]{64}$/.test(estimate.requestDigest)&&estimate.totalTokens>0&&estimate.totalTokens===estimate.inputTokens+estimate.outputTokens;
const clock=async(db:Pick<PoolClient,'query'>):Promise<string>=>(await db.query<{at:string}>('SELECT clock_timestamp()::text AS at')).rows[0].at;
const row=async(db:Pick<PoolClient,'query'>,id:string,lock=false):Promise<QuotaUsageRow|undefined>=>(await db.query<QuotaUsageRow>('SELECT id,worker_id,actor_email,model_id,status,dispatch_count,quota_state,quota_reserved_tokens,quota_debit_tokens,quota_metadata,quota_settlement_digest,lease_until>clock_timestamp() AS active_lease FROM model_usage_calls WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
const assertOwned=(receipt:QuotaUsageRow|undefined,worker:string,email?:string,modelId?:string):QuotaUsageRow=>{
    if(!receipt||receipt.worker_id!==worker||email&&receipt.actor_email!==email||modelId&&receipt.model_id!==modelId)throw quotaUnavailable();
    return receipt;
};
async function transaction<T>(pool:Pool,work:(db:PoolClient)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    try{return await quotaTransaction(pool,work,{signal});}
    catch(error){if(error instanceof HttpException)throw error;signal?.throwIfAborted();throw quotaUnavailable();}
}
async function checkBalance(db:PoolClient,policy:NonNullable<Awaited<ReturnType<typeof quotaPolicyRow>>>,id:string,estimate:number,at:string):Promise<void>{
    const balance=await quotaCounters(db,policy,at,id);
    if(balance.unpricedUnknownCalls)throw new ConflictException({code:'MODEL_TOKEN_QUOTA_UNCERTAIN',message:'Есть неподтверждённый расход без оценки. Перечитайте журнал перед новой отправкой.',quota:balance});
    const total=BigInt(balance.chargedTokens)+BigInt(balance.activeReservedTokens)+BigInt(balance.unknownHeldTokens)+BigInt(estimate);
    if(total>BigInt(policy.tokenLimit))throw new HttpException({statusCode:429,code:'MODEL_TOKEN_QUOTA_EXCEEDED',
        message:'Персональный бюджет модели исчерпан с учётом расхода и резерва. Дождитесь доступного бюджета или обратитесь к главному администратору.',
        quota:{...balance,estimateTokens:String(estimate),tokenLimit:String(policy.tokenLimit),periodMs:policy.periodMs,accountingStartedAt:policy.accountingStartedAt}},429);
}
/** The existing usage UUID is the reservation identity; the pair check and insert are one transaction. */
export async function reserveUsageQuota(pool:Pool,worker:string,input:ModelTokenQuotaAdmission,signal?:AbortSignal):Promise<boolean>{
    if(!positiveEstimate(input.estimate))throw quotaUnavailable();
    return transaction(pool,async db=>{
        await quotaPairLock(db,input.userEmail,input.model.id);
        const account=(await db.query<{enabled:boolean}>('SELECT enabled FROM platform_users WHERE email=$1 FOR SHARE',[input.userEmail])).rows[0];
        if(!account?.enabled)throw new ForbiddenException('Доступ пользователя отозван.');
        const receipt=assertOwned(await row(db,input.usageId,true),worker,input.userEmail,input.model.id);
        if(receipt.status!=='pending'||receipt.active_lease!==true)throw quotaUnavailable();
        if(receipt.quota_state==='reserved'){
            const saved=receipt.quota_metadata?.estimate as ModelTokenQuotaEstimate|undefined;
            if(saved?.requestDigest!==input.estimate.requestDigest||saved?.totalTokens!==input.estimate.totalTokens||saved?.modelPin!==input.estimate.modelPin)
                throw new ConflictException({code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT',message:'Прежний usage UUID относится к другому запросу или оценке.'});
            return true;
        }
        if(receipt.quota_state!==null)throw new ConflictException({code:'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT',message:'Эта usage-квитанция уже использована для физической отправки. Новый платный повтор требует отдельной попытки.'});
        const policy=await quotaPolicyRow(db,input.model.id,input.userEmail);
        if(!policy?.enabled)return false;
        if(!input.estimate.supported)throw new ConflictException({code:'MODEL_TOKEN_QUOTA_UNSUPPORTED_SURFACE',message:'Этот managed-канал ещё не связан с проверенным персональным учётом. Отсутствие лимита ответа само по себе не запрещает модель.'});
        const at=await clock(db);await checkBalance(db,policy,input.usageId,input.estimate.totalTokens,at);
        await db.query(`UPDATE model_usage_calls SET quota_state='reserved',quota_reserved_tokens=$3,quota_debit_tokens=0,quota_admitted_at=$4::timestamptz,quota_metadata=$5::jsonb
 WHERE id=$1 AND worker_id=$2 AND status='pending' AND quota_state IS NULL`,[input.usageId,worker,input.estimate.totalTokens,at,JSON.stringify({
            version:1,estimate:input.estimate,policyRevision:policy.revision,periodMs:policy.periodMs,accountingStartedAt:policy.accountingStartedAt})]);
        return true;
    },signal);
}
/** Final owned intent precedes action even while enforcement is OFF; no lock reaches the network. */
export async function claimUsageQuota(pool:Pool,worker:string,id:string,enforce:boolean,signal?:AbortSignal):Promise<void>{
    await transaction(pool,async db=>{
        const found=assertOwned(await row(db,id),worker);
        if(enforce&&!found.actor_email)throw quotaUnavailable();
        if(found.actor_email)await quotaPairLock(db,found.actor_email,found.model_id);
        const receipt=assertOwned(await row(db,id,true),worker,found.actor_email??undefined,found.model_id);
        if(receipt.status!=='pending'||receipt.active_lease!==true||receipt.dispatch_count!==null&&receipt.dispatch_count!==0)throw quotaUnavailable();
        // OFF does not depend on policy storage. Existing reservations still retain their own accounting state.
        if(enforce){
            const account=(await db.query<{enabled:boolean}>('SELECT enabled FROM platform_users WHERE email=$1 FOR SHARE',[receipt.actor_email])).rows[0];
            if(!account?.enabled)throw new ForbiddenException('Доступ пользователя отозван.');
            const policy=await quotaPolicyRow(db,receipt.model_id,receipt.actor_email!);
            if(receipt.quota_state===null){if(policy?.enabled)throw quotaUnavailable();}
            else if(policy?.enabled)await checkBalance(db,policy,id,Number(receipt.quota_reserved_tokens),await clock(db));
        }
        if(receipt.quota_state!==null&&receipt.quota_state!=='reserved')throw quotaUnavailable();
        const claimed=await db.query(`UPDATE model_usage_calls SET dispatch_count=1,dispatched_at=clock_timestamp(),
 quota_state=CASE WHEN quota_state='reserved' THEN 'dispatched' ELSE quota_state END
 WHERE id=$1 AND worker_id=$2 AND status='pending' AND lease_until>clock_timestamp()
 AND (dispatch_count IS NULL OR dispatch_count=0) RETURNING id`,[id,worker]);
        if(claimed.rowCount!==1)throw quotaUnavailable();
    },signal);
}
/** Only this process's proof that action() was never entered may release a dispatch claim. */
export async function releaseUndispatchedQuota(pool:Pool,worker:string,id:string):Promise<void>{
    await transaction(pool,async db=>{
        const found=assertOwned(await row(db,id),worker);if(!found.actor_email)return;
        await quotaPairLock(db,found.actor_email!,found.model_id);
        await db.query("UPDATE model_usage_calls SET quota_state='released',quota_reserved_tokens=0,quota_debit_tokens=0 WHERE id=$1 AND worker_id=$2 AND status='pending' AND quota_state IN ('reserved','dispatched')",[id,worker]);
    });
}
const actual=(n:number|null):bigint|null=>n!==null&&Number.isSafeInteger(n)&&n>=0?BigInt(n):null;
/** Settlement modifies the same usage receipt, preserves nullable actuals and never repeats paid work. */
export async function finishQuotaUsage(pool:Pool,worker:string,id:string,value:UsageTerminal):Promise<boolean>{
    return transaction(pool,async db=>{
        const found=assertOwned(await row(db,id),worker);if(!found.actor_email)return false;
        await quotaPairLock(db,found.actor_email!,found.model_id);
        const receipt=assertOwned(await row(db,id,true),worker,found.actor_email!,found.model_id);
        // An unacknowledged reserve may still be committing; only this fenced read permits legacy fallback.
        if(!receipt.quota_state)return false;
        const digest=createHash('sha256').update(JSON.stringify({status:value.status,inputTokens:value.inputTokens,outputTokens:value.outputTokens,dispatchCount:value.dispatchCount??null})).digest('hex');
        if(receipt.quota_settlement_digest===digest)return true;
        if(!['pending','interrupted'].includes(receipt.status))throw new ConflictException('Терминальная usage-квитанция требует отдельного подтверждённого reconciliation, не перезаписи.');
        const input=actual(value.inputTokens),output=actual(value.outputTokens),known=(input??0n)+(output??0n);
        const undispatched=value.dispatchCount===0||receipt.quota_state==='released',complete=input!==null&&output!==null;
        const reserve=BigInt(receipt.quota_reserved_tokens??0),previous=BigInt(receipt.quota_debit_tokens??0),basis=reserve>previous?reserve:previous;
        const state:ModelTokenQuotaState=undispatched?'released':complete?'settled':'unknown';
        const debit=undispatched?0n:complete?known:known>basis?known:basis;
        await db.query(`UPDATE model_usage_calls SET status=$3,input_tokens=$4,output_tokens=$5,latency_ms=$6,dispatch_count=$7,dispatched_at=$8,rate_wait_ms=$9,provider_latency_ms=$10,failure_code=$11,
 finished_at=clock_timestamp(),lease_until=NULL,quota_state=$12,quota_reserved_tokens=0,quota_debit_tokens=$13,quota_settlement_digest=$14
 WHERE id=$1 AND worker_id=$2 AND status IN ('pending','interrupted')`,[id,worker,value.status,value.inputTokens,value.outputTokens,value.latencyMs,value.dispatchCount??null,
            value.dispatchedAt??null,value.rateWaitMs??null,value.providerLatencyMs??null,value.failureCode??null,state,debit.toString(),digest]);
        return true;
    });
}
