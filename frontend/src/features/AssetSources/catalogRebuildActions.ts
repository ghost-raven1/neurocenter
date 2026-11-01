import { sourcePlanPreparation } from './sourcePlanPreparation';
import type { IBundledSourcePlan, ICatalogRebuildItem } from './interfaces';

export interface ICatalogRebuildAction {
    kind: 'operation' | 'import' | 'prepare' | 'archive';
    label: string;
    href: string;
}

/** Recovery opens the accepted operation before offering a separate preparation request. */
export function catalogRebuildAction(
    item: ICatalogRebuildItem,
    plans: readonly IBundledSourcePlan[] = [],
): ICatalogRebuildAction | undefined {
    if (item.state === 'ready') return;
    const importId = item.importId ?? (item.id.startsWith('inline:') ? item.operationId : undefined);
    if (importId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(importId)) {
        return {
            kind: 'import',
            label: 'Открыть импорт',
            href: '/assets?' + new URLSearchParams({ recoverImport: importId }),
        };
    }
    if (item.operationId && !item.id.startsWith('inline:')) {
        // Earlier rebuild receipts stored the build UUID rather than its operations identifier.
        const operation = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.operationId)
            ? 'tool-build-' + item.operationId
            : item.operationId;
        return {
            kind: 'operation',
            label: 'Открыть операцию',
            href: '/operations?' + new URLSearchParams({ operation }),
        };
    }
    if (item.state === 'archive-required')
        return { kind: 'archive', label: 'Импортировать архив', href: '/assets?archive=open' };
    const plan = plans.find((value) => value.id === item.id);
    const preparation = plan ? sourcePlanPreparation(plan) : undefined;
    if (
        item.state === 'attention' &&
        plan &&
        !plan.catalogReady &&
        preparation?.available &&
        ['mcp', 'plugin'].includes(plan.kind)
    ) {
        return {
            kind: 'prepare',
            label: preparation.label,
            href: '/assets?' + new URLSearchParams({ prepare: plan.id }),
        };
    }
}
