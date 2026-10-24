import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ragUiJobPayload,assertRagUiJob} from '../src/devices/rag-ui-jobs';
import type {Device} from '../src/devices/device-store';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';
import type {JobInput} from '../src/devices/device-job.model';

describe('Управляемый интерфейс RAG проверяет установленный комплект на каждом шаге',()=>{
    const bindingId='b'.repeat(64),instanceId='11111111-1111-4111-8111-111111111111',manifest='a'.repeat(64);
    const pkg={schemaVersion:5,plugin:{id:'rag',kind:'plugin',version:2},config:{extra:{runtimeArtifacts:[{sha256:'c'.repeat(64)}],
        localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']}}},manifest:{sha256:manifest}};
    const device={id:'device',email:'owner@example.test',role:'Разработчик',report:{capabilities:['workspace-instance-v1','opencode-rag-ui-v1','package-v5'],
        bindings:[{projectId:'project',bindingId,instanceId}]}} as unknown as Device;
    const input:JobInput={deviceId:'device',projectId:'project',kind:'open-rag-ui',requestKey:instanceId,assetId:'rag',assetKind:'plugin',version:2,expectedManifest:manifest,expectedBindingId:bindingId,expectedInstanceId:instanceId};
    const inspectionPackage=vi.fn(),approvedConfiguration=vi.fn(),delivery=vi.fn();
    const installations={inspectionPackage} as unknown as DeviceInstallations;
    const plans={approvedConfiguration,delivery} as unknown as InstallPlans;
    beforeEach(()=>{vi.clearAllMocks();inspectionPackage.mockResolvedValue(pkg);approvedConfiguration.mockResolvedValue({package:pkg,planId:'plan',planRevision:1,approvalRoot:{kind:'plugin',id:'rag',version:2},approvalManifest:manifest});delivery.mockResolvedValue({package:pkg});});
    it('Использует точный установленный SHA и одобрение leaf внутри набора',async()=>{
        const payload=await ragUiJobPayload(installations,plans,device,input);
        expect(payload).toMatchObject({package:pkg,bindingId,instanceId,version:2});
        expect(inspectionPackage).toHaveBeenCalledWith({email:device.email,activeRole:device.role},expect.objectContaining({expectedManifest:manifest,bindingId}));
        await assertRagUiJob(installations,plans,device,{kind:'open-rag-ui',project_id:'project',payload:payload!});
        expect(delivery).toHaveBeenCalledWith('plan','project','plugin','rag',2,1,manifest);
    });
    it.each([{expectedBindingId:'d'.repeat(64)},{expectedInstanceId:'other'},{version:1},{assetKind:'skill'},{command:'rm -rf'}])('Не принимает устаревший tuple или произвольную команду %j',async changed=>{
        await expect(ragUiJobPayload(installations,plans,device,{...input,...changed})).rejects.toBeDefined();
    });
    it('Не запускает UI старого моста или старой версии без metadata',async()=>{
        await expect(ragUiJobPayload(installations,plans,{...device,report:{...device.report,capabilities:['workspace-instance-v1']}},input)).rejects.toHaveProperty('status',409);
        inspectionPackage.mockResolvedValue({...pkg,config:null});await expect(ragUiJobPayload(installations,plans,device,input)).rejects.toHaveProperty('status',409);
    });
    it('A valid core-only package cannot authorize opening a UI',async()=>{
        const {localUi,...extra}=pkg.config.extra;inspectionPackage.mockResolvedValue({...pkg,config:{extra:{...extra,
            ragCore:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'},hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}}}});
        await expect(ragUiJobPayload(installations,plans,device,input)).rejects.toHaveProperty('status',409);expect(approvedConfiguration).not.toHaveBeenCalled();
    });
    it('Отозванное одобрение и обновлённая установка блокируются до выдачи или запуска',async()=>{
        const payload=await ragUiJobPayload(installations,plans,device,input);
        delivery.mockRejectedValueOnce(new Error('отозвано'));await expect(assertRagUiJob(installations,plans,device,{kind:'open-rag-ui',project_id:'project',payload:payload!})).rejects.toThrow('отозвано');
        inspectionPackage.mockResolvedValue({...pkg,plugin:{...pkg.plugin,version:3}});await expect(assertRagUiJob(installations,plans,device,{kind:'open-rag-ui',project_id:'project',payload:payload!})).rejects.toHaveProperty('status',409);
    });
});
