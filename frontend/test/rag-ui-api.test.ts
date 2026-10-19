import { describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { bridgeApi } from '../src/features/McpBridge/api';
import { ragUiRequest } from '../src/features/McpBridge/ragUi/ragUiState';
import { ragUiFixture } from './ragUiFixture';

vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn(async () => ({ data: {} })) } }));
describe('Контракт открытия OpenCodeRAG через мост', () => {
    it('Отправляет закреплённые версию, SHA, binding и instance без локального URL или пути', async () => {
        const { item, binding } = ragUiFixture(), input = { ...ragUiRequest(item, binding), requestKey: 'request-one' };
        await bridgeApi.create(input);
        expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs', input, { timeout: 10000 });
        expect(Object.keys(input).sort()).toEqual(['kind', 'deviceId', 'projectId', 'assetId', 'assetKind', 'version',
            'expectedManifest', 'expectedBindingId', 'expectedInstanceId', 'requestKey'].sort());
    });
});
