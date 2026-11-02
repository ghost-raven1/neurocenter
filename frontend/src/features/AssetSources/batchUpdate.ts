import { sourcePlanPreparation } from './sourcePlanPreparation';
import type { IBundledSourcePlan } from './interfaces';

/**
 * Позиция, которую серия «Обновить готовые» обработает: mcp/plugin-рецепт,
 * готовый к подготовке по локальной доставке. Зеркалит правило действия
 * «Подготовить обновление» на карточке и в квитанциях rebuild.
 */
export function isBatchReadyPlan(plan: IBundledSourcePlan): boolean {
    if (plan.catalogReady || !['mcp', 'plugin'].includes(plan.kind)) return false;
    return !!sourcePlanPreparation(plan)?.available;
}
