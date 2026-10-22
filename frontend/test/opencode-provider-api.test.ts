import {beforeEach, expect, it, vi} from 'vitest';
import api from '../src/core/api/base';
import {providerSetupApi} from '../src/features/OpenCodeProviders/api';
import {ack, preparationId, selection} from './opencode-provider.fixture';
vi.mock('../src/core/api/base', () => ({default: {post: vi.fn()}}));
beforeEach(() => vi.resetAllMocks());
it('Posts only the explicit public intent with a finite deadline and preserves the raw ACK for feature validation', async () => {
    const request = {...selection, kind: 'prepare-opencode-provider' as const, requestKey: preparationId}, result = ack(request);
    vi.mocked(api.post).mockResolvedValue({data: result}); expect(await providerSetupApi.create(request)).toBe(result);
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs', request, {timeout: 10000});
    expect(JSON.stringify(request)).not.toMatch(/baseUrl|credential|secret|apiKey/);
});
it('Preserves an unknown transport failure for exact-key recovery instead of inventing an accepted job', async () => {
    const error = new Error('lost ACK'); vi.mocked(api.post).mockRejectedValue(error);
    await expect(providerSetupApi.create({...selection, kind: 'get-opencode-provider-status', requestKey: preparationId})).rejects.toBe(error);
});
