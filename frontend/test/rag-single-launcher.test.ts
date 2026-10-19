import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import RagTab from '../src/modules/Projects/components/RagTab';
import type {IProjectEmbedding} from '../src/features/ProjectEmbedding/model';
import type {IBridgeJob} from '../src/features/McpBridge/api';
import {ragUiFixture} from './ragUiFixture';

const fixture=vi.hoisted(()=>({bridge:undefined as ReturnType<typeof ragUiFixture>['bridge']|undefined,
    selection:undefined as IProjectEmbedding|undefined,job:undefined as IBridgeJob|undefined,
    create:vi.fn(),save:vi.fn(),open:vi.fn()}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{email:'admin@example.test',activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'owner-one',captureOwner:()=>()=>true})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/core/api/bff',()=>({default:{getRagSummary:vi.fn()}}));
vi.mock('../src/features/McpBridge/BridgeConnection',()=>({BridgeConnection:()=>null}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>fixture.bridge}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{create:fixture.create}}));
vi.mock('../src/features/ProjectEmbedding/useProjectEmbedding',()=>({useProjectEmbedding:()=>({
    selection:fixture.selection,catalog:{items:[fixture.selection!.model],assignedModelIds:[fixture.selection!.model!.id]},modelId:fixture.selection!.model!.id,
    loading:false,catalogLoading:false,saving:false,readError:'',catalogError:'',saveError:'',catalogAccessDenied:false,refresh:vi.fn(),choose:vi.fn(),save:fixture.save,
})}));
vi.mock('../src/features/McpBridge/useLocalJob',()=>({useLocalJob:()=>({job:fixture.job,busy:false,error:'',canRetry:()=>false,submit:fixture.create})}));
vi.mock('../src/features/McpBridge/ragUi/useRagUiLauncher',()=>({useRagUiLauncher:()=>({busy:false,error:'',submitted:undefined,submit:fixture.open})}));

beforeEach(()=>{
    vi.clearAllMocks();const current=ragUiFixture();current.device.report.root='/fixture/root';current.device.report.capabilities!.push('hosted-rag-model-v1','hosted-rag-grants-v1');
    current.item.hostedEmbedding={supported:true};current.item.inspection={schemaVersion:1,projectId:current.item.projectId,bindingId:current.binding.bindingId,
        assetId:current.item.assetId,assetKind:current.item.assetKind,version:current.item.version,manifest:current.item.manifest,
        checkedAt:'2026-10-20T01:00:00Z',readiness:'unverified',state:'checked',status:'synced',issues:[]};
    fixture.bridge=current.bridge;
    const model={id:'model-one',name:'Синтетическая модель',description:'',capability:'embedding' as const,runtime:'ollama' as const,model:'qwen3-embedding:4b',
        manifestSha256:'c'.repeat(64),dimension:2560,source:'custom' as const,revision:2,createdAt:'2026-10-20',updatedAt:'2026-10-20'};
    const pin='d'.repeat(64);fixture.selection={projectId:current.binding.projectId,revision:1,expectedDimension:2560,model,modelPin:pin,profile:{provider:'openai',model:'neurocenter/model-one/sha256/'+pin,dimension:2560}};
    fixture.job=current.job({kind:'connect-rag-model',state:'succeeded',result:{status:'connected',revision:1,modelPin:pin,profile:fixture.selection.profile,requiresRestart:true}});
});

describe('Единственный запуск интерфейса знаний на странице проекта',()=>{
    it('После успешного подключения модели настоящая вкладка показывает один запуск окна и не создаёт автоматических заданий',()=>{
        const html=renderToStaticMarkup(createElement(RagTab,{projectKey:'prj-one'}));
        expect(html).toContain('Подключение модели проверено');
        expect(html).toContain('Локальная база знаний через мост');
        expect(html.match(/Открыть OpenCodeRAG в отдельном окне/g)).toHaveLength(1);
        expect(fixture.create).not.toHaveBeenCalled();expect(fixture.save).not.toHaveBeenCalled();expect(fixture.open).not.toHaveBeenCalled();
    });
});
