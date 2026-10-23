import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {packagingAgentModelAvailable, validPackagingAgent} from '../src/modules/Store/packaging/packagingAgent';
import {PackagingBuildEvidence} from '../src/modules/Store/packaging/PackagingBuildEvidence';
import {readStoredBuildDraft, saveStoredBuildDraft} from '../src/modules/Store/packaging/buildDraftStore';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';
import type {ToolBuild, ToolBuildRequest, ToolBuildRuntimeVerification} from '../src/modules/Store/packaging/types';

vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Tag: content, Collapse: Object.assign(content, {Panel: content}), Typography: {Text: content, Paragraph: content},
        Alert: ({message, description}: {message?: ReactNode; description?: ReactNode}) => createElement('div', null, message, description)};
});

const pin = 'a'.repeat(64), verification = 'b'.repeat(64);
const model: ICatalogModel = {id:'model-chat',name:'Chat',description:'Verified',capability:'chat',runtime:'remote-openai',model:'provider/chat',manifestSha256:null,verificationSha256:verification,modelPin:pin,dimension:null,source:'custom',revision:1,createdAt:'2026-10-23',updatedAt:'2026-10-23'};
const agent = {modelId:model.id,expectedModelPin:pin,maxAttempts:3};
const request = ():ToolBuildRequest => ({requestKey:'11111111-1111-4111-8111-111111111111',kind:'mcp',name:'MCP',description:'Description',source:{type:'files',entrypoint:'index.js',files:[{path:'index.js',content:'console.log("source")'}]},agent});
const receipt = ():ToolBuildRuntimeVerification => ({schemaVersion:1,status:'passed',candidate:{identity:'candidate',sourceDigest:pin,assetId:'tool',version:'1',manifestSha256:verification},hostTarget:'linux-x64-gnu',testedTarget:'linux-x64-gnu',untestedTargets:['darwin-arm64','win32-x64'],isolation:{kind:'linux-userns',osEnforced:true,network:'denied'},checks:{integrity:true,initialize:true,toolsList:true,pluginFactory:false,hooks:false},counts:{tools:2,pluginHooks:0},diagnostics:[],startedAt:'2026-10-23T00:00:00Z',finishedAt:'2026-10-23T00:00:01Z',durationMs:1000});
const job = ():ToolBuild => ({id:'build',operationId:'operation',requestKey:request().requestKey,publicationStartedAt:null,state:'RUNNING',percent:70,message:'Проверка запуска',runtimeVerification:receipt(),agentSteps:[{attempt:1,stage:'propose',state:'SUCCEEDED'}]});
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('Выбор и восстановление модели Упаковщика', () => {
    it('Принимает проверенные common chat/vision и локальный manifest', () => {
        expect(packagingAgentModelAvailable(model)).toBe(true);
        expect(packagingAgentModelAvailable({...model,capability:'vision'})).toBe(true);
        expect(packagingAgentModelAvailable({...model,runtime:'ollama',manifestSha256:verification,verificationSha256:null})).toBe(true);
    });
    it.each([{capability:'embedding'}, {archivedAt:'2026-10-23'}, {modelPin:undefined}, {modelPin:'bad'}, {verificationSha256:null}, {verificationSha256:'bad'}, {runtime:'ollama',manifestSha256:null}])('Не предлагает неподтверждённую модель %j', override => {
        expect(packagingAgentModelAvailable({...model,...override} as ICatalogModel)).toBe(false);
    });
    it('Durable exact pin и предел попыток не меняются при обновлении каталога', async () => {
        const value=request();await saveStoredBuildDraft('alice',value);expect((await readStoredBuildDraft('alice'))?.request).toEqual(value);
        await expect(saveStoredBuildDraft('alice',{...value,agent:{...agent,expectedModelPin:'c'.repeat(64)}})).rejects.toThrow('другой запрос');
        expect((await readStoredBuildDraft('alice'))?.request.agent).toEqual(agent);
    });
    it.each([null, {}, {...agent,maxAttempts:0}, {...agent,maxAttempts:4}, {...agent,maxAttempts:1.5}, {...agent,expectedModelPin:'bad'}, {...agent,modelId:' '}, {...agent,extra:true}])('Повреждённая настройка %j не попадает в повторный POST', async value => {
        expect(validPackagingAgent(value)).toBe(false);
        await expect(saveStoredBuildDraft('alice',{...request(),agent:value} as ToolBuildRequest)).rejects.toThrow('повреждён');
        expect(await readStoredBuildDraft('alice')).toBeUndefined();
    });
    it('Skill не отправляет и не восстанавливает модель агента', async () => {
        await expect(saveStoredBuildDraft('alice',{...request(),kind:'skill',source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'Instruction'}]}})).rejects.toThrow('повреждён');
    });
});

