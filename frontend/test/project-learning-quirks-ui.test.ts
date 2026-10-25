import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {LearningQuirksImportModal} from '../src/features/ProjectLearning/LearningQuirksImportModal';
import type {IBridgeJob} from '../src/features/McpBridge/api';

const fixtures=vi.hoisted(()=>({bridge:{} as Record<string,unknown>,refresh:undefined as (()=>void)|undefined,collect:undefined as (()=>void)|undefined,collectDisabled:true,action:{submit:vi.fn(),cancel:vi.fn(),check:vi.fn(),busy:false,blocked:false,error:'',submitted:undefined as IBridgeJob|undefined}}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>fixtures.bridge}));
vi.mock('../src/features/ProjectLearning/useLearningQuirksImport',()=>({useLearningQuirksImport:()=>fixtures.action}));
vi.mock('antd',async original=>{const antd=await original<typeof import('antd')>();return {...antd,Button:(props:Parameters<typeof antd.Button>[0])=>{if(props.children==='Обновить')fixtures.refresh=props.onClick as ()=>void;if(props.children==='Собрать кварки'){fixtures.collect=props.onClick as ()=>void;fixtures.collectDisabled=!!props.disabled;}return createElement(antd.Button,props);},Modal:({children,footer,title}:{children?:ReactNode;footer?:ReactNode;title?:ReactNode})=>createElement('section',null,title,children,footer)};});
const projectId='prj-quirks',instanceId='11111111-1111-4111-8111-111111111111',bindingId='a'.repeat(64);
const device={id:'device-fixture',name:'Рабочий Mac',online:true,report:{capabilities:['project-learning-quirks-v1'],bindings:[{projectId,bindingId,instanceId}]}};
const installation={deviceId:device.id,projectId,assetId:'rag',assetKind:'mcp',version:12,name:'OpenCodeRAG',manifest:'b'.repeat(64),bindingId,isCurrentBinding:true,ragUi:{supported:true},learningQuirks:{supported:true}};
const render=(props:Partial<Parameters<typeof LearningQuirksImportModal>[0]>={})=>renderToStaticMarkup(createElement(LearningQuirksImportModal,{open:true,projectId,canManage:true,onClose:()=>{},...props}));
beforeEach(()=>{vi.clearAllMocks();fixtures.collect=undefined;fixtures.collectDisabled=true;fixtures.action.blocked=false;fixtures.action.error='';fixtures.action.submitted=undefined;fixtures.bridge={devices:[device],installations:[installation],jobs:[],devicesReady:true,installationsReady:true,errors:{jobs:''},error:'',loading:false,reload:vi.fn(async()=>{})};});
describe('Explicit RAG quirk collection UI',()=>{
    it('refresh checks the durable fence even when storage failure left no in-memory intent',()=>{
        fixtures.action.blocked=true;fixtures.action.error='Хранение данных недоступно';render();fixtures.refresh!();expect(fixtures.action.check).toHaveBeenCalledOnce();expect(fixtures.bridge.reload).toHaveBeenCalledOnce();
    });
    it('explains trust and selects named device/installation without editable source paths',()=>{
        const html=render();expect(html).toContain('Рабочий Mac');expect(html).toContain('OpenCodeRAG');expect(html).toContain('требуют проверки человеком');
        expect(html).toContain('Кварки станут сообщённым опытом');expect(html).not.toContain('quirks.jsonl');expect(html).not.toContain('textarea');
    });
    it.each(['mcp','plugin'] as const)('collects from a confirmed core-only %s installation without a separate UI',assetKind=>{
        fixtures.bridge.installations=[{...installation,assetKind,ragUi:undefined}];
        const html=render();expect(html).toContain('OpenCodeRAG');expect(fixtures.collectDisabled).toBe(false);
        fixtures.collect!();expect(fixtures.action.submit).toHaveBeenCalledExactlyOnceWith({kind:'import-learning-quirks',deviceId:device.id,projectId,
            assetId:installation.assetId,assetKind,version:installation.version,expectedManifest:installation.manifest,expectedBindingId:bindingId,
            expectedInstanceId:instanceId,expectedConfigurationRevisions:[]});
    });
    it('explains upgrading a recognized core without a confirmed quirks format and never submits it',()=>{
        fixtures.bridge.installations=[{...installation,ragUi:undefined,learningQuirks:undefined,hostedEmbedding:{supported:true}}];
        expect(render()).toContain('Обновите OpenCodeRAG из каталога');expect(fixtures.collectDisabled).toBe(true);
        fixtures.collect!();expect(fixtures.action.submit).not.toHaveBeenCalled();
    });
    it('explains empty installation and current-version blockers',()=>{
        fixtures.bridge.installations=[];expect(render()).toContain('Установите OpenCodeRAG');
        fixtures.bridge.installations=[{...installation,learningQuirks:undefined}];expect(render()).toContain('Обновите OpenCodeRAG из каталога');
    });
    it('keeps history and cancellation available after the collection flag is off',()=>{
        fixtures.bridge.jobs=[{id:'job-fixture',deviceId:device.id,projectId,kind:'import-learning-quirks',state:'running',message:'Сбор выполняется'}];
        const html=render({enabled:false});expect(html).toContain('Сбор кварков выключен');expect(html).toContain('История сборов');expect(html).toContain('Остановить');
    });
    it('puts the exact-key recovered job before the first ten history rows with the flag OFF',()=>{
        const recovered={id:'recovered',deviceId:device.id,projectId,kind:'import-learning-quirks',state:'running',message:'Исходный сбор выполняется'} as IBridgeJob;
        fixtures.action.submitted=recovered;fixtures.bridge.jobs=[...Array.from({length:10},(_,index)=>({...recovered,id:'recent-'+index,state:'failed',message:'Завершено'})),{...recovered,message:'Устаревшая история'}];
        const html=render({enabled:false});expect(html).toContain('Исходный сбор выполняется');expect(html).toContain('Остановить');expect(html).not.toContain('Устаревшая история');
    });
    it('shows partial receipt as recoverable partial work and keeps reported text out of public job UI',()=>{
        fixtures.bridge.jobs=[{id:'job-fixture',deviceId:device.id,projectId,kind:'import-learning-quirks',state:'failed',message:'failed',
            result:{schemaVersion:1,status:'partial',sourceCount:3,imported:1,skipped:1,remaining:1,fileSha256:'a'.repeat(64),safeRetry:true}}];
        const html=render();expect(html).toContain('Сохранена часть опыта');expect(html).toContain('дубликаты не появятся');expect(html).toContain('осталось: 1');
    });
    it('reader roles can inspect history without a cancellation control',()=>{
        fixtures.bridge.jobs=[{id:'job-fixture',deviceId:device.id,projectId,kind:'import-learning-quirks',state:'running',message:'running'}];
        const html=render({canManage:false});expect(html).not.toContain('>Остановить<');expect(html).toContain('Сообщать опыт может разработчик');
    });
});
