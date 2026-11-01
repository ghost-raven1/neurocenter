import { file, request, jobId, writeStatus } from './rebuild-files.fixture';
import { describe, expect, it } from 'vitest';
import { readCatalogRebuildState } from '../catalog-rebuild-state';

const status = (identifiers: unknown) => ({
    ...request,
    updatedAt: request.requestedAt,
    state: 'attention',
    items: [{ id: 'mcp-example', name: 'Example', message: 'Failed', state: 'attention', ...(identifiers as object) }],
});
describe('retained catalog rebuild receipt validation', () => {
    it.each([{ operationId: jobId }, { operationId: `tool-build-${jobId}` }, { importId: jobId }, {}])(
        'reads compatible receipt %j',
        async (identifiers) => {
            const saved = status(identifiers);
            writeStatus(saved);
            expect(await readCatalogRebuildState(file)).toEqual(saved);
        },
    );
    it.each([
        { operationId: '../secret' },
        { importId: 123 },
        { importId: `tool-build-${jobId}` },
        { operationId: [] },
    ])('rejects malformed recovery identifiers %j', async (identifiers) => {
        writeStatus(status(identifiers));
        expect(await readCatalogRebuildState(file)).toMatchObject({ state: 'attention', items: [] });
    });
});
