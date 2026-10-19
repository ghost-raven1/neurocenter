import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IBridgeDevice, IBridgeInstallation, IBridgeJob, IInstallPlan, IRuntimeProbe } from '../src/features/McpBridge/api';
import type { IMcpConfigurationStatus } from '../src/features/McpBridge/mcpConfigurationTypes';
import { configurationBlocker, latestConfigurationStatus, matchingConfigurationOpened, matchingConfigurationPreparation, matchingConfigurationStatus } from '../src/features/McpBridge/mcpConfiguration';
import { latestInstallationReport, matchingRuntime } from '../src/features/McpBridge/operationHelpers';
import { hasLocalConfiguration, runtimeConfiguration, runtimeConfigurationChanged } from '../src/features/McpBridge/runtimeConfiguration';
import { installationProgress } from '../src/features/McpBridge/installationProgress';
import { InstallationReadinessStatus } from '../src/features/McpBridge/InstallationReadinessStatus';
import { consumeLocalJobResult } from '../src/features/McpBridge/localJobResult';

const bindingId = 'a'.repeat(64); const manifest = 'b'.repeat(64); const schemaDigest = 'c'.repeat(64);
const instanceId = '11111111-1111-1111-1111-111111111111'; const revision = '22222222-2222-2222-2222-222222222222';
const now = Date.parse('2026-10-18T01:00:00.000Z');
const device: IBridgeDevice = {id:'device',name:'Компьютер',role:'Разработчик',fingerprint:'',online:true,lastSeen:null,report:{protocolVersion:2,
    capabilities:['durable-completions','managed-installations','installation-inspection-v1','local-mcp-config-v1'],
    bindings:[{projectId:'project',folderName:'Работа',bindingId,instanceId,valid:true,identityStatus:'verified'}]}};
const item: IBridgeInstallation = {deviceId:device.id,projectId:'project',bindingId,assetId:'ai-plug-tool',assetKind:'mcp',version:1,
    manifest,name:'Поиск',isCurrentBinding:true,updatedAt:'2026-10-18T00:00:00.000Z',configurationSchemaDigest:schemaDigest};
const status: IMcpConfigurationStatus = {schemaVersion:1,projectId:item.projectId,bindingId,instanceId,assetId:item.assetId,assetKind:'mcp',version:1,
    manifest,schemaDigest,ready:true,missingFieldIds:[],revision,checkedAt:'2026-10-18T01:01:00.000Z'};
const preparation = {schemaVersion:1 as const,projectId:item.projectId,bindingId,instanceId,assetId:item.assetId,assetKind:'mcp' as const,version:1,
    manifest,schemaDigest,preparationId:'33333333-3333-3333-3333-333333333333',expiresAt:'2026-10-18T01:15:00.000Z'};
const inspection = {schemaVersion:1 as const,projectId:item.projectId,bindingId,assetId:item.assetId,assetKind:'mcp' as const,version:1,manifest,
    checkedAt:'2026-10-18T01:02:00.000Z',readiness:'unverified' as const,state:'checked' as const,status:'synced' as const,issues:[]};
const runtime: IRuntimeProbe = {schemaVersion:1,projectId:item.projectId,bindingId,assetId:item.assetId,assetKind:'mcp',version:1,manifest,
    approvalManifest:'d'.repeat(64),checkedAt:'2026-10-18T01:03:00.000Z',engineVersion:'1.14.48',engineSha256:'e'.repeat(64),status:'passed',code:'verified',
    configurationRevisions:[{assetId:item.assetId,manifest,revision}],counts:{packages:1,files:1,skills:0,mcp:1,tools:1,resources:0,prompts:0,pluginsInitialized:0}};
const job = (kind: string, result: Record<string,unknown>, changes:Partial<IBridgeJob> = {}): IBridgeJob => ({id:'job',deviceId:item.deviceId,
    projectId:item.projectId,bindingId,assetId:item.assetId,assetKind:item.assetKind,kind,state:'succeeded',message:'Готово',
    createdAt:item.updatedAt,updatedAt:'2026-10-18T01:01:00.000Z',result,...changes});
