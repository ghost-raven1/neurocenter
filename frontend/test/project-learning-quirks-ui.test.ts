import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {LearningQuirksImportModal} from '../src/features/ProjectLearning/LearningQuirksImportModal';

const fixtures=vi.hoisted(()=>({bridge:{} as Record<string,unknown>,action:{submit:vi.fn(),cancel:vi.fn(),busy:false,error:'',submitted:undefined}}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>fixtures.bridge}));
vi.mock('../src/features/ProjectLearning/useLearningQuirksImport',()=>({useLearningQuirksImport:()=>fixtures.action}));
vi.mock('antd',async original=>({...await original<typeof import('antd')>(),Modal:({children,footer,title}:{children?:ReactNode;footer?:ReactNode;title?:ReactNode})=>createElement('section',null,title,children,footer)}));
const projectId='prj-quirks',instanceId='11111111-1111-4111-8111-111111111111',bindingId='a'.repeat(64);
const device={id:'device-fixture',name:'Рабочий Mac',online:true,report:{capabilities:['project-learning-quirks-v1'],bindings:[{projectId,bindingId,instanceId}]}};
const installation={deviceId:device.id,projectId,assetId:'rag',assetKind:'mcp',version:12,name:'OpenCodeRAG',manifest:'b'.repeat(64),bindingId,isCurrentBinding:true,ragUi:{supported:true},learningQuirks:{supported:true}};
const render=(props:Partial<Parameters<typeof LearningQuirksImportModal>[0]>={})=>renderToStaticMarkup(createElement(LearningQuirksImportModal,{open:true,projectId,canManage:true,onClose:()=>{},...props}));
beforeEach(()=>{fixtures.bridge={devices:[device],installations:[installation],jobs:[],devicesReady:true,installationsReady:true,errors:{jobs:''},error:'',loading:false,reload:vi.fn(async()=>{})};});
describe('Explicit RAG quirk collection UI',()=>{
    it('explains trust and selects named device/installation without editable source paths',()=>{
        const html=render();expect(html).toContain('Рабочий Mac');expect(html).toContain('OpenCodeRAG');expect(html).toContain('требуют проверки человеком');
        expect(html).toContain('Кварки станут сообщённым опытом');expect(html).not.toContain('quirks.jsonl');expect(html).not.toContain('textarea');
    });
    it('explains empty installation and current-version blockers',()=>{
        fixtures.bridge.installations=[];expect(render()).toContain('Установите OpenCodeRAG');
        fixtures.bridge.installations=[{...installation,learningQuirks:undefined}];expect(render()).toContain('Обновите OpenCodeRAG из каталога');
    });
    it('keeps history and cancellation available after the collection flag is off',()=>{
        fixtures.bridge.jobs=[{id:'job-fixture',deviceId:device.id,projectId,kind:'import-learning-quirks',state:'running',message:'Сбор выполняется'}];
        const html=render({enabled:false});expect(html).toContain('Сбор кварков выключен');expect(html).toContain('История сборов');expect(html).toContain('Остановить');
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
