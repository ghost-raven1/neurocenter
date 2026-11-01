import { expect, it } from 'vitest';
import { sourcePlanPreparation } from '../sourcePlanPreparation';
import type { IBundledSourcePlan } from '../interfaces';
const plan: IBundledSourcePlan = {
    id: 'recipe',
    name: 'Recipe',
    description: '',
    kind: 'plugin',
    delivery: 'prepared',
    sourceRevision: 'application',
    revision: 'a'.repeat(64),
};
it.each(['prepared', 'local-project'])('offers preparation for %s recipes', (delivery) => {
    expect(sourcePlanPreparation({ ...plan, delivery })).toEqual({ label: 'Подготовить пакет', available: true });
});
it.each(['archived', 'unavailable'] as const)('blocks replacement of %s published assets', (reason) => {
    expect(
        sourcePlanPreparation({
            ...plan,
            imported: { id: 'catalog', version: 1, originVersion: 'old', updateAvailable: true, [reason]: true },
        }),
    ).toEqual({ label: 'Подготовить обновление', available: false });
});
it('does not promise preparation for an archive-only source', () => {
    expect(sourcePlanPreparation({ ...plan, delivery: 'archive' })).toBeUndefined();
});