const localConfig = {extra:{localConfiguration:{schemaVersion:1,fields:[{id:'apiKey',label:'Ключ API',type:'string',required:true,secret:true,target:{kind:'env',name:'SERVICE_API_KEY'}}]}}};
const plan: IInstallPlan = {id:'plan',projectId:item.projectId,assetId:item.assetId,assetKind:'mcp',version:1,manifest,status:'approved',revision:1,
    approvedBy:'admin@example.test',files:[],config:localConfig,requirements:{}};

describe('Публичная готовность локальной настройки без значений',() => {
    it('Принимает точный tuple и случайную ревизию; optional-параметры разрешают готовность без сохранения',() => {
        expect(matchingConfigurationStatus(status,item,instanceId)).toBe(status);
        expect(matchingConfigurationStatus({...status,revision:null},item,instanceId)?.ready).toBe(true);
        expect(matchingConfigurationStatus({...status,ready:false,missingFieldIds:['apiKey']},item,instanceId)?.ready).toBe(false);
    });
    it.each([{manifest:'d'.repeat(64)},{version:2},{projectId:'other'},{assetId:'other'},{bindingId:'f'.repeat(64)},
        {instanceId:'44444444-4444-4444-4444-444444444444'},{schemaDigest:'f'.repeat(64)}])('Чужая версия или папка не подтверждает настройку: %j',change => {
        expect(matchingConfigurationStatus({...status,...change},item,instanceId)).toBeUndefined();
    });
    it.each([{values:{apiKey:'секрет'}},{env:{TOKEN:'секрет'}},{url:'http://127.0.0.1/private'},
        {revision:'secret-hash'},{missingFieldIds:['/Users/private']},{ready:true,missingFieldIds:['apiKey']},
        {ready:false,missingFieldIds:[]},{missingFieldIds:['apiKey','apiKey']},{checkedAt:'bad'}])('Не отображает лишние данные или ложную готовность: %j',change => {
        expect(matchingConfigurationStatus({...status,...change},item,instanceId)).toBeUndefined();
    });
    it('После перезагрузки выбирает последний корректный статус только своей установки',() => {
        const old = {...status,ready:false,missingFieldIds:['apiKey'],revision:null,checkedAt:'2026-10-18T00:59:00.000Z'};
        const latest = latestConfigurationStatus({...item,configuration:old},[
            job('get-mcp-configuration-status',{...status}),job('get-mcp-configuration-status',{...status,ready:false},{bindingId:'f'.repeat(64)}),
            job('get-mcp-configuration-status',{...status,values:{apiKey:'секрет'}},{id:'unsafe'}),
        ],instanceId);
        expect(latest).toEqual(status);
    });
    it('Не принимает статус без схемы у установленной версии или от скилла',() => {
        expect(matchingConfigurationStatus(status,{...item,configurationSchemaDigest:undefined})).toBeUndefined();
        expect(matchingConfigurationStatus(status,{...item,assetKind:'skill'})).toBeUndefined();
    });
    it('Поздний ACK старого чтения после сохранения параметров не возвращает прежнюю готовность',() => {
        const invalidated = {...item,configurationInvalidatedAt:'2026-10-18T01:05:00.000Z'};
        const old = job('get-mcp-configuration-status',{...status},{createdAt:'2026-10-18T01:00:00.000Z',startedAt:'2026-10-18T01:04:00.000Z',updatedAt:'2026-10-18T01:10:00.000Z'});
        expect(latestConfigurationStatus(invalidated,[old])).toBeUndefined();
        const fresh = {...old,id:'new-status',startedAt:'2026-10-18T01:06:00.000Z',result:{...status,checkedAt:'2026-10-18T01:06:00.000Z'}};
        expect(latestConfigurationStatus(invalidated,[old,fresh])?.ready).toBe(true);
        expect(latestConfigurationStatus(invalidated,[{...old,startedAt:null}])).toBeUndefined();
    });
    it('Коррекция часов компьютера не подменяет новый отказ старой готовностью с поздним ACK',() => {
        const oldReady = {...status,checkedAt:'2026-10-18T02:00:00.000Z'};
        const current = {...status,ready:false,missingFieldIds:['token'],checkedAt:'2026-10-18T01:05:00.000Z'};
        const row = {...item,configuration:current,configurationObservedAt:'2026-10-18T01:05:00.000Z'};
        const old = job('get-mcp-configuration-status',{...oldReady},{id:'old',startedAt:'2026-10-18T01:04:00.000Z',updatedAt:'2026-10-18T02:10:00.000Z'});
        const same = job('get-mcp-configuration-status',{...oldReady},{id:'same',startedAt:row.configurationObservedAt,updatedAt:'2026-10-18T02:11:00.000Z'});
        expect(latestConfigurationStatus(row,[old,same])).toBe(current);
        const fresh = job('get-mcp-configuration-status',{...status,checkedAt:'2026-10-18T00:58:00.000Z'},{id:'fresh',startedAt:'2026-10-18T01:06:00.000Z'});
        expect(latestConfigurationStatus(row,[old,fresh])?.ready).toBe(true);
        const failed = job('get-mcp-configuration-status',{},{id:'failed',version:'1',state:'failed',startedAt:'2026-10-18T01:07:00.000Z'});
        expect(latestConfigurationStatus(row,[old,fresh,failed])).toBeUndefined();
        expect(latestConfigurationStatus({...row,configuration:undefined,configurationObservedAt:'2026-10-18T01:07:00.000Z'},[old,fresh])).toBeUndefined();
    });
});

