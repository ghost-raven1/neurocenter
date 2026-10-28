import type {PoolClient} from 'pg';
import type {ModelTokenQuotaPolicy,ModelTokenQuotaCounters} from './model-token-quotas.types';

export interface QuotaBalance extends ModelTokenQuotaCounters {unpricedUnknownCalls:number;}
/** Active/unknown quota holds survive a period boundary; only authoritative settled charges age out. */
export async function quotaCounters(db:Pick<PoolClient,'query'>,policy:ModelTokenQuotaPolicy,clock:string,excludeId:string|null=null):Promise<QuotaBalance>{
    const row=(await db.query<{input:string|null;output:string|null;charged:string;active:string;held:string;unknown:string;unpriced:string;next:Date|string|null}>(`
WITH receipts AS (
 SELECT *,coalesce(quota_admitted_at,started_at) AS budget_at,
  quota_state IS NULL AND (input_tokens IS NULL OR output_tokens IS NULL)
   AND dispatch_count IS DISTINCT FROM 0 AS unpriced
 FROM model_usage_calls WHERE actor_email=$1 AND model_id=$2 AND ($5::uuid IS NULL OR id<>$5)
 AND coalesce(quota_admitted_at,started_at)>=(SELECT accounting_started_at FROM model_user_token_quotas WHERE user_email=$1 AND model_id=$2)
), visible AS (
 SELECT * FROM receipts WHERE quota_state IN ('reserved','dispatched','unknown') OR unpriced
 OR budget_at>$3::timestamptz-$4::bigint*interval '1 millisecond'
)
SELECT CASE WHEN count(*)>0 AND count(input_tokens)=0 THEN NULL ELSE coalesce(sum(input_tokens),0)::text END AS input,
 CASE WHEN count(*)>0 AND count(output_tokens)=0 THEN NULL ELSE coalesce(sum(output_tokens),0)::text END AS output,
 coalesce(sum(CASE WHEN quota_state='settled' THEN quota_debit_tokens
  WHEN quota_state IS NULL AND status<>'pending' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens::numeric+output_tokens ELSE 0 END),0)::text AS charged,
 coalesce(sum(CASE WHEN quota_state IN ('reserved','dispatched') THEN quota_reserved_tokens ELSE 0 END),0)::text AS active,
 coalesce(sum(CASE WHEN quota_state='unknown' THEN quota_debit_tokens ELSE 0 END),0)::text AS held,
 count(*) FILTER(WHERE quota_state='unknown' OR unpriced OR quota_state IS NULL AND status='pending' AND dispatch_count IS DISTINCT FROM 0)::text AS unknown,
 count(*) FILTER(WHERE unpriced)::text AS unpriced,
 min(budget_at+$4::bigint*interval '1 millisecond') FILTER(WHERE quota_state='settled' OR quota_state IS NULL AND NOT unpriced AND status<>'pending') AS next
FROM visible`,[policy.userEmail,policy.modelId,clock,policy.periodMs,excludeId])).rows[0];
    const charged=row?.charged??'0',active=row?.active??'0',held=row?.held??'0',spent=BigInt(charged)+BigInt(active)+BigInt(held),limit=BigInt(policy.tokenLimit);
    const knownActual=BigInt(row?.input??0)+BigInt(row?.output??0);
    return {actualInputTokens:row?row.input:'0',actualOutputTokens:row?row.output:'0',chargedTokens:charged,activeReservedTokens:active,
        unknownHeldTokens:held,unknownCalls:Number(row?.unknown??0),unpricedUnknownCalls:Number(row?.unpriced??0),
        remainingTokens:(spent<limit?limit-spent:0n).toString(),overrunTokens:(knownActual>limit?knownActual-limit:0n).toString(),
        nextBudgetChangeAt:row?.next?new Date(row.next).toISOString():null};
}
