import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { bridgeApi } from '../src/features/McpBridge/api';

vi.mock('../src/core/api/base',()=>({default:{post:vi.fn(async()=>({data:{}}))}}));
describe('API проверки привязанной установки',()=>{
    beforeEach(()=>{vi.clearAllMocks();});
    it.each(['inspect-installation','uninstall'] as const)('Передаёт точную привязку без подстановки текущей папки: %s',async kind=>{
        const input={kind,deviceId:'device',projectId:'project',assetId:'ai-plug-helper',assetKind:'mcp',expectedManifest:'a'.repeat(64),expectedBindingId:'b'.repeat(64),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input);
    });
});
