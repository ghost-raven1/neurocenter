import { describe, expect, it } from 'vitest';
import { catalogRebuildAction } from '../catalogRebuildActions';
import type { ICatalogRebuildItem } from '../interfaces';

const id = '11111111-1111-4111-8111-111111111111';
const item: ICatalogRebuildItem = { id: 'inline:0', name: 'Inline', state: 'attention', message: 'Failed' };

describe('catalog rebuild recovery destinations', () => {
    it.each([{ importId: id }, { operationId: id }])(
        'opens the accepted inline import from new or old receipt',
        (receipt) => {
            expect(catalogRebuildAction({ ...item, ...receipt })).toEqual({
                kind: 'import',
                label: 'Открыть импорт',
                href: '/assets?recoverImport=' + id,
            });
        },
    );
    it.each([id, 'tool-build-' + id])('opens the canonical build operation from new or old receipt', (operationId) => {
        expect(catalogRebuildAction({ ...item, id: 'recipe', operationId })?.href).toBe(
            '/operations?operation=tool-build-' + id,
        );
    });
    it('does not invent an operation for an invalid inline receipt or an already ready result', () => {
        expect(catalogRebuildAction({ ...item, operationId: 'unknown' })).toBeUndefined();
        expect(catalogRebuildAction({ ...item, importId: id, state: 'ready' })).toBeUndefined();
    });
});

const source: import('../interfaces').IBundledSourcePlan = {
    id: 'recipe',
    name: 'Recipe',
    kind: 'mcp',
    delivery: 'prepared',
    description: '',
    sourceRevision: 'application',
    revision: 'a'.repeat(64),
};
it('shares recipe preparation while keeping recovery and published-result priority', () => {
    const attention = { ...item, id: 'recipe' };
    expect(catalogRebuildAction(attention, [source])).toEqual({
        kind: 'prepare',
        label: 'Подготовить пакет',
        href: '/assets?prepare=recipe',
    });
    expect(catalogRebuildAction({ ...attention, operationId: id }, [source])?.kind).toBe('operation');
    expect(catalogRebuildAction(attention, [{ ...source, catalogReady: true }])).toBeUndefined();
    expect(catalogRebuildAction({ ...attention, state: 'archive-required' }, [source])?.kind).toBe('archive');
});
it.each(['model', 'bridge'] as const)('does not expand rebuild preparation support to %s', (kind) => {
    expect(catalogRebuildAction({ ...item, id: 'recipe' }, [{ ...source, kind }])).toBeUndefined();
});
it.each(['archived', 'unavailable'] as const)('does not offer a new rebuild for %s publication', (reason) => {
    expect(
        catalogRebuildAction({ ...item, id: 'recipe' }, [
            {
                ...source,
                imported: { id: 'catalog', version: 1, originVersion: 'old', updateAvailable: true, [reason]: true },
            },
        ]),
    ).toBeUndefined();
});
