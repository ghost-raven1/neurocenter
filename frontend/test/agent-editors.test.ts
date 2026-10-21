import './feature-flags-enabled';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEditModal } from '../src/features/AgentCatalog/AgentEditModal';
import { ProjectAgentEditor } from '../src/features/AgentCatalog/ProjectAgentEditor';
import { agentCatalogApi } from '../src/features/AgentCatalog/api';
import { agent, assignment, catalog } from './agent-fixtures';
import type { IAgentEditorValues } from '../src/features/AgentCatalog/AgentDefinitionFields';
import type { IAgentProjectPatch, ICatalogAgent } from '../src/features/AgentCatalog/types';

const ui=vi.hoisted(()=>({cursor:0,slots:[] as unknown[],owner:'main-admin',dirty:false,
    finish:undefined as ((values:IAgentEditorValues)=>void)|undefined,change:undefined as (()=>void)|undefined,cancel:undefined as (()=>void)|undefined,
    values:undefined as IAgentEditorValues|undefined,fields:undefined as unknown,buttons:new Map<string,()=>void>(),confirmation:undefined as {onOk:()=>void}|undefined,
    form:{setFieldsValue:(value:unknown)=>{ui.fields=value;},submit:()=>ui.finish?.(ui.values!)},
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useEffect:()=>undefined,
    useState:(initial:unknown)=>{const index=ui.cursor++;if(!(index in ui.slots))ui.slots[index]=typeof initial==='function'?initial():initial;return[ui.slots[index],(value:unknown)=>{ui.slots[index]=value;}];},
    useRef:(initial:unknown)=>{const index=ui.cursor++;return ui.slots[index]??=( {current:initial} );},
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner;return{captureOwner:()=>()=>owner===ui.owner};}}));
vi.mock('../src/features/AgentCatalog/useUnsavedAgentPrompt',()=>({useUnsavedAgentPrompt:(dirty:boolean)=>{ui.dirty=dirty;}}));
vi.mock('../src/features/AgentCatalog/AgentDefinitionFields',()=>({AgentDefinitionFields:()=>null,normalizedAgentDefinition:(value:unknown)=>value}));
vi.mock('../src/features/AgentCatalog/api',()=>({agentCatalogApi:{create:vi.fn(),update:vi.fn(),get:vi.fn(),list:vi.fn()}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    const Modal=Object.assign(({children,onCancel}:{children?:ReactNode;onCancel:()=>void})=>{ui.cancel=onCancel;return children;},{confirm:(options:typeof ui.confirmation)=>{ui.confirmation=options;return{destroy:()=>undefined};}});
    return {Modal,Form:Object.assign(({children,onFinish,onValuesChange}:{children?:ReactNode;onFinish:typeof ui.finish;onValuesChange:typeof ui.change})=>{ui.finish=onFinish;ui.change=onValuesChange;return children;},{useForm:()=>[ui.form],Item:content}),
        Input:()=>null,Typography:{Paragraph:content,Text:content},Space:content,Tag:content,Collapse:Object.assign(content,{Panel:content}),
        Alert:({message,description}:{message:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),
        Button:({children,onClick}:{children?:ReactNode;onClick?:()=>void})=>{const label=Array.isArray(children)?children.join(''):String(children);if(onClick)ui.buttons.set(label,onClick);return children;},
    };
});
const onClose=vi.fn(),onSaved=vi.fn(),onSave=vi.fn();
const values:IAgentEditorValues={name:agent().name,slug:agent().slug,description:agent().description,definition:{...agent().definition,prompt:'  # МОЙ DRAFT\n\nС отступами.  '}};
function renderTemplate(current?:ICatalogAgent){ui.cursor=0;ui.buttons.clear();return renderToStaticMarkup(createElement(AgentEditModal,{agent:current,onClose,onSaved}));}
function renderProject(){ui.cursor=0;ui.buttons.clear();return renderToStaticMarkup(createElement(ProjectAgentEditor,{projectId:'project-one',assignment:assignment(),revision:3,onClose,onSave}));}
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
beforeEach(()=>{vi.clearAllMocks();ui.cursor=0;ui.slots=[];ui.owner='main-admin';ui.dirty=false;ui.values=values;ui.fields=undefined;ui.confirmation=undefined;ui.buttons.clear();onSaved.mockResolvedValue(undefined);onSave.mockResolvedValue({revision:4});});

describe('Редактор общего шаблона агента',()=>{
    it('Сохраняет Markdown без обрезания, предотвращает double-submit и закрывается только после перечитывания',async()=>{
        const pending=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.create).mockReturnValue(pending.promise);renderTemplate();ui.finish!(values);ui.finish!(values);await flush();
        expect(agentCatalogApi.create).toHaveBeenCalledOnce();expect(onClose).not.toHaveBeenCalled();expect(agentCatalogApi.create).toHaveBeenCalledWith(expect.objectContaining({definition:expect.objectContaining({prompt:values.definition.prompt})}),expect.any(String));
        pending.resolve(agent());await flush();expect(onSaved).toHaveBeenCalledExactlyOnceWith(agent());expect(onClose).toHaveBeenCalledOnce();
    });
    it('Ошибка/потерянный ответ сохраняет форму и повторный requestKey',async()=>{
        vi.mocked(agentCatalogApi.create).mockRejectedValue(new Error('Сеть недоступна'));renderTemplate();ui.finish!(values);await flush();const key=vi.mocked(agentCatalogApi.create).mock.calls[0][1];
        const html=renderTemplate();expect(html).toContain('Сеть недоступна');expect(onClose).not.toHaveBeenCalled();ui.finish!(values);await flush();expect(vi.mocked(agentCatalogApi.create).mock.calls[1][1]).toBe(key);expect(onSaved).not.toHaveBeenCalled();
    });
    it('Успешный create с ошибкой refresh повторяется идемпотентно, текст остаётся',async()=>{
        vi.mocked(agentCatalogApi.create).mockResolvedValue(agent());onSaved.mockRejectedValue(new Error('Каталог не обновился'));renderTemplate();ui.finish!(values);await flush();const key=vi.mocked(agentCatalogApi.create).mock.calls[0][1];
        expect(renderTemplate()).toContain('Каталог не обновился');expect(onClose).not.toHaveBeenCalled();ui.finish!(values);await flush();expect(vi.mocked(agentCatalogApi.create).mock.calls[1][1]).toBe(key);
    });
    it('409 показывает актуальный prompt, не заменяет draft и требует явного решения перед rebase',async()=>{
        const newer=agent({version:2,definition:{...agent().definition,prompt:'СОВСЕМ ДРУГОЙ PROMPT'}});vi.mocked(agentCatalogApi.update).mockRejectedValueOnce({response:{status:409}}).mockResolvedValueOnce(newer);vi.mocked(agentCatalogApi.get).mockResolvedValue(newer);
        renderTemplate(agent());ui.finish!(values);await flush();const html=renderTemplate(agent());expect(html).toContain('СОВСЕМ ДРУГОЙ PROMPT');expect(vi.mocked(agentCatalogApi.update).mock.calls[0][0].version).toBe(1);expect(ui.fields).toBeUndefined();expect(agentCatalogApi.update).toHaveBeenCalledOnce();
        ui.buttons.get('Сохранить мой вариант поверх версии 2')!();await flush();expect(vi.mocked(agentCatalogApi.update).mock.calls[1][0].version).toBe(2);expect(vi.mocked(agentCatalogApi.update).mock.calls[1][1].definition.prompt).toBe(values.definition.prompt);
    });
    it('Закрытие dirty формы требует выбора; защита навигации получает dirty=true',()=>{
        renderTemplate();ui.change!();renderTemplate();expect(ui.dirty).toBe(true);ui.cancel!();expect(onClose).not.toHaveBeenCalled();expect(ui.confirmation).toBeDefined();ui.confirmation!.onOk();expect(onClose).toHaveBeenCalledOnce();
    });
    it('Поздний результат прежнего auth owner не закрывает новый редактор',async()=>{
        const pending=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.create).mockReturnValue(pending.promise);renderTemplate();ui.finish!(values);ui.owner='other-admin';pending.resolve(agent());await flush();expect(onClose).not.toHaveBeenCalled();expect(onSaved).not.toHaveBeenCalled();
    });
});

