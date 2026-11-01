import type { IBundledSourcePlan } from './interfaces';
interface ISourcePlanPreparation {
    label: string;
    available: boolean;
}

/** Shared source eligibility; callers retain their own published-result and supported-kind priorities. */
export function sourcePlanPreparation(plan: IBundledSourcePlan): ISourcePlanPreparation | undefined {
    if (!['prepared', 'local-project'].includes(plan.delivery)) return;
    return {
        label: plan.imported ? 'Подготовить обновление' : 'Подготовить пакет',
        available: !plan.imported?.archived && !plan.imported?.unavailable,
    };
}
