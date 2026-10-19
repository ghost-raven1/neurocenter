import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { featureFlagsApi } from '../src/features/FeatureFlags/api';

vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn(), patch: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue({ data: {} }); vi.mocked(api.patch).mockResolvedValue({ data: {} }); });
describe('API функций платформы', () => {
    it('Разделяет административный список и доступные текущей сессии значения', async () => {
        await featureFlagsApi.list(); await featureFlagsApi.evaluated();
        expect(api.get).toHaveBeenNthCalledWith(1, '/api/feature-flags');
        expect(api.get).toHaveBeenNthCalledWith(2, '/api/feature-flags/evaluated');
    });
    it('Отправляет явное булево значение и исходную ревизию', async () => {
        await featureFlagsApi.update('model_hosting', false, 7);
        expect(api.patch).toHaveBeenCalledWith('/api/feature-flags/model_hosting', { enabled: false, expectedRevision: 7 });
    });
});
