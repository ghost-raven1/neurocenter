import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IBridgeDevice, IInstallPlan } from '../src/features/McpBridge/api';
import { artifactTargets, packageNeedsV5, runtimeArtifactBlocker } from '../src/features/McpBridge/runtimeArtifacts';
import { RuntimeArtifactsDetails } from '../src/modules/Store/installPlans/RuntimeArtifactsDetails';

const device: IBridgeDevice = {id:'device',name:'Компьютер',role:'Разработчик',fingerprint:'',online:true,lastSeen:null,
    report:{protocolVersion:2,platform:'darwin',arch:'arm64',runtimeArtifactTarget:'darwin-arm64',capabilities:['package-v5','runtime-artifacts-v1','local-mcp-config-v1']}};
const artifact = {target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'dist/index.js'};
const config = {transport:'stdio',extra:{runtimeArtifacts:[artifact]}};
const plan: IInstallPlan = {id:'plan',projectId:'project',assetId:'mcp',assetKind:'mcp',version:1,manifest:'b'.repeat(64),status:'approved',revision:1,
    approvedBy:'admin@example.test',files:[],config,requirements:{}};
const oldDevice = {...device,report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','install-set-v1']}};

describe('Готовые платформенные зависимости в точном плане установки',() => {
    it('Прежние пакеты без новых возможностей не блокируют старый MCP и RAG',() => {
        expect(runtimeArtifactBlocker({...plan,config:null},oldDevice)).toBe('');
        expect(runtimeArtifactBlocker({...plan,config:{transport:'remote',url:'https://example.test/mcp'}},oldDevice)).toBe('');
        expect(packageNeedsV5({config:null,schemaVersion:4})).toBe(false);
    });
    it('Новый формат требует capability, а строка версии сама по себе не разрешает установку',() => {
        expect(runtimeArtifactBlocker(plan,oldDevice)).toContain('0.9');
        expect(runtimeArtifactBlocker(plan,{...oldDevice,report:{...oldDevice.report,bridgeVersion:'99.0.0'}})).toContain('Обновите');
        expect(runtimeArtifactBlocker({...plan,schemaVersion:5,config:null},oldDevice)).toContain('0.9');
    });
    it('Только артефакт требует runtime capability, только схема настройки требует local-config capability',() => {
        const report = {...device.report,capabilities:['package-v5']};
        expect(runtimeArtifactBlocker(plan,{...device,report})).toContain('готовых зависимостей');
        const configurable = {...plan,config:{extra:{localConfiguration:{schemaVersion:1,fields:[]}}}};
        expect(runtimeArtifactBlocker(configurable,{...device,report})).toContain('мастера настройки');
        expect(runtimeArtifactBlocker(configurable,{...device,report:{...report,capabilities:['package-v5','local-mcp-config-v1']}})).toBe('');
    });
    it.each(artifactTargets)('Поддерживает только явно опубликованный комплект для %s',target => {
        const candidate = {...plan,config:{extra:{runtimeArtifacts:[{...artifact,target}]}}};
        expect(runtimeArtifactBlocker(candidate,{...device,report:{...device.report,runtimeArtifactTarget:target}})).toBe('');
    });
    it('Не подставляет Darwin, архитектуру или libc по догадке и показывает действие администратора',() => {
        expect(runtimeArtifactBlocker(plan,{...device,report:{...device.report,runtimeArtifactTarget:undefined}})).toContain('ещё не определена');
        expect(runtimeArtifactBlocker(plan,{...device,report:{...device.report,platform:'linux',runtimeArtifactTarget:'linux-x64'}})).toContain('ещё не определена');
        expect(runtimeArtifactBlocker(plan,{...device,report:{...device.report,runtimeArtifactTarget:'linux-x64-musl'}})).toContain('Администратор должен опубликовать');
    });
    it('Проверяет несовместимую зависимость, даже когда основной скилл не имеет артефактов',() => {
        const graph = {...plan,assetKind:'skill' as const,assetId:'skill/helper',config:null,packages:[
            {kind:'skill' as const,id:'skill/helper',name:'Помощник',version:1,manifest:plan.manifest,files:[],config:null,requirements:{}},
            {kind:'mcp' as const,id:'mcp',name:'Поиск документов',version:1,manifest:'c'.repeat(64),files:[],config:{extra:{runtimeArtifacts:[{...artifact,target:'win32-arm64'}]}},requirements:{}},
        ]};
        expect(runtimeArtifactBlocker(graph,device)).toContain('Поиск документов');
        expect(runtimeArtifactBlocker(graph,device)).toContain('darwin-arm64');
    });
    it('Просмотр одобрения показывает платформу, размеры, точку входа и полный SHA без запуска кода',() => {
        const html = renderToStaticMarkup(createElement(RuntimeArtifactsDetails,{config}));
        expect(html).toContain('Готовые зависимости'); expect(html).toContain(artifact.target); expect(html).toContain(artifact.sha256);
        expect(html).toContain('dist/index.js'); expect(html).toContain('после распаковки: 200');
        expect(html).toContain('npm или pip');
    });
    it('Локальный мастер объясняется только для пакета со схемой',() => {
        const html = renderToStaticMarkup(createElement(RuntimeArtifactsDetails,{config:{extra:{localConfiguration:{schemaVersion:1,fields:[]}}}}));
        expect(html).toContain('персональные параметры на своём компьютере');
        expect(renderToStaticMarkup(createElement(RuntimeArtifactsDetails,{config:null}))).toBe('');
    });
    it('Повреждённые метаданные не обрушивают окно одобрения и блокируют установку',() => {
        const broken = {extra:{runtimeArtifacts:[{target:'darwin-arm64',entrypoint:'index.mjs'}]}};
        expect(runtimeArtifactBlocker({...plan,config:broken},device)).toContain('некорректное описание');
        expect(renderToStaticMarkup(createElement(RuntimeArtifactsDetails,{config:broken}))).toContain('Попросите администратора обновить пакет');
    });
});
