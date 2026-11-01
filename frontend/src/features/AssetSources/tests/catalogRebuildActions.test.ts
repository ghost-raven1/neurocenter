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