describe('Подготовка и открытие локального мастера',() => {
    it('Ограничивает подготовку сроком и исходным экземпляром, открытие не становится готовой настройкой',() => {
        expect(matchingConfigurationPreparation(preparation,item,instanceId,now)).toBe(preparation);
        expect(matchingConfigurationPreparation(preparation,item,instanceId,now+16*60000)).toBeUndefined();
        expect(matchingConfigurationPreparation({...preparation,expiresAt:'2026-10-18T02:00:00.000Z'},item,instanceId,now)).toBeUndefined();
        expect(matchingConfigurationPreparation({...preparation,instanceId:revision},item,instanceId,now)).toBeUndefined();
        expect(matchingConfigurationStatus({...preparation,opened:true},item,instanceId)).toBeUndefined();
    });
    it('Не повторяет действие после одинакового результата polling и WebSocket',() => {
        const seen = new Set<string>(); const finished = job('prepare-mcp-configuration',{...preparation});
        expect(consumeLocalJobResult(seen,finished,'context','context')).toBe(true);
        expect(consumeLocalJobResult(seen,{...finished},'context','context')).toBe(false);
        expect(consumeLocalJobResult(seen,{...finished,id:'next'},'other','context')).toBe(false);
    });
    it('Наблюдатель читает готовность, но открытие мастера требует разработчика на обеих сторонах',() => {
        const observer = {...device,role:'Наблюдатель'};
        expect(configurationBlocker(item,[item],observer,[],true,true,false)).toBe('');
        expect(configurationBlocker(item,[item],observer,[],true,true,true)).toContain('Роль подключения');
        expect(configurationBlocker(item,[item],device,[],true,false,true)).toContain('разработчика');
    });
    it('Offline, старая capability, новый binding и незагруженная очередь дают конкретное действие',() => {
        expect(configurationBlocker(item,[item],{...device,online:false},[],true,true,true)).toContain('включите компьютер');
        expect(configurationBlocker(item,[item],{...device,report:{...device.report,capabilities:device.report.capabilities!.filter(value=>value!=='local-mcp-config-v1')}},[],true,true,true)).toContain('0.9');
        expect(configurationBlocker(item,[{...item,version:2}],device,[],true,true,true)).toContain('изменилась');
        expect(configurationBlocker(item,[item],device,[],false,true,true)).toContain('Дождитесь');
    });
    it('Подготовка не блокирует своё открытие; чужое текущее задание блокирует',() => {
        const queued = job('prepare-mcp-configuration',{},{state:'running'});
        expect(configurationBlocker(item,[item],device,[queued],true,true,true)).toContain('другого действия');
        expect(configurationBlocker(item,[item],device,[queued],true,true,true,queued.id)).toBe('');
    });
    it('Для будущего ответа opened проверяет подготовку и не принимает секреты',() => {
        const fresh = {...preparation,expiresAt:new Date(Date.now()+60000).toISOString(),opened:true as const};
        expect(matchingConfigurationOpened(fresh,item,preparation.preparationId,instanceId)).toBe(fresh);
        expect(matchingConfigurationOpened({...fresh,preparationId:revision},item,preparation.preparationId,instanceId)).toBeUndefined();
        expect(matchingConfigurationOpened({...fresh,values:{apiKey:'секрет'}},item,preparation.preparationId,instanceId)).toBeUndefined();
    });
});