describe('Редактор проекта сохраняет exact pin и пользовательский draft',()=>{
    it('Записывает только prompt override с whole-set CAS, не меняет каталог',async()=>{
        renderProject();ui.finish!(values);await flush();expect(onSave).toHaveBeenCalledExactlyOnceWith(agent(),{overrides:{prompt:values.definition.prompt}},3);expect(agentCatalogApi.update).not.toHaveBeenCalled();expect(onClose).toHaveBeenCalledOnce();
    });
    it('Reset явно очищает прежние optional/permission fields до pinned template',()=>{
        renderProject();ui.buttons.get('Вернуть закреплённый шаблон')!();expect(ui.fields).toEqual({definition:{model:undefined,temperature:undefined,topP:undefined,steps:undefined,...agent().definition,permission:expect.objectContaining({read:'allow',edit:'ask',bash:undefined,webfetch:undefined})}});expect(onSave).not.toHaveBeenCalled();renderProject();expect(ui.dirty).toBe(true);
    });
    it('409 сохраняет draft, показывает актуальную настройку и не обновляет revision без явного решения',async()=>{
        const current=assignment({effective:{...agent().definition,prompt:'ПРОМПТ ДРУГОГО АДМИНА'}});onSave.mockRejectedValueOnce({response:{status:409}}).mockResolvedValueOnce({revision:6});vi.mocked(agentCatalogApi.list).mockResolvedValue(catalog({revision:5,assignments:[current]}));
        renderProject();ui.finish!(values);await flush();expect(renderProject()).toContain('ПРОМПТ ДРУГОГО АДМИНА');expect(onSave).toHaveBeenCalledOnce();expect(ui.fields).toBeUndefined();ui.buttons.get('Применить мой вариант к актуальным настройкам')!();await flush();expect(onSave).toHaveBeenLastCalledWith(agent(),{overrides:{prompt:values.definition.prompt}},5);
    });
    it('Удалённый другим админом агент не восстанавливается неявно редактором',async()=>{
        onSave.mockRejectedValue({response:{status:409}});vi.mocked(agentCatalogApi.list).mockResolvedValue(catalog({revision:5,assignments:[assignment({removed:true})]}));renderProject();ui.finish!(values);await flush();expect(renderProject()).toContain('Агент уже удалён из проекта');expect(ui.buttons.has('Применить мой вариант к актуальным настройкам')).toBe(false);expect(onClose).not.toHaveBeenCalled();
    });
    it('Ошибку desired save не маскирует закрытием формы',async()=>{
        onSave.mockRejectedValue(new Error('CAS отказ'));renderProject();ui.finish!(values);await flush();expect(renderProject()).toContain('CAS отказ');expect(onClose).not.toHaveBeenCalled();expect((vi.mocked(onSave).mock.calls[0][1] as IAgentProjectPatch).overrides?.prompt).toBe(values.definition.prompt);
    });
});
