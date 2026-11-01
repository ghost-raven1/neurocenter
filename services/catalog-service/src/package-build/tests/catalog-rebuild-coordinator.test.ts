import { file, request, jobId } from './rebuild-files.fixture';
import { describe, expect, it, vi } from 'vitest';
import { CatalogRebuildCoordinator, type ICatalogRebuildDependencies } from '../catalog-rebuild-coordinator';
import { readCatalogRebuildState } from '../catalog-rebuild-state';

const missing = () => Object.assign(new Error('not found'), { getStatus: () => 404 });
function dependencies(): ICatalogRebuildDependencies {
    return {
        file,
        actor: () => ({ email: 'owner', activeRole: 'Главный админ' }),
        authorize: vi.fn(async () => undefined),
        bundle: vi.fn(async () => ({ revision: request.sourceRevision, commit: 'commit', inlineIds: [] })),
        plans: vi.fn(async () => [
            {
                id: 'mcp-example',
                kind: 'mcp',
                name: 'Example',
                description: 'Saved',
                revision: request.sourceRevision,
                delivery: 'prepared',
            },
        ]),
        refresh: vi.fn(async () => undefined),
        target: vi.fn(async () => ({ name: 'Example' })),
        build: {
            request: vi.fn(async () => {
                throw missing();
            }),
            create: vi.fn(async () => ({ id: jobId, state: 'RUNNING' })),
        },
        inline: {
            request: vi.fn(async () => {
                throw missing();
            }),
            create: vi.fn(async () => ({ id: jobId, state: 'FAILED' })),
        },
    };
}

describe('catalog rebuild recovery receipts', () => {
    it.each([undefined, `tool-build-${jobId}`])(
        'links builds to canonical operation for receipt %s',
        async (operationId) => {
            const deps = dependencies();
            vi.mocked(deps.build.create).mockResolvedValue({ id: jobId, state: 'RUNNING', operationId });
            await new CatalogRebuildCoordinator(deps).tick();
            expect((await readCatalogRebuildState(file))?.items[0]).toMatchObject({
                operationId: `tool-build-${jobId}`,
            });
            expect((await readCatalogRebuildState(file))?.items[0]).not.toHaveProperty('importId');
        },
    );
    it('links inline imports to the retained import journal, never a made-up operation', async () => {
        const deps = dependencies();
        vi.mocked(deps.bundle).mockResolvedValue({
            revision: request.sourceRevision,
            commit: 'commit',
            inlineIds: ['agent-example'],
        });
        vi.mocked(deps.plans).mockResolvedValue([]);
        await new CatalogRebuildCoordinator(deps).tick();
        const item = (await readCatalogRebuildState(file))?.items[0];
        expect(item).toMatchObject({ importId: jobId, state: 'attention' });
        expect(item).not.toHaveProperty('operationId');
    });
    it.each(['build', 'inline'] as const)(
        'reconciles a lost %s ACK using the original request without resubmission',
        async (kind) => {
            const deps = dependencies();
            if (kind === 'inline') {
                vi.mocked(deps.bundle).mockResolvedValue({
                    revision: request.sourceRevision,
                    commit: 'commit',
                    inlineIds: ['agent-example'],
                });
                vi.mocked(deps.plans).mockResolvedValue([]);
            }
            const endpoint = deps[kind];
            vi.mocked(endpoint.request)
                .mockRejectedValueOnce(missing())
                .mockResolvedValue({ id: jobId, state: 'RUNNING' });
            vi.mocked(endpoint.create).mockRejectedValue(new Error('response lost after durable admission'));
            const coordinator = new CatalogRebuildCoordinator(deps);
            await coordinator.tick();
            await coordinator.tick();
            expect(endpoint.create).toHaveBeenCalledTimes(1);
            expect(endpoint.request).toHaveBeenCalledTimes(2);
            expect(vi.mocked(endpoint.request).mock.calls[0][1]).toBe(vi.mocked(endpoint.request).mock.calls[1][1]);
            expect((await readCatalogRebuildState(file))?.items[0]?.state).toBe('pending');
        },
    );
    it('keeps unknown lookup results unresolved without a new create', async () => {
        const deps = dependencies();
        vi.mocked(deps.build.request).mockRejectedValue(new Error('database unavailable'));
        await new CatalogRebuildCoordinator(deps).tick();
        expect(deps.build.create).not.toHaveBeenCalled();
        expect((await readCatalogRebuildState(file))?.items[0]?.state).toBe('attention');
    });
});
