import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostedRagJobPayload, assertHostedRagJob, assertHostedRagResult, supportsHostedRag } from '../src/devices/hosted-rag-jobs';
import type { Device } from '../src/devices/device-store';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';
import type { ProjectEmbeddingService } from '../src/models/project-embedding.service';
import type { JobInput } from '../src/devices/device-job.model';
import {DeviceJobs} from '../src/devices/device-jobs';

vi.mock('../src/features/require-feature-enabled', () => ({requireFeatureEnabled:vi.fn().mockResolvedValue(undefined)}));

describe('Подключение модели использует точный выбор проекта и одобренный OpenCodeRAG', () => {
    const bindingId='b'.repeat(64), pin='d'.repeat(64), manifest='a'.repeat(64), instanceId='11111111-1111-4111-8111-111111111111';
    const profile={provider:'openai',model:'neurocenter/model/sha256/'+pin,dimension:2560};
    const selection={projectId:'project',revision:3,expectedDimension:2560,model:{id:'model'},modelPin:pin,profile};
    const pkg={schemaVersion:5,plugin:{id:'rag',kind:'plugin',version:2},manifest:{sha256:manifest},
        config:{extra:{runtimeArtifacts:[{sha256:'c'.repeat(64)}],hostedEmbedding:{schemaVersion:1,reindexSchemaVersion:1},
            localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']}}}};
    const device={id:'device',email:'owner@example.test',role:'Разработчик',report:{capabilities:['workspace-instance-v1','opencode-rag-ui-v1','hosted-rag-model-v1','hosted-rag-grants-v1','hosted-rag-reindex-v1','hosted-rag-profile-values-v1','package-v5'],
        bindings:[{projectId:'project',bindingId,instanceId}]}} as unknown as Device;
    const input:JobInput={deviceId:'device',projectId:'project',kind:'connect-rag-model',requestKey:instanceId,assetId:'rag',assetKind:'plugin',version:2,
        expectedManifest:manifest,expectedBindingId:bindingId,expectedInstanceId:instanceId,expectedEmbeddingRevision:3,expectedEmbeddingPin:pin,reindex:true};
    const inspectionPackage=vi.fn(), approvedConfiguration=vi.fn(), delivery=vi.fn(), requireCurrent=vi.fn();
    const installations={inspectionPackage} as unknown as DeviceInstallations;
    const plans={approvedConfiguration,delivery} as unknown as InstallPlans;
    const embedding={requireCurrent} as unknown as ProjectEmbeddingService;
    beforeEach(() => {
        vi.clearAllMocks(); inspectionPackage.mockResolvedValue(pkg); requireCurrent.mockResolvedValue(selection);
        approvedConfiguration.mockImplementation(async (_project: string, installed: unknown) => ({package:installed,planId:'plan',planRevision:1,approvalRoot:{kind:'plugin',id:'rag',version:2},approvalManifest:manifest}));
        delivery.mockResolvedValue({package:pkg});
    });
    it('Закрепляет выбор, установленный SHA и одобрение без адресов и секретов', async () => {
        const payload=await hostedRagJobPayload(embedding,installations,plans,device,input);
        expect(payload).toMatchObject({package:pkg,bindingId,instanceId,embedding:selection});
        expect(requireCurrent).toHaveBeenCalledWith('project',3,pin);
        await assertHostedRagJob(embedding,installations,plans,device,{kind:input.kind,project_id:'project',payload:payload!});
        expect(delivery).toHaveBeenCalledWith('plan','project','plugin','rag',2,1,manifest);
    });
    it('Пакет с независимыми подключениями получает capability и проходит создание и повторную авторизацию задания', async () => {
        const independent = {...pkg, config: {extra: {...pkg.config.extra, hostedEmbedding: {schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}}}};
        inspectionPackage.mockResolvedValue(independent);delivery.mockResolvedValue({package:independent});
        expect(supportsHostedRag(independent)).toBe(true);
        const payload=await hostedRagJobPayload(embedding,installations,plans,device,input);
        expect(payload?.package).toEqual(independent);
        await expect(assertHostedRagJob(embedding,installations,plans,device,{kind:input.kind,project_id:'project',payload:payload!})).resolves.toBeUndefined();
        expect(requireCurrent).toHaveBeenCalledTimes(2);
    });
    it.each([{expectedEmbeddingRevision:0},{expectedEmbeddingRevision:1.5},{expectedEmbeddingPin:'invalid'},{url:'https://outside.example'},{apiKey:'private'}])('Отвергает неточный выбор и произвольные параметры %j', async changed => {
        await expect(hostedRagJobPayload(embedding,installations,plans,device,{...input,...changed})).rejects.toHaveProperty('status',400);
        expect(requireCurrent).not.toHaveBeenCalled();
    });
    it('Старый мост и пакет без явного адаптера не получают обещания подключения', async () => {
        await expect(hostedRagJobPayload(embedding,installations,plans,{...device,report:{...device.report,capabilities:['opencode-rag-ui-v1']}},input)).rejects.toHaveProperty('status',409);
        inspectionPackage.mockResolvedValue({...pkg,config:{extra:{...pkg.config.extra,hostedEmbedding:undefined}}});
        await expect(hostedRagJobPayload(embedding,installations,plans,device,input)).rejects.toHaveProperty('status',409);
        expect(requireCurrent).not.toHaveBeenCalled();
    });
    it('Отзыв выбора и одобрения повторно проверяется перед выполнением', async () => {
        const payload=await hostedRagJobPayload(embedding,installations,plans,device,input);
        requireCurrent.mockRejectedValueOnce(new Error('Выбор изменился'));
        await expect(assertHostedRagJob(embedding,installations,plans,device,{kind:input.kind,project_id:'project',payload:payload!})).rejects.toThrow('Выбор изменился');
        delivery.mockRejectedValueOnce(new Error('Одобрение отозвано'));
        await expect(assertHostedRagJob(embedding,installations,plans,device,{kind:input.kind,project_id:'project',payload:payload!})).rejects.toThrow('Одобрение отозвано');
    });
    it('Профиль той же размерности не подменяется незаметно', async () => {
        const payload=await hostedRagJobPayload(embedding,installations,plans,device,input);
        requireCurrent.mockResolvedValue({...selection,profile:{...profile,model:'another'}});
        await expect(assertHostedRagJob(embedding,installations,plans,device,{kind:input.kind,project_id:'project',payload:payload!})).rejects.toHaveProperty('status',409);
    });
    it('Мост без explicit grants не получает старый current-only обход',async()=>{
        const old={...device,report:{...device.report,capabilities:(device.report.capabilities as string[]).filter(value=>value!=='hosted-rag-grants-v1')}};
        await expect(hostedRagJobPayload(embedding,installations,plans,old,input)).rejects.toHaveProperty('status',409);
        expect(requireCurrent).not.toHaveBeenCalled();
    });
    it('Known bad0.9.12 reindex capability cannot create or authorize a profile-values job',async()=>{
        const payload=await hostedRagJobPayload(embedding,installations,plans,device,input);
        const old={...device,report:{...device.report,bridgeVersion:'0.9.12',capabilities:(device.report.capabilities as string[]).filter(value=>value!=='hosted-rag-profile-values-v1')}};
        requireCurrent.mockClear();inspectionPackage.mockClear();
        await expect(hostedRagJobPayload(embedding,installations,plans,old,input)).rejects.toMatchObject({status:409,message:expect.stringContaining('Обновите')});
        await expect(assertHostedRagJob(embedding,installations,plans,old,{kind:input.kind,project_id:'project',payload:payload!})).rejects.toHaveProperty('status',409);
        expect(requireCurrent).not.toHaveBeenCalled();expect(inspectionPackage).not.toHaveBeenCalled();
    });
    it('Plan target rejects old profile semantics before preparing or enqueueing any installation',async()=>{
        const old={...device,report:{...device.report,protocolVersion:2,bridgeVersion:'0.9.12',capabilities:['durable-completions','managed-installations',...(device.report.capabilities as string[]).filter(value=>value!=='hosted-rag-profile-values-v1')]}};
        const permission=vi.fn(),owned=vi.fn().mockResolvedValue(old),target={deviceId:'device',assetId:'rag',assetKind:'plugin' as const,version:2,expectedManifest:manifest,expectedBindingId:bindingId,expectedInstanceId:instanceId};
        const service={store:{owned},permission,installations,plans} as unknown as DeviceJobs;
        await expect(DeviceJobs.prototype.validateReindexTarget.call(service,{email:device.email,activeRole:device.role},'project',target)).rejects.toHaveProperty('status',409);
        expect(permission).toHaveBeenCalledOnce();expect(inspectionPackage).not.toHaveBeenCalled();expect(approvedConfiguration).not.toHaveBeenCalled();
    });
    it('Другие задания не читают выбор модели и не зависят от нового сервиса', async () => {
        expect(await hostedRagJobPayload(embedding,installations,plans,device,{...input,kind:'install'})).toBeUndefined();
        await assertHostedRagJob(embedding,installations,plans,device,{kind:'install',project_id:'project',payload:{}});
        expect(requireCurrent).not.toHaveBeenCalled();
    });
    it.each([null,{schemaVersion:2},{schemaVersion:1,url:'https://outside.example'},
        {schemaVersion:1,profileSchemaVersion:undefined},{schemaVersion:1,profileSchemaVersion:1},{schemaVersion:1,profileSchemaVersion:'2'},
        {schemaVersion:1,profileSchemaVersion:3},{schemaVersion:1,profileSchemaVersion:2,url:'https://outside.example'}])('Metadata не расширяет контракт %j', descriptor => {
        expect(supportsHostedRag({config:{extra:{hostedEmbedding:descriptor}}})).toBe(false);
    });
    it('Подтверждение принимает только публичный факт точного подключения', () => {
        const result={status:'connected',revision:3,modelPin:pin,profile,requiresRestart:true,reindex:{complete:true,rowCount:5,snapshotHash:'e'.repeat(64),serverSynced:true}};
        expect(() => assertHostedRagResult(result,{embedding:selection,reindex:true},false)).not.toThrow();
        expect(() => assertHostedRagResult({}, {embedding:selection},true)).not.toThrow();
        for (const changed of [{url:'http://127.0.0.1:1234'},{token:'private'},{path:'/private'},{requiresRestart:false},{revision:4},{profile:{...profile,model:'another'}}]) {
            expect(() => assertHostedRagResult({...result,...changed},{embedding:selection,reindex:true},false)).toThrow();
        }
        expect(() => assertHostedRagResult({note:'private'}, {embedding:selection},true)).toThrow();
    });
});
