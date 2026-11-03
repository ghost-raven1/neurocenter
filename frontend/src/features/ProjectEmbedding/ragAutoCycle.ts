import type { IProjectReindexPlan } from './reindex';

export const RAG_AUTO_CYCLE_MAX_ATTEMPTS = 3;
export const RAG_AUTO_CYCLE_COOLDOWN_MS = 10000;

export type TRagAutoCycleAction = 'retryLocal' | 'none';
export type TRagAutoCycleReason =
    'flag-off' | 'no-plan' | 'not-applied' | 'no-local-step' | 'local-not-failed' | 'at-cap' | 'local-failed';

/**
 * Автоцикл базы знаний: после явного подтверждения пересборки локальный шаг
 * плана (переиндексация + синхронизация) доводится автоматически. Повторяем
 * только неудачу локального шага при уже применённом серверном поколении;
 * серверный отказ плана, успех и исчерпанный лимит остаются на ручном повторе.
 */
export function ragAutoCycleDecision(input: {
    flagEnabled: boolean;
    plan?: IProjectReindexPlan;
    attempts: number;
    maxAttempts?: number;
}): { action: TRagAutoCycleAction; reason: TRagAutoCycleReason } {
    if (!input.flagEnabled) return { action: 'none', reason: 'flag-off' };
    const plan = input.plan;
    if (!plan) return { action: 'none', reason: 'no-plan' };
    if (plan.state !== 'applied') return { action: 'none', reason: 'not-applied' };
    if (!plan.local) return { action: 'none', reason: 'no-local-step' };
    if (!['failed', 'cancelled'].includes(plan.local.state)) return { action: 'none', reason: 'local-not-failed' };
    if (input.attempts >= (input.maxAttempts ?? RAG_AUTO_CYCLE_MAX_ATTEMPTS))
        return { action: 'none', reason: 'at-cap' };
    return { action: 'retryLocal', reason: 'local-failed' };
}
