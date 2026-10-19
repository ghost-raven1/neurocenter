import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device, DeviceStore } from '../src/devices/device-store';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';
import { buildPackage } from '../src/catalog/bundle-package';
import { projectLocalJobPayload } from '../src/devices/project-local-jobs';

describe('Принятие установки закрепляет назначение и источник плана',()=>{
    const pkg=buildPackage({id:'skill-id',kind:'skill',name:'test-skill',version:1},[{path:'SKILL.md',content:'---\nname: test-skill\n---\nИнструкция'}],'now');
    const bindingId='b'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111';
    const scanId='22222222-2222-4222-8222-222222222222',candidateId='33333333-3333-4333-8333-333333333333';
    const inventoryJobId='44444444-4444-4444-8444-444444444444',planId='55555555-5555-4555-8555-555555555555';
    const changePlanId='66666666-6666-4666-8666-666666666666';
    const query=vi.fn();const delivery=vi.fn();const inspectionDelivery=vi.fn();
    const store={pool:{query}} as unknown as DeviceStore;
    const plans={delivery} as unknown as InstallPlans;
    const installations={inspectionDelivery} as unknown as DeviceInstallations;
    let device:Device,inventory:Record<string,unknown>,saved:Record<string,unknown>;
    const input={deviceId:'device',projectId:'project',kind:'apply-adopt-installation',requestKey:'request',
        assetId:pkg.plugin.id,assetKind:'skill',expectedManifest:pkg.manifest.sha256,expectedBindingId:bindingId,
        changePlanId,changePlanRevision:1,expectedChangeDigest:'c'.repeat(64)};
    beforeEach(()=>{
        const checkedAt=new Date().toISOString();
        // Время округляется одинаково, чтобы фиксированный TTL оставался точным.
        const until=new Date(Date.parse(checkedAt)+15*60000).toISOString();
        device={id:'device',email:'owner@example.test',role:'Главный админ',report:{protocolVersion:2,capabilities:['workspace-instance-v1','package-v4','adopt-installation-v1'],
            bindings:[{projectId:'project',bindingId,instanceId,valid:true}]}} as Device;
        inventory={schemaVersion:1,projectId:'project',bindingId,instanceId,scanId,digest:'d'.repeat(64),checkedAt,expiresAt:until,complete:true,issues:[],
            entries:[{candidateId,kind:'skill',path:'.opencode/skills/test-skill',state:'unmanaged',reason:'unmanaged-files'}]};
        saved={purpose:'adopt',digest:input.expectedChangeDigest,revision:1,binding_id:bindingId,instance_id:instanceId,
            source_payload:{package:pkg,bindingId,instanceId,assetId:pkg.plugin.id,assetKind:'skill',version:1,planId,planRevision:1,inventoryJobId,scanId,candidateId,expectedInventoryDigest:'d'.repeat(64)},
            summary:{schemaVersion:1,planId:changePlanId,revision:1,digest:input.expectedChangeDigest,projectId:'project',bindingId,instanceId,
                assetId:pkg.plugin.id,assetKind:'skill',version:1,manifest:pkg.manifest.sha256,checkedAt,expiresAt:until,status:'prepared',files:[]}};
        query.mockReset();delivery.mockReset();inspectionDelivery.mockReset();delivery.mockResolvedValue({package:pkg});
        query.mockImplementation(async(sql:string)=>({rows:sql.includes('JOIN bridge_jobs')?[saved]:sql.includes('SELECT result')?[{result:inventory}]:[]}));
    });
    it('Берёт точное одобрение из подготовки и сохраняет идентификатор источника',async()=>{
        const result=await projectLocalJobPayload(store,installations,plans,device,input);
        expect(result).toMatchObject({package:pkg,localPlanPurpose:'adopt',changePlanId,scanId,candidateId,bindingId,instanceId});
        expect(delivery).toHaveBeenCalledWith(planId,'project','skill',pkg.plugin.id,1,1,pkg.manifest.sha256);
    });
    it('Не позволяет использовать план принятия для возврата ручных правок',async()=>{
        await expect(projectLocalJobPayload(store,installations,plans,device,{...input,kind:'apply-local-restore'})).rejects.toMatchObject({status:409});
        expect(delivery).not.toHaveBeenCalled();
    });
    it.each([{complete:false},{digest:'f'.repeat(64)},{expiresAt:'2020-01-01T00:15:00.000Z',checkedAt:'2020-01-01T00:00:00.000Z'}])('Не принимает неполный, изменённый или просроченный источник: %j',async changed=>{
        inventory={...inventory,...changed};await expect(projectLocalJobPayload(store,installations,plans,device,input)).rejects.toMatchObject({status:409});
    });
    it('Проверяет экземпляр и capability до передачи файлов устройству',async()=>{
        device.report.capabilities=[];
        await expect(projectLocalJobPayload(store,installations,plans,device,input)).rejects.toMatchObject({status:409});
        expect(delivery).not.toHaveBeenCalled();
    });
});
