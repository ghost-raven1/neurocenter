import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { bridgeApi } from '../src/features/McpBridge/api';

vi.mock('../src/core/api/base',() => ({default:{post:vi.fn(async () => ({data:{}})),get:vi.fn(async () => ({data:[]})),delete:vi.fn(async () => ({data:{}}))}}));
describe('API новых локальных действий сохраняет согласованную идентичность',() => {
    beforeEach(() => vi.clearAllMocks());
    it.each([['jobs','/api/device-jobs'],['installations','/api/device-installations']] as const)('Ограничивает ожидание списка %s, чтобы мастер освобождался при зависшем запросе',async (method,url) => {
        await bridgeApi[method]();
        expect(api.get).toHaveBeenCalledExactlyOnceWith(url,{timeout:10000});
    });
    it('Отмена ожидающего задания имеет ограниченное ожидание',async () => {
        await bridgeApi.cancel('job/1');
        expect(api.delete).toHaveBeenCalledExactlyOnceWith('/api/device-jobs/job%2F1',{timeout:10000});
    });
    it.each(['prepare-bind-project','bind-project'] as const)('Передаёт %s вместе с mode и ожидаемым экземпляром',async kind => {
        const input = {kind,deviceId:'device',projectId:'project',folderName:'Копия',bindingMode:'transfer' as const,expectedBindingId:'a'.repeat(64),
            expectedInstanceId:'11111111-1111-1111-1111-111111111111',preparationJobId:'prepare',expectedPreparation:'b'.repeat(64),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
    });
    it.each(['prepare-local-change','apply-local-change','open-local-change-report','probe-runtime'] as const)('Передаёт %s без замены root SHA на head',async kind => {
        const input = {kind,deviceId:'device',projectId:'project',assetId:'tool',assetKind:'mcp',expectedBindingId:'a'.repeat(64),expectedManifest:'b'.repeat(64),
            changePlanId:'plan',changePlanRevision:1,expectedChangeDigest:'c'.repeat(64),consentManifest:'d'.repeat(64),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
    });
    it('Открытие резервных копий не запрашивает инструмент, approval или план ремонта',async () => {
        const input = {kind:'open-local-recovery-folder' as const,deviceId:'device',projectId:'project',expectedBindingId:'a'.repeat(64),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
    });
    it.each(['prepare-mcp-configuration','get-mcp-configuration-status','open-mcp-configuration'] as const)('Передаёт %s без значений настройки и локальной ссылки',async kind => {
        const input = {kind,deviceId:'device',projectId:'project',assetId:'tool',assetKind:'mcp' as const,version:2,expectedBindingId:'a'.repeat(64),expectedManifest:'b'.repeat(64),
            ...(kind === 'open-mcp-configuration' ? {configurationPreparationJobId:'prepare-job',expectedConfigurationSchemaDigest:'c'.repeat(64)} : {}),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
        expect(JSON.stringify(input)).not.toContain('values'); expect(JSON.stringify(input)).not.toContain('127.0.0.1');
    });
    it('Диагностика передаёт ревизии всего графа без секретов, включая optional-настройку без сохранённых значений',async () => {
        const input = {kind:'probe-runtime' as const,deviceId:'device',projectId:'project',assetId:'skill',assetKind:'skill',
            expectedBindingId:'a'.repeat(64),expectedManifest:'b'.repeat(64),consentManifest:'c'.repeat(64),expectedConfigurationRevisions:[
                {assetId:'mcp-a',manifest:'d'.repeat(64),revision:'11111111-1111-1111-1111-111111111111'},
                {assetId:'mcp-b',manifest:'e'.repeat(64),revision:null}],requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
    });
    it('Поиск закрепляет только выбранный проект и его binding, без произвольного пути',async () => {
        const input={kind:'scan-project-inventory' as const,deviceId:'device',projectId:'project',expectedBindingId:'a'.repeat(64),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
    });
    it('Принятие закрепляет scan/candidate/digest и точный одобренный SET вместо root или head',async () => {
        const input={kind:'prepare-adopt-installation' as const,deviceId:'device',projectId:'project',assetId:'tool',assetKind:'mcp',version:2,
            planId:'approved-plan',planRevision:3,expectedManifest:'b'.repeat(64),expectedBindingId:'a'.repeat(64),inventoryJobId:'scan-job',
            scanId:'scan',candidateId:'candidate',expectedInventoryDigest:'c'.repeat(64),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
    });
    it.each(['list-local-variants','prepare-local-restore','apply-local-restore','apply-adopt-installation'] as const)('Передаёт %s без содержимого локальной копии',async kind => {
        const input={kind,deviceId:'device',projectId:'project',assetId:'tool',assetKind:'mcp',expectedBindingId:'a'.repeat(64),expectedManifest:'b'.repeat(64),
            ...(kind==='prepare-local-restore'?{recoveryId:'recovery',restorePaths:['.opencode/mcp-bundles/tool/index.js']}:{changePlanId:'plan',changePlanRevision:1,expectedChangeDigest:'c'.repeat(64)}),requestKey:'request'};
        await bridgeApi.create(input); expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/device-jobs',input,{timeout:10000});
        expect(JSON.stringify(input)).not.toContain('contents'); expect(JSON.stringify(input)).not.toContain('/Users/');
    });
});
