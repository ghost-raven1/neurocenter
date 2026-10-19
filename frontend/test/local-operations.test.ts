import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IBridgeBinding, IBridgeDevice, IBridgeInstallation, IBridgeJob, IInstallPlan, ILocalChangePlan, IRuntimeProbe } from '../src/features/McpBridge/api';
import { installedTuple, latestInstallationReport, localActionBlocker, matchingChangePlan, matchingRuntime, pendingLocalJob, runtimeConsent, runtimeFileBlocker } from '../src/features/McpBridge/operationHelpers';
import { workspaceBlocker, bridgeOperationBlocker, localFeatureBlocker } from '../src/features/McpBridge/readiness';
import { matchingWorkspacePreparation, workspaceSnapshot, workspaceSource } from '../src/features/McpBridge/workspaceBinding';
import { RuntimeProbeStatus } from '../src/features/McpBridge/RuntimeProbeStatus';
import { LocalChangePreview } from '../src/features/McpBridge/LocalChangePreview';
import { installationProgress } from '../src/features/McpBridge/installationProgress';

const instanceId = '11111111-1111-1111-1111-111111111111';
const bindingId = 'a'.repeat(64); const manifest = 'b'.repeat(64);
const binding: IBridgeBinding = {projectId:'project',folderName:'Моя папка',valid:true,bindingId,instanceId,identityStatus:'verified'};
const device: IBridgeDevice = {id:'device',name:'Компьютер',role:'Разработчик',fingerprint:'',online:true,lastSeen:null,report:{protocolVersion:2,
    capabilities:['durable-completions','managed-installations','workspace-instance-v1','local-change-plan-v1','runtime-probe-v1'],bindings:[binding]}};
const item: IBridgeInstallation = {deviceId:device.id,projectId:'project',assetKind:'mcp',assetId:'ai-plug-tool',name:'Инструмент',version:2,manifest,
    bindingId,isCurrentBinding:true,updatedAt:'2026-10-17T10:00:00.000Z'};
const inspection = {schemaVersion:1 as const,projectId:item.projectId,bindingId,assetId:item.assetId,assetKind:item.assetKind,version:item.version,manifest,
    checkedAt:'2026-10-17T11:00:00.000Z',readiness:'unverified' as const,state:'checked' as const,status:'synced' as const,issues:[]};
const runtime: IRuntimeProbe = {schemaVersion:1,projectId:item.projectId,bindingId,assetId:item.assetId,assetKind:item.assetKind,version:item.version,manifest,
    approvalManifest:'c'.repeat(64),checkedAt:'2026-10-17T11:01:00.000Z',engineVersion:'1.14.48',engineSha256:'d'.repeat(64),status:'passed',code:'verified',
    counts:{packages:1,files:1,skills:0,mcp:1,tools:2,resources:3,prompts:4,pluginsInitialized:0}};
const change: ILocalChangePlan = {schemaVersion:1,planId:'22222222-2222-2222-2222-222222222222',revision:1,digest:'e'.repeat(64),projectId:item.projectId,
    bindingId,instanceId,assetId:item.assetId,assetKind:item.assetKind,version:item.version,manifest,checkedAt:'2026-10-17T11:00:00.000Z',
    expiresAt:'2026-10-17T11:15:00.000Z',status:'prepared',files:[{path:'.opencode/skills/tool/SKILL.md',operation:'replace',beforeSha256:'f'.repeat(64),afterSha256:manifest,beforeBytes:10,afterBytes:20,binary:false}]};

