import { beforeEach, describe, expect, it, vi } from 'vitest';
import bffApi from '../bff';

const transport = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../base', () => ({ default: transport }));

describe('BFF RAG operations', () => {
    beforeEach(() => vi.resetAllMocks());

    it.each(['bootstrapRag', 'restoreLocalRag'] as const)(
        '%s rejects unsuccessful HTTP 200 receipts',
        async (operation) => {
            transport.post.mockResolvedValue({ data: { ok: false, error: 'incomplete-source' } });
            await expect(bffApi[operation]('project/one')).rejects.toThrow('локальные данные сохранены');
        },
    );

    it.each([
        ['bootstrapRag', '/api/rag/bootstrap'],
        ['restoreLocalRag', '/api/rag/restore-local'],
    ] as const)('%s sends the project key without losing path characters', async (operation, endpoint) => {
        const receipt = { ok: true };
        transport.post.mockResolvedValue({ data: receipt });
        await expect(bffApi[operation]('project/one')).resolves.toEqual(receipt);
        expect(transport.post).toHaveBeenCalledWith(endpoint, { projectKey: 'project/one' });
    });

    it('preserves transport failures so the caller can offer retry', async () => {
        const failure = new Error('Bridge unavailable');
        transport.post.mockRejectedValue(failure);
        await expect(bffApi.bootstrapRag('project')).rejects.toBe(failure);
    });
});