describe('Диагностика закрепляет настройки полного графа',() => {
    it('Старые пакеты без схемы не требуют нового мастера или ревизии',() => {
        expect(hasLocalConfiguration(null)).toBe(false);
        expect(runtimeConfiguration({...plan,config:null},item,[])).toEqual({revisions:[],blocker:''});
    });
    it('Готовый MCP передаёт только assetId, manifest и случайную ревизию',() => {
        expect(runtimeConfiguration(plan,item,[{...item,configuration:status}])).toEqual({blocker:'',revisions:[{assetId:item.assetId,manifest,revision}]});
        expect(runtimeConfiguration(plan,item,[{...item,configuration:{...status,revision:null}}]).revisions[0].revision).toBeNull();
    });
    it('Корневой скилл требует настройки зависимости из exact frozen graph, а не текущей карточки',() => {
        const skill = {...item,assetKind:'skill' as const,assetId:'skill/project',configurationSchemaDigest:undefined};
        const graph = {...plan,assetKind:'skill' as const,assetId:skill.assetId,config:null,manifest:'f'.repeat(64),packages:[
            {kind:'mcp' as const,id:item.assetId,name:item.name,version:1,manifest,config:localConfig,files:[],requirements:{}},
            {kind:'skill' as const,id:skill.assetId,name:'Помощник',version:1,manifest:skill.manifest,config:null,files:[],requirements:{}},
        ]};
        expect(runtimeConfiguration(graph,skill,[]).blocker).toContain('Поиск');
        expect(runtimeConfiguration(graph,skill,[{...item,configuration:status}]).revisions).toHaveLength(1);
        expect(runtimeConfiguration(graph,skill,[{...item,configuration:status,bindingId:'f'.repeat(64)}]).blocker).toContain('Сначала настройте');
    });
    it('Порядок ревизий соответствует серверному ASCII-порядку независимо от локали',() => {
        const ids = ['mcp_lower','mcp-Z','mcp_A'];
        const rows = ids.map(assetId => ({...item,assetId,configuration:{...status,assetId}}));
        const graph = {...plan,packages:rows.map(row => ({kind:'mcp' as const,id:row.assetId,name:row.name,version:1,manifest,config:localConfig,files:[],requirements:{}}))};
        expect(runtimeConfiguration(graph,item,rows).revisions.map(row=>row.assetId)).toEqual(['mcp-Z','mcp_A','mcp_lower']);
    });
    it('Смена и удаление параметров делают зелёную диагностику устаревшей',() => {
        const original = {...item,inspection,runtime,configuration:status};
        expect(latestInstallationReport(original,[]).runtime?.status).toBe('passed');
        const changed = {...status,revision:'44444444-4444-4444-4444-444444444444'};
        expect(latestInstallationReport({...original,configuration:changed},[]).runtime?.status).toBe('stale');
        expect(runtimeConfigurationChanged(original,[{...item,configuration:changed}])).toBe(true);
        expect(runtimeConfigurationChanged(original,[{...item,configuration:status}])).toBe(false);
        expect(runtimeConfigurationChanged(original,[])).toBe(true);
    });
    it('Одно открытие мастера сохраняет прежнюю готовность; сохранение параметров требует нового чтения',() => {
        const original = {...item,inspection,runtime,configuration:status};
        const open = job('open-mcp-configuration',{...preparation,opened:true},{updatedAt:'2026-10-18T01:04:00.000Z'});
        const report = latestInstallationReport(original,[open]);
        expect(report.configuration?.ready).toBe(true); expect(report.runtime?.status).toBe('passed');
        const invalidated = latestInstallationReport({...original,configuration:undefined,configurationInvalidatedAt:'2026-10-18T01:04:30.000Z'},[open]);
        expect(invalidated.configuration).toBeUndefined(); expect(invalidated.runtime?.status).toBe('stale');
        const refreshed = job('get-mcp-configuration-status',{...status,checkedAt:'2026-10-18T01:05:00.000Z'},{id:'refresh',updatedAt:'2026-10-18T01:05:00.000Z'});
        expect(latestInstallationReport(original,[open,refreshed]).configuration?.ready).toBe(true);
    });
    it('Результат с отпечатком секрета, чужой ревизией или дубликатом MCP не отображается как passed',() => {
        for (const configurationRevisions of [[{assetId:item.assetId,manifest,revision:'secret-hash'}],[{assetId:item.assetId,manifest,revision,values:'secret'}],
            [{assetId:item.assetId,manifest,revision},{assetId:item.assetId,manifest,revision}]]) {
            expect(matchingRuntime({...item,runtime:{...runtime,configurationRevisions} as IRuntimeProbe})).toBeUndefined();
        }
    });
    it('Старый job-result не перетирает stale от сервера для той же диагностики зависимого скилла',() => {
        const skill = {...item,assetKind:'skill' as const,assetId:'skill/helper',configurationSchemaDigest:undefined,
            runtime:{...runtime,assetKind:'skill',assetId:'skill/helper',status:'stale' as const}};
        const oldJob = job('probe-runtime',{...skill.runtime,status:'passed'},{assetKind:'skill',assetId:skill.assetId});
        expect(latestInstallationReport(skill,[oldJob]).runtime?.status).toBe('stale');
    });
    it('Диагностики упорядочены временем server-start, а не часами компьютера или поздним ACK',() => {
        const authoritative = {...item,inspection,configuration:status,runtime:{...runtime,status:'stale' as const},runtimeObservedAt:'2026-10-18T01:05:00.000Z'};
        const delayed = job('probe-runtime',{...runtime,checkedAt:'2026-10-18T02:00:00.000Z'},
            {id:'old-probe',startedAt:'2026-10-18T01:04:00.000Z',updatedAt:'2026-10-18T02:10:00.000Z'});
        expect(latestInstallationReport(authoritative,[delayed]).runtime?.status).toBe('stale');
        const same = {...delayed,id:'same-probe',startedAt:authoritative.runtimeObservedAt};
        expect(latestInstallationReport(authoritative,[same]).runtime?.status).toBe('stale');
        const fresh = {...delayed,id:'new-probe',startedAt:'2026-10-18T01:06:00.000Z',result:{...runtime,checkedAt:'2026-10-18T00:58:00.000Z'}};
        const report = latestInstallationReport(authoritative,[delayed,fresh]);
        expect(report.runtime?.status).toBe('passed'); expect(report.runtimeObservedAt).toBe(fresh.startedAt);
    });
});