describe('Восстановление готового комплекта без изменения файлов проекта', () => {
    it('Принимает явный план восстановления кэша без file diff, но отклоняет неясное согласие', () => {
        const repair = {...change, files: [], runtimeRepairRequired: true};
        expect(matchingChangePlan(repair, item, instanceId)).toBe(repair);
        for (const runtimeRepairRequired of [false, 'true', 1, null]) {
            expect(matchingChangePlan({...repair, runtimeRepairRequired}, item, instanceId)).toBeUndefined();
        }
    });
    it('Показывает повторную загрузку и проверку SHA отдельно от отсутствия изменений проекта', () => {
        const html = renderToStaticMarkup(createElement(LocalChangePreview, {plan: {...change, files: [], runtimeRepairRequired: true}}));
        expect(html).toContain('Нужно восстановить готовый комплект');
        expect(html).toContain('SHA');
        expect(html).toContain('В файлах проекта изменений не будет');
    });
    it('Незавершённая сверка даёт путь к плану восстановления вместо бесконечного повтора', () => {
        expect(installationProgress({...item, inspection: {...inspection, status: 'unknown', issues: ['inspection-failed']}}, []))
            .toMatchObject({action: 'repair', title: 'Сверка не завершена'});
        expect(installationProgress(item, [])).toMatchObject({action: 'inspect'});
    });
});
const job = (kind:string,changes:Partial<IBridgeJob> = {}): IBridgeJob => ({id:'job',deviceId:device.id,projectId:item.projectId,assetId:item.assetId,assetKind:item.assetKind,
    bindingId,kind,state:'running',message:'Выполняется',createdAt:item.updatedAt,updatedAt:'2026-10-17T12:00:00.000Z',...changes});
const blocker = (row = item, target = device, jobs:IBridgeJob[] = [], canManage = true) => localActionBlocker(row,[row],target,jobs,true,canManage,'local-change-plan-v1');
const plan: IInstallPlan = {id:'plan',projectId:item.projectId,assetId:item.assetId,assetKind:item.assetKind,version:item.version,manifest,status:'approved',revision:1,
    approvedBy:'admin@example.test',files:[],config:null,requirements:{}};

describe('Явный выбор экземпляра папки',() => {
    it('Legacy adoption использует исторический отпечаток, а не новую предполагаемую привязку',() => {
        expect(workspaceSource({...binding,valid:false,identityStatus:'legacy',bindingId:undefined,instanceId:undefined,previousBindingId:bindingId},'adopt-legacy')).toEqual({expectedBindingId:bindingId});
        expect(() => workspaceSource(binding,'adopt-legacy')).toThrow('Старая привязка');
    });
    it('Copy и transfer передают точные source binding/instance',() => {
        for (const mode of ['new-copy','transfer'] as const) { expect(workspaceSource(binding,mode)).toEqual({expectedBindingId:bindingId,expectedInstanceId:instanceId}); }
        expect(workspaceSource(undefined,'new')).toEqual({});
        expect(workspaceSource(binding,'resume')).toEqual({});
    });
    it('Resume берёт прежний instance A из preview, не подставляя текущий binding B в запрос',() => {
        const input = {kind:'prepare-bind-project' as const,deviceId:device.id,projectId:item.projectId,folderName:'Папка А',bindingMode:'resume' as const};
        const preview = {projectId:item.projectId,folderName:'Папка А',mode:'resume',preparation:manifest,requiresFileVerification:true,instanceId,previousBindingId:bindingId};
        expect(matchingWorkspacePreparation(preview,input)).toBe(preview);
        expect(workspaceSource({...binding,bindingId:'c'.repeat(64)},'resume')).toEqual({});
        expect(matchingWorkspacePreparation({...preview,expectedBindingId:'c'.repeat(64)},input)).toBeUndefined();
    });
    it('Переименованный оригинал допускает только transfer с приватным происхождением',() => {
        const moved: IBridgeBinding = {...binding,valid:false,identityStatus:'unavailable',bindingId:undefined,previousBindingId:bindingId};
        expect(workspaceSource(moved,'transfer')).toEqual({expectedBindingId:bindingId,expectedInstanceId:instanceId});
        expect(() => workspaceSource(moved,'new-copy')).toThrow('исходный экземпляр');
        expect(() => workspaceSource({...moved,instanceId:undefined},'transfer')).toThrow();
    });
    it('Copied и changed report не становятся подтверждённым источником',() => {
        for (const identityStatus of ['copied','changed'] as const) {
            expect(() => workspaceSource({...binding,valid:false,identityStatus,previousBindingId:bindingId},'transfer')).toThrow();
        }
    });
    it('Preview другого действия, каталога или ожидаемого экземпляра не разрешает commit',() => {
        const input = {kind:'prepare-bind-project' as const,deviceId:device.id,projectId:item.projectId,folderName:'Копия',bindingMode:'new-copy' as const,expectedBindingId:bindingId,expectedInstanceId:instanceId};
        const value = {projectId:item.projectId,folderName:'Копия',mode:'new-copy',preparation:manifest,requiresFileVerification:true,expectedBindingId:bindingId,expectedInstanceId:instanceId,instanceId};
        expect(matchingWorkspacePreparation(value,input)).toBe(value);
        for (const changes of [{folderName:'Другая'},{mode:'transfer'},{expectedInstanceId:undefined},{requiresFileVerification:false},{sourceFolderName:'/private/path'}]) {
            expect(matchingWorkspacePreparation({...value,...changes},input)).toBeUndefined();
        }
    });
    it('Heartbeat без изменений не аннулирует preview, смена компьютера или binding аннулирует',() => {
        expect(workspaceSnapshot(device,item.projectId)).toBe(workspaceSnapshot({...device,lastSeen:'сейчас'},item.projectId));
        expect(workspaceSnapshot(device,item.projectId)).not.toBe(workspaceSnapshot({...device,id:'other'},item.projectId));
        expect(workspaceSnapshot(device,item.projectId)).not.toBe(workspaceSnapshot({...device,report:{...device.report,bindings:[{...binding,bindingId:manifest}]}},item.projectId));
    });
});

