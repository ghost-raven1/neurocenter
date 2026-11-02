import { describe, expect, it } from 'vitest';
import { isBatchReadyPlan } from '../batchUpdate';
import type { IBundledSourcePlan } from '../interfaces';

const plan = (overrides: Partial<IBundledSourcePlan> = {}): IBundledSourcePlan => ({
    id: 'recipe',
    name: 'Recipe',
    kind: 'mcp',
    delivery: 'prepared',
    description: '',
    sourceRevision: 'application',
    revision: 'a'.repeat(64),
    ...overrides,
});

describe('batch update eligibility', () => {
    it.each(['mcp', 'plugin'] as const)('includes a ready %s recipe with local delivery', (kind) => {
        expect(isBatchReadyPlan(plan({ kind }))).toBe(true);
    });
    it('includes a local-project delivery', () => {
        expect(isBatchReadyPlan(plan({ delivery: 'local-project' }))).toBe(true);
    });
    it.each(['model', 'bridge'] as const)('does not include a %s recipe', (kind) => {
        expect(isBatchReadyPlan(plan({ kind }))).toBe(false);
    });
    it('does not include a recipe that is already in the catalog', () => {
        expect(isBatchReadyPlan(plan({ catalogReady: true }))).toBe(false);
    });
    it.each(['remote', 'git'] as const)('does not include a %s delivery', (delivery) => {
        expect(isBatchReadyPlan(plan({ delivery }))).toBe(false);
    });
    it.each(['archived', 'unavailable'] as const)('does not include a %s publication', (reason) => {
        expect(
            isBatchReadyPlan(
                plan({
                    imported: { id: 'catalog', version: 1, originVersion: 'old', updateAvailable: true, [reason]: true },
                }),
            ),
        ).toBe(false);
    });
    it('includes a publication with an available update', () => {
        expect(
            isBatchReadyPlan(plan({ imported: { id: 'catalog', version: 1, originVersion: 'old', updateAvailable: true } })),
        ).toBe(true);
    });
});