describe('Единый ближайший шаг установленного инструмента',() => {
    it('Наличие файлов не обещает работоспособность и ведёт к локальной настройке',() => {
        expect(installationProgress(item,[])).toMatchObject({state:'configuration',action:'configuration'});
        expect(installationProgress({...item,configuration:status},[])).toMatchObject({title:'Файлы установлены',action:'inspect'});
        expect(installationProgress({...item,configuration:status,inspection},[])).toMatchObject({title:'Можно проверить запуск',action:'runtime'});
    });
    it('Ручные изменения сначала ведут к сравнению; пройденная диагностика обозначает свой ограниченный scope',() => {
        expect(installationProgress({...item,configuration:status,inspection:{...inspection,status:'modified'}},[])).toMatchObject({state:'modified',action:'repair'});
        const ready = {...item,configuration:status,inspection,runtime};
        expect(installationProgress(ready,[])).toMatchObject({title:'Проверка пройдена',action:'none'});
        const html = renderToStaticMarkup(createElement(InstallationReadinessStatus,{item:ready,jobs:[]}));
        expect(html).toContain('Вызовы инструментов, hooks и ответы модели не проверялись');
    });
    it('Незавершённый ACK переживает загрузку страницы и не предлагает вторую установку',() => {
        const pending = job('install',{},{state:'reconciling',message:'Подтверждаем завершение'});
        expect(installationProgress(item,[pending])).toMatchObject({state:'pending',action:'none',title:'Сверяем результат действия'});
    });
});