describe('Восстановление требует текущей папки и точного плана',() => {
    it('Наблюдатель, устаревшая строка, offline и отсутствие capability не разрешают действие',() => {
        expect(blocker()).toBe(''); expect(blocker(item,device,[],false)).toContain('разработчика');
        expect(blocker({...item,isCurrentBinding:false})).toContain('изменилась');
        expect(blocker(item,{...device,online:false})).toContain('Включите');
        expect(blocker(item,{...device,report:{...device.report,capabilities:['durable-completions','managed-installations','workspace-instance-v1']}})).toContain('Обновите');
    });
    it('Новый feature gate не блокирует выбор общей папки и RAG старому MCP',() => {
        const older = {...device,report:{...device.report,capabilities:['durable-completions','managed-installations']}};
        expect(bridgeOperationBlocker(older)).toBe(''); expect(workspaceBlocker(older)).toContain('Обновите');
        expect(localFeatureBlocker(older,'runtime-probe-v1')).toContain('Обновите');
    });
    it('Параллельное действие другой папки не блокирует строку; текущее и перенос блокируют',() => {
        expect(pendingLocalJob([job('apply-local-change',{bindingId:manifest})],item)).toBeUndefined();
        expect(pendingLocalJob([job('apply-local-change')],item)?.id).toBe('job');
        expect(pendingLocalJob([job('bind-project',{assetId:undefined,bindingId:undefined})],item)?.id).toBe('job');
    });
    it('Tuple запросов закрепляет установленный root SHA и исходную папку',() => {
        expect(installedTuple(item)).toEqual({deviceId:device.id,projectId:item.projectId,assetId:item.assetId,assetKind:item.assetKind,expectedManifest:manifest,expectedBindingId:bindingId});
    });
    it.each([{bindingId:manifest},{instanceId:'33333333-3333-3333-3333-333333333333'},{version:3},{manifest:'f'.repeat(64)},{expiresAt:'2026-10-17T12:00:00.000Z'}])('Не показывает чужой или неограниченный план: %j',changes => {
        expect(matchingChangePlan({...change,...changes},item,instanceId)).toBeUndefined();
    });
    it('План разрешает только относительные ограниченные файлы и не принимает неоднозначные пути',() => {
        expect(matchingChangePlan(change,item,instanceId)).toBe(change);
        for (const path of ['/private/secret','../secret','folder\\secret','a//b','file\0name']) {
            expect(matchingChangePlan({...change,files:[{...change.files[0],path}]},item,instanceId)).toBeUndefined();
        }
        expect(matchingChangePlan({...change,files:[change.files[0],change.files[0]]},item,instanceId)).toBeUndefined();
    });
});

