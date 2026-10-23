import './feature-flags-enabled';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ModelCatalog} from '../src/features/ModelCatalog/ModelCatalog';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';

const ui=vi.hoisted(()=>({loading:false,error:'',assigned:false,targetBlocked:true,targetReason:'Выберите компьютер для локального OpenCodeRAG.',
    targetKind:'computer',targetMode:'computer',pending:false,busy:false,needsInput:false}));
const model:ICatalogModel={id:'model-qa-ready',name:'Готовая удалённая модель',description:'Проверенный API',runtime:'remote-openai',capability:'embedding',
    model:'qa-embedding',modelVersion:'qa-v1',dimension:7,verificationSha256:'a'.repeat(64),manifestSha256:null,modelPin:'b'.repeat(64),source:'custom',revision:1,createdAt:'2026-10-21',updatedAt:'2026-10-21'};
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa',captureOwner:()=>()=>true})}));
vi.mock('../src/features/ModelCatalog/useModelCatalog',()=>({useModelCatalog:()=>({catalog:{items:[model],assignedModelIds:ui.assigned?[model.id]:[]},loading:ui.loading,error:ui.error,refresh:vi.fn()})}));
vi.mock('../src/features/ProjectEmbedding/useProjectReindex',()=>({useProjectReindex:()=>({pending:ui.pending,busy:ui.busy,plan:ui.needsInput?{state:'needs_input'}:undefined})}));
vi.mock('../src/features/ProjectEmbedding/ProjectReindexStatus',()=>({ProjectReindexStatus:()=>null}));
vi.mock('../src/features/ProjectEmbedding/EmbeddingTarget',()=>({useEmbeddingTarget:()=>({blocked:ui.targetBlocked,blocker:ui.targetKind,mode:ui.targetMode,reason:ui.targetReason}),EmbeddingTargetFields:()=>null}));
vi.mock('../src/features/ModelCatalog/useModelHosting',()=>({useModelHosting:()=>({hosting:{state:'ready',message:'API проверен',checkedAt:'2026-10-21T00:00:00Z'},busy:false,loading:false,error:'',refresh:vi.fn()})}));

function render(canManage=true,isMain=true):string{
    return renderToStaticMarkup(createElement(ModelCatalog,{projectId:'prj-qa',canManage,isMain}));
}
function button(html:string,label:string):string{
    const found=[...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match=>match[0]).find(value=>value.includes(label));
    expect(found,'Missing actual ModelCard button: '+label).toBeDefined();return found!;
}
const disabled=(html:string,label:string)=>/\sdisabled(?:=|\s|>)/.test(button(html,label));
function actionWrapper(html:string,label:string):string{
    const start=html.indexOf(button(html,label)),wrapper=html.lastIndexOf('<span',start);
    expect(wrapper).toBeGreaterThanOrEqual(0);return html.slice(wrapper,start);
}
beforeEach(()=>{ui.loading=false;ui.error='';ui.assigned=false;ui.targetBlocked=true;ui.targetReason='Выберите компьютер для локального OpenCodeRAG.';ui.targetKind='computer';ui.targetMode='computer';ui.pending=false;ui.busy=false;ui.needsInput=false;});