describe('Свидетельства runtime проверки в интерфейсе', () => {
    const render = (value:ToolBuild):string => renderToStaticMarkup(createElement(PackagingBuildEvidence,{job:value}));
    it('Отделяет проверенный сервер от непроверенных macOS/Windows', () => {
        const html=render(job());expect(html).toContain('Запуск проверен: Linux · x64 · glibc');expect(html).toContain('Запуск не проверялся на: macOS · Apple Silicon, Windows · x64');
        expect(html).toContain('не подтверждает работу на этих платформах');expect(html).toContain('Обнаружено инструментов: 2');expect(html).not.toContain('Все платформы проверены');
    });
    it('Без testedTarget не заявляет успешный запуск', () => {
        const value=job();value.runtimeVerification={...receipt(),testedTarget:null};const html=render(value);
        expect(html).toContain('Запуск на целевой платформе не подтверждён');expect(html).not.toContain('Запуск проверен:');
    });
    it('Отказ и отсутствие OS isolation видны вместе с диагностикой', () => {
        const value=job();value.runtimeVerification={...receipt(),status:'failed',isolation:{kind:'process',osEnforced:false,network:'denied'},diagnostics:[{code:'timeout',message:'MCP не ответил на initialize'}]};
        const html=render(value);expect(html).toContain('Проверка запуска не пройдена');expect(html).toContain('Изоляция средствами ОС не подтверждена');expect(html).toContain('MCP не ответил на initialize');
    });
    it('Показывает persisted propose/review и границу публикации', () => {
        const value=job();value.agentSteps!.push({attempt:2,stage:'review',state:'STARTED'});expect(render(value)).toContain('Попытка 2: ревью результата');expect(render(value)).toContain('Ревью — текущий этап');
        value.publicationStartedAt='2026-10-23T00:01:00Z';expect(render(value)).toContain('Публикация — текущий этап');
    });
    it('Отмена проверки не превращается в успешное свидетельство', () => {
        const value=job();value.runtimeVerification={...receipt(),status:'cancelled'};expect(render(value)).toContain('Проверка запуска отменена');expect(render(value)).not.toContain('Запуск проверен:');
    });
    it('Passed предыдущего кандидата не относится к последней неудачной попытке', () => {
        const value=job();value.state='FAILED';value.runtimeVerificationAttempt=1;value.agentSteps!.push({attempt:2,stage:'propose',state:'SUCCEEDED'});
        const html=render(value);expect(html).toContain('Сохранённая проверка: попытка 1');expect(html).toContain('Результат относится к кандидату этой попытки');expect(html).toContain('Попытка 2: подготовка рецепта');
        expect(html).not.toContain('Сохранённая проверка: попытка 2');
    });
    it.each(['FAILED','CANCELLED'] as const)('Терминальная сборка %s показывает незавершённый journal шаг прерванным', state => {
        const value=job();value.state=state;value.agentSteps=[{attempt:1,stage:'propose',state:'STARTED'},{attempt:1,stage:'review',state:'STARTED'}];
        const html=render(value);expect(html).toContain('Рецепт: Прервано');expect(html).toContain('Ревью: Прервано');expect(html).not.toContain('Выполняется');expect(html).not.toContain('текущий этап');expect(html).not.toContain('aria-current="step"');
    });
});
