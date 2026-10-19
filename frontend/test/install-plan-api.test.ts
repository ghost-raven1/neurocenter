import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { bridgeApi } from '../src/features/McpBridge/api';

vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn(async () => ({ data: {} })), get: vi.fn(async () => ({ data: {} })) } }));

describe('Контракт API разрешения установки', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('Перечитывает тот же план через GET без новой подготовки', async () => {
        await bridgeApi.plan('plan/1');
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/device-install-plans/plan%2F1');
        expect(api.post).not.toHaveBeenCalled();
    });

    it('Подготавливает выбранную версию в конкретном проекте', async () => {
        const input = { projectId: 'project-1', assetKind: 'skill' as const, assetId: 'common/helper', version: 3 };
        await bridgeApi.preparePlan(input);
        expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-install-plans', input);
    });

    it.each(['approvePlan', 'revokePlan'] as const)('Защищает %s ожидаемым манифестом и ревизией', async action => {
        await bridgeApi[action]({ id: 'plan/1', manifest: 'a'.repeat(64), revision: 0 });
        expect(api.post).toHaveBeenCalledExactlyOnceWith(`/api/device-install-plans/plan%2F1/${action === 'approvePlan' ? 'approve' : 'revoke'}`,
            { expectedManifest: 'a'.repeat(64), expectedRevision: 0 });
    });

    it('Передаёт в очередь идентичность одобренного состояния плана', async () => {
        const input = { deviceId: 'computer', projectId: 'project', kind: 'install' as const, requestKey: 'request', planId: 'plan', planRevision: 3 };
        await bridgeApi.create(input);
        expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs', input,{timeout:10000});
    });
});
