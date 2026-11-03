import { useEffect, useRef, useState } from 'react';
import { useFeatureAvailability } from '../../FeatureFlags/hooks/useFeatureAvailability';
import { RAG_AUTO_CYCLE_COOLDOWN_MS, RAG_AUTO_CYCLE_MAX_ATTEMPTS, ragAutoCycleDecision } from '../ragAutoCycle';
import type { useProjectReindex } from './useProjectReindex';

export interface IRagAutoCycleState {
    /** Включён ли автоцикл (флаг). */
    enabled: boolean;
    /** Число запланированных/выполненных автоматических повторов текущего плана. */
    attempts: number;
    maxAttempts: number;
    /** Запланирован автоматический повтор (идёт пауза перед повтором). */
    scheduled: boolean;
    /** Лимит повторов исчерпан — повтор только вручную. */
    exhausted: boolean;
}

/**
 * Автоцикл базы знаний: после явного подтверждения пересборки локальный шаг
 * плана (переиндексация + синхронизация) доводится автоматически. Каждый повтор
 * вызывает то же серверное действие, что и ручная кнопка «Повторить подключение
 * компьютера», но с ограничением по числу попыток и паузой между ними.
 * Флаг выключен — без запросов и без побочных эффектов.
 */
export function useRagAutoCycle(reindex: ReturnType<typeof useProjectReindex>): IRagAutoCycleState {
    const { enabled: flagEnabled } = useFeatureAvailability('rag_auto_cycle');
    const plan = reindex.plan;
    const planId = plan?.id;
    const [attemptsByPlan, setAttemptsByPlan] = useState<Record<string, number>>({});
    const [scheduledPlanId, setScheduledPlanId] = useState<string | null>(null);
    const latestReindex = useRef(reindex);
    latestReindex.current = reindex;
    const attempts = planId ? (attemptsByPlan[planId] ?? 0) : 0;
    const decision = ragAutoCycleDecision({
        flagEnabled,
        plan,
        attempts,
        maxAttempts: RAG_AUTO_CYCLE_MAX_ATTEMPTS,
    });
    const scheduled = planId !== undefined && scheduledPlanId === planId;
    useEffect(() => {
        if (!planId || decision.action !== 'retryLocal' || scheduledPlanId === planId) return;
        setScheduledPlanId(planId);
        // Попытка считается при исполнении, а не при планировании: отменённый
        // таймер (смена плана, StrictMode) не расходует слот лимита.
        const timer = setTimeout(() => {
            setScheduledPlanId(null);
            setAttemptsByPlan((previous) => ({ [planId]: (previous[planId] ?? 0) + 1 }));
            void latestReindex.current.retryLocal();
        }, RAG_AUTO_CYCLE_COOLDOWN_MS);
        return () => {
            clearTimeout(timer);
            setScheduledPlanId((current) => (current === planId ? null : current));
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flagEnabled, planId, plan?.state, plan?.local?.state]);
    return {
        enabled: flagEnabled,
        attempts,
        maxAttempts: RAG_AUTO_CYCLE_MAX_ATTEMPTS,
        scheduled,
        exhausted: decision.reason === 'at-cap',
    };
}
