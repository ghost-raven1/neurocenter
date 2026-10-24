// @vitest-environment jsdom
import './feature-flags-enabled';
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';
import {ModelCatalog} from '../src/features/ModelCatalog/ModelCatalog';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';
import type {IProjectEmbedding} from '../src/features/ProjectEmbedding/model';

const ui=vi.hoisted(()=>({loading:false,error:'',assigned:false,targetBlocked:true,targetReason:'Выберите компьютер для локального OpenCodeRAG.',
    targetKind:'computer',targetMode:'computer',pending:false,busy:false,needsInput:false,captureOwner:()=>()=>true}));
const model:ICatalogModel={id:'model-qa-ready',name:'Готовая удалённая модель',description:'Проверенный API',runtime:'remote-openai',capability:'embedding',
    model:'qa-embedding',modelVersion:'qa-v1',dimension:7,verificationSha256:'a'.repeat(64),manifestSha256:null,modelPin:'b'.repeat(64),source:'custom',revision:1,createdAt:'2026-10-21',updatedAt:'2026-10-21'};
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),post:vi.fn()}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa',captureOwner:ui.captureOwner})}));
vi.mock('../src/features/ModelCatalog/useModelCatalog',()=>({useModelCatalog:()=>({catalog:{items:[model],assignedModelIds:ui.assigned?[model.id]:[]},loading:ui.loading,error:ui.error,refresh:vi.fn()})}));
vi.mock('../src/features/ProjectEmbedding/useProjectReindex',()=>({useProjectReindex:()=>({pending:ui.pending,busy:ui.busy,plan:ui.needsInput?{state:'needs_input'}:undefined})}));
vi.mock('../src/features/ProjectEmbedding/ProjectReindexStatus',()=>({ProjectReindexStatus:()=>null}));
vi.mock('../src/features/ProjectEmbedding/EmbeddingTarget',()=>({useEmbeddingTarget:()=>({blocked:ui.targetBlocked,blocker:ui.targetKind,mode:ui.targetMode,reason:ui.targetReason}),EmbeddingTargetFields:()=>null}));
vi.mock('../src/features/ModelCatalog/ModelHosting',()=>({ModelHosting:()=>null}));
vi.mock('../src/features/Discussions',()=>({CatalogFeedback:()=>null}));
vi.mock('../src/features/ModelCatalog/ModelDetails',()=>({ModelDetails:()=>null}));
vi.mock('../src/features/ModelCatalog/ModelEditModal',()=>({ModelEditModal:()=>null}));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal',()=>({RemoteConnectionModal:()=>null}));
vi.mock('../src/features/ModelCatalog/OpenCodeImportModal',()=>({OpenCodeImportModal:()=>null}));
vi.mock('../src/features/ModelCatalog/DeviceCodexConnectionModal',()=>({DeviceCodexConnectionModal:()=>null}));
vi.mock('../src/features/ModelChat/ModelChatModal',()=>({ModelChatModal:()=>null}));
vi.mock('../src/features/OpenCodeProviders/ProviderSetupModal',()=>({ProviderSetupModal:()=>null}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>createElement('div',null,children);
    return {Space:content,Row:content,Col:content,Tag:content,Tooltip:({children}:{children?:ReactNode})=>children,Empty:content,Spin:()=>null,
        Typography:{Title:content,Text:content,Paragraph:content},Input:{Search:()=>null},Checkbox:()=>null,
        Modal:({open,children}:{open:boolean;children?:ReactNode})=>open?content({children}):null,Radio:Object.assign(content,{Group:content}),
        Alert:({message,description,action}:{message:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',{role:'status'},message,description,action),
        Button:({children,onClick,disabled,href,...props}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean;href?:string;[key:string]:unknown})=>
            href?createElement('a',{href,'aria-disabled':disabled},children):createElement('button',{onClick,disabled,'aria-label':props['aria-label']},children),
    };
});

/** A valid empty selection is known server state, unlike a pending or failed selection read. */
function selection(selected:ICatalogModel|null=null):IProjectEmbedding{
    return {projectId:'prj-qa',revision:selected?1:0,expectedDimension:selected?.dimension??0,model:selected,modelPin:selected?.modelPin??null,
        profile:selected?{provider:'openai',model:`neurocenter/${selected.id}/sha256/${selected.modelPin}`,dimension:selected.dimension!}:null,
        activeGeneration:'11111111-1111-4111-8111-111111111111',activeSnapshot:selected?'c'.repeat(64):null,dataRevision:0};
}
let container:HTMLElement,root:Root;
async function render(canManage=true,isMain=true):Promise<HTMLElement>{
    await act(async()=>{root.render(createElement(ModelCatalog,{projectId:'prj-qa',canManage,isMain}));});return container;
}
function button(label:string):HTMLButtonElement{
    const found=[...container.querySelectorAll('button')].find(value=>(value.getAttribute('aria-label')||value.textContent)===label);
    expect(found,'Missing actual ModelCard button: '+label).toBeDefined();return found!;
}
function actionWrapper(label:string):HTMLElement{return button(label).parentElement!;}
beforeEach(()=>{
    vi.clearAllMocks();ui.loading=false;ui.error='';ui.assigned=false;ui.targetBlocked=true;ui.targetReason='Выберите компьютер для локального OpenCodeRAG.';ui.targetKind='computer';ui.targetMode='computer';ui.pending=false;ui.busy=false;ui.needsInput=false;
    vi.mocked(api.get).mockResolvedValue({data:selection()});
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
});
afterEach(async()=>{await act(async()=>{root.unmount();});container.remove();});

describe('Actual ModelCatalog → ModelCard keeps permissions separate from assignment availability',()=>{
    it('Main admin without a target sees their disabled action and its actual reason, retaining edit and archive',async()=>{
        await render();expect(button('Добавить в проект').disabled).toBe(true);
        expect(actionWrapper('Добавить в проект').getAttribute('aria-label')).toBe(ui.targetReason);expect(container.textContent).not.toContain('Добавляет администратор проекта');
        expect(button('Изменить модель '+model.name).disabled).toBe(false);
        expect(button('Убрать из каталога модель '+model.name).disabled).toBe(false);
    });
    it('Project admin has the same truthful target blocker without gaining global model management',async()=>{
        await render(true,false);expect(button('Добавить в проект').disabled).toBe(true);expect(container.textContent).not.toContain('Добавляет администратор проекта');
        expect(container.querySelector('[aria-label="Изменить модель '+model.name+'"]')).toBeNull();expect(container.querySelector('[aria-label="Убрать из каталога модель '+model.name+'"]')).toBeNull();
    });
    for(const [state,reason]of [
        ['pending','Дождитесь завершения подключения модели и переиндексации.'],
        ['busy','Дождитесь завершения подключения модели и переиндексации.'],
        ['loading','Дождитесь загрузки актуального каталога моделей.'],
        ['error','Обновите каталог моделей перед изменением проекта.'],
        ['needsInput','Подтвердите или отмените подготовленную смену модели.'],
    ]as const)it(state+' disables assignment without reporting a missing administrator role',async()=>{
        ui.targetBlocked=false;if(state==='error')ui.error='Временная ошибка обновления';else ui[state]=true;
        await render();expect(button('Добавить в проект').disabled).toBe(true);expect(actionWrapper('Добавить в проект').getAttribute('aria-label')).toBe(reason);
        expect(container.textContent).not.toContain('Добавляет администратор проекта');
        if(state==='pending'||state==='busy'||state==='needsInput')expect(button('Изменить модель '+model.name).disabled).toBe(false);
        ui.assigned=true;await render();expect(button('Подключить модель').disabled).toBe(true);expect(button('Убрать из проекта').disabled).toBe(true);
        expect(actionWrapper('Подключить модель').getAttribute('aria-label')).toBe(reason);
    });
    it('A blocked unrelated embedding target does not prevent removing an assigned model',async()=>{
        ui.assigned=true;await render();expect(button('Убрать из проекта').disabled).toBe(false);
        expect(actionWrapper('Убрать из проекта').getAttribute('aria-label')).not.toBe(ui.targetReason);
        expect(button('Подключить модель').disabled).toBe(true);expect(actionWrapper('Подключить модель').getAttribute('aria-label')).toBe(ui.targetReason);
    });
    it('A ready chosen target enables the actual assignment action after reading the current selection',async()=>{
        ui.targetBlocked=false;await render();expect(button('Добавить в проект').disabled).toBe(false);
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/projects/prj-qa/embedding');
        ui.assigned=true;await render();expect(button('Подключить модель').disabled).toBe(false);expect(button('Убрать из проекта').disabled).toBe(false);
        ui.targetBlocked=true;await render();expect(button('Подключить модель').disabled).toBe(true);expect(button('Убрать из проекта').disabled).toBe(false);
    });
    it('A pending selection blocks connection without removing project recovery actions',async()=>{
        let resolve!:(value:{data:IProjectEmbedding})=>void;
        vi.mocked(api.get).mockReturnValueOnce(new Promise(done=>{resolve=done;}));ui.assigned=true;ui.targetBlocked=false;
        await render();expect(button('Проверяем подключение').disabled).toBe(true);expect(button('Убрать из проекта').disabled).toBe(false);
        await act(async()=>{resolve({data:selection()});});expect(button('Подключить модель').disabled).toBe(false);
    });
    it('A failed selection stays unknown until the explicit recovery read succeeds',async()=>{
        vi.mocked(api.get).mockRejectedValueOnce(new Error('Выбор модели недоступен'));ui.assigned=true;ui.targetBlocked=false;
        await render();expect(button('Подключение не проверено').disabled).toBe(true);expect(button('Убрать из проекта').disabled).toBe(false);
        expect(container.textContent).toContain('Выбор модели недоступен');
        await act(async()=>{button('Обновить подключение модели').click();});expect(button('Подключить модель').disabled).toBe(false);
    });
    it('The actual selected profile keeps an already connected server model from reconnecting',async()=>{
        ui.assigned=true;ui.targetBlocked=false;ui.targetMode='server';vi.mocked(api.get).mockResolvedValueOnce({data:selection(model)});
        await render();expect(button('Модель подключена').disabled).toBe(true);expect(button('Убрать из проекта').disabled).toBe(false);
    });
    it('Missing checked OpenCodeRAG exposes a project-scoped preparation link beside the blocked model action',async()=>{
        ui.targetKind='installation';await render(true,false);
        expect(button('Добавить в проект').disabled).toBe(true);
        const link=container.querySelector<HTMLAnchorElement>('a')!;expect(link.textContent).toBe('Подготовить OpenCodeRAG');
        const href=new URL(link.href);expect(href.pathname).toBe('/store');expect(href.searchParams.get('q')).toBe('OpenCodeRAG (плагин)');expect(href.searchParams.get('p')).toBe('prj-qa');
        ui.assigned=true;await render(true,false);expect(button('Подключить модель').disabled).toBe(true);expect(button('Убрать из проекта').disabled).toBe(false);
        expect(container.textContent).toContain('Подготовить OpenCodeRAG');await render(false,false);expect(container.textContent).not.toContain('Подготовить OpenCodeRAG');
    });
    it('Preparation never bypasses missing computer/binding, an existing operation, stale catalog or server-only selection',async()=>{
        for(const kind of ['computer','bridge','binding','loading','selection','inspection']){ui.targetKind=kind;await render();expect(container.textContent).not.toContain('Подготовить OpenCodeRAG');}
        ui.targetKind='installation';ui.targetMode='server';await render();expect(container.textContent).not.toContain('Подготовить OpenCodeRAG');ui.targetMode='computer';
        for(const state of ['pending','busy','loading','error','needsInput'] as const){
            if(state==='error')ui.error='Нет свежего каталога';else ui[state]=true;
            await render();expect(container.textContent).not.toContain('Подготовить OpenCodeRAG');
            if(state==='error')ui.error='';else ui[state]=false;
        }
    });
    it('Read-only users retain the real role explanation instead of an administrator action',async()=>{
        await render(false,false);expect(container.textContent).toContain('Добавляет администратор проекта');expect(container.textContent).not.toContain('Добавить в проект');
        ui.assigned=true;await render(false,false);expect(container.textContent).toContain('Доступна участникам проекта');expect(container.textContent).not.toContain('Убрать из проекта');
        expect(container.textContent).not.toContain('Подключить модель');
    });
});