describe('Actual ModelCatalog → ModelCard keeps permissions separate from assignment availability',()=>{
    it('Main admin without a target sees their disabled action and its actual reason, retaining edit and archive',()=>{
        const html=render();expect(disabled(html,'Добавить в проект')).toBe(true);
        expect(html).toContain('aria-label="'+ui.targetReason+'"');expect(html).not.toContain('Добавляет администратор проекта');
        expect(disabled(html,'Изменить модель '+model.name)).toBe(false);
        expect(disabled(html,'Убрать из каталога модель '+model.name)).toBe(false);
    });
    it('Project admin has the same truthful target blocker without gaining global model management',()=>{
        const html=render(true,false);expect(disabled(html,'Добавить в проект')).toBe(true);expect(html).not.toContain('Добавляет администратор проекта');
        expect(html).not.toContain('Изменить модель '+model.name);expect(html).not.toContain('Убрать из каталога модель '+model.name);
    });
    for(const [state,reason]of [
        ['pending','Дождитесь завершения подключения модели и переиндексации.'],
        ['busy','Дождитесь завершения подключения модели и переиндексации.'],
        ['loading','Дождитесь загрузки актуального каталога моделей.'],
        ['error','Обновите каталог моделей перед изменением проекта.'],
        ['needsInput','Подтвердите или отмените подготовленную смену модели.'],
    ]as const)it(state+' disables assignment without reporting a missing administrator role',()=>{
        ui.targetBlocked=false;if(state==='error')ui.error='Временная ошибка обновления';else ui[state]=true;
        const html=render();expect(disabled(html,'Добавить в проект')).toBe(true);expect(html).toContain('aria-label="'+reason+'"');
        expect(html).not.toContain('Добавляет администратор проекта');
        if(state==='pending'||state==='busy'||state==='needsInput')expect(disabled(html,'Изменить модель '+model.name)).toBe(false);
        ui.assigned=true;const assigned=render();expect(disabled(assigned,'Подключить модель')).toBe(true);expect(disabled(assigned,'Убрать из проекта')).toBe(true);
        expect(actionWrapper(assigned,'Подключить модель')).toContain(reason);
    });
    it('A blocked unrelated embedding target does not prevent removing an assigned model',()=>{
        ui.assigned=true;const html=render();expect(disabled(html,'Убрать из проекта')).toBe(false);
        expect(actionWrapper(html,'Убрать из проекта')).not.toContain(ui.targetReason);
        expect(disabled(html,'Подключить модель')).toBe(true);expect(actionWrapper(html,'Подключить модель')).toContain(ui.targetReason);
    });
    it('A ready chosen target enables the actual assignment action',()=>{
        ui.targetBlocked=false;expect(disabled(render(),'Добавить в проект')).toBe(false);
        ui.assigned=true;const assigned=render();expect(disabled(assigned,'Подключить модель')).toBe(false);expect(disabled(assigned,'Убрать из проекта')).toBe(false);
    });
    it('Missing checked OpenCodeRAG exposes a project-scoped preparation link beside the blocked model action',()=>{
        ui.targetKind='installation';const html=render(true,false);
        expect(disabled(html,'Добавить в проект')).toBe(true);expect(html).toContain('Подготовить OpenCodeRAG');
        expect(html).toMatch(/<a\b[^>]*href="\/store\?q=OpenCodeRAG[^\"]*&amp;p=prj-qa"[^>]*><span>Подготовить OpenCodeRAG<\/span><\/a>/);
        ui.assigned=true;const assigned=render(true,false);expect(disabled(assigned,'Подключить модель')).toBe(true);expect(disabled(assigned,'Убрать из проекта')).toBe(false);
        expect(assigned).toContain('Подготовить OpenCodeRAG');expect(render(false,false)).not.toContain('Подготовить OpenCodeRAG');
    });
    it('Preparation never bypasses missing computer/binding, an existing operation, stale catalog or server-only selection',()=>{
        for(const kind of ['computer','bridge','binding','loading','selection','inspection']){ui.targetKind=kind;expect(render()).not.toContain('Подготовить OpenCodeRAG');}
        ui.targetKind='installation';ui.targetMode='server';expect(render()).not.toContain('Подготовить OpenCodeRAG');ui.targetMode='computer';
        for(const state of ['pending','busy','loading','error','needsInput'] as const){
            if(state==='error')ui.error='Нет свежего каталога';else ui[state]=true;
            expect(render()).not.toContain('Подготовить OpenCodeRAG');
            if(state==='error')ui.error='';else ui[state]=false;
        }
    });
    it('Read-only users retain the real role explanation instead of an administrator action',()=>{
        const html=render(false,false);expect(html).toContain('Добавляет администратор проекта');expect(html).not.toContain('Добавить в проект');
        ui.assigned=true;const assigned=render(false,false);expect(assigned).toContain('Доступна участникам проекта');expect(assigned).not.toContain('Убрать из проекта');
        expect(assigned).not.toContain('Подключить модель');
    });
});