describe('Согласие на точный комплект и честная диагностика',() => {
    it('Single consent совпадает с установленным SHA, multi consent — с SET SHA при точном root',() => {
        expect(runtimeConsent(plan,item)).toBe(manifest);
        const set = {...plan,manifest:'c'.repeat(64),packages:[{id:item.assetId,kind:item.assetKind,name:item.name,version:item.version,manifest,files:[],config:null,requirements:{}}]};
        expect(runtimeConsent(set,item)).toBe(set.manifest);
        expect(() => runtimeConsent({...set,packages:[{...set.packages[0],manifest:'f'.repeat(64)}]},item)).toThrow('другому содержимому');
    });
    it.each([{status:'pending' as const},{status:'revoked' as const},{version:3},{assetId:'other'},{projectId:'other'}])('Head, чужое или отозванное одобрение не разрешает запуск: %j',changes => {
        expect(() => runtimeConsent({...plan,...changes},item)).toThrow();
    });
    it('Запуск недоступен до полной сверки, при изменённых файлах или занятой inspection',() => {
        expect(runtimeFileBlocker({...item,inspection})).toBe(''); expect(runtimeFileBlocker(item)).toContain('Сначала проверьте');
        expect(runtimeFileBlocker({...item,inspection:{...inspection,status:'modified'}})).toContain('Сначала проверьте');
        expect(runtimeFileBlocker({...item,inspection:{...inspection,state:'busy'}})).toContain('Сначала проверьте');
    });
    it('Успех показывает ограниченный scope, время и счётчики',() => {
        const html = renderToStaticMarkup(createElement(RuntimeProbeStatus,{item:{...item,inspection,runtime}}));
        expect(html).toContain('Диагностика OpenCode пройдена'); expect(html).toContain('инструменты: 2'); expect(html).toContain('ресурсы: 3');
        expect(html).toContain('Вызовы инструментов и ответы модели не проверялись');
    });
    it('Изменённые файлы аннулируют прежний passed вместо зелёного результата',() => {
        const html = renderToStaticMarkup(createElement(RuntimeProbeStatus,{item:{...item,inspection:{...inspection,status:'modified'},runtime}}));
        expect(html).toContain('Диагностика запуска устарела'); expect(html).not.toContain('ant-tag-green');
    });
    it('Восстановление аннулирует прежние inspection/runtime, история другой папки их не меняет',() => {
        const original = {...item,inspection,runtime};
        const repaired = latestInstallationReport(original,[job('apply-local-change',{state:'succeeded'})]);
        expect(repaired.inspection).toBeUndefined(); expect(repaired.runtime?.status).toBe('stale');
        expect(latestInstallationReport(original,[job('apply-local-change',{state:'succeeded',bindingId:manifest})]).runtime?.status).toBe('passed');
    });
    it('Runtime другой версии, движка или неподдерживаемого code не рисуется как passed',() => {
        for (const changes of [{version:1},{bindingId:manifest},{code:'/private/secret'},{engineVersion:'unknown'},{counts:{}}]) {
            expect(matchingRuntime({...item,runtime:{...runtime,...changes} as IRuntimeProbe})).toBeUndefined();
        }
    });
    it('Комплект из 20 MCP допускает суммарно 20000 возможностей и отклоняет превышение',() => {
        const full = {...runtime,counts:{...runtime.counts,packages:20,mcp:20,files:200,tools:20000,resources:20000,prompts:20000}};
        expect(matchingRuntime({...item,runtime:full})).toBe(full);
        expect(matchingRuntime({...item,runtime:{...full,counts:{...full.counts,tools:20001}}})).toBeUndefined();
    });
});
