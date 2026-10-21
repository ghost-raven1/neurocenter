import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AssetSources from '../src/features/AssetSources/AssetSources';
import { agentCatalogApi } from '../src/features/AgentCatalog/api';
import { baseApi } from '../src/core/api';
import { agent } from './agent-fixtures';
import type { ICatalogAgent } from '../src/features/AgentCatalog/types';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return[slot.value,(next:unknown)=>{slot.value=typeof next==='function'?next(slot.value):next;}];},
        useRef:(initial:unknown)=>(slots[cursor++]??={value:{current:initial}}).value,
        useCallback:(value:unknown,deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return previous.value;slots[index]={value,deps};return value;},
        useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const ui=vi.hoisted(()=>({owner:'admin-a',owners:new Map<string,()=>()=>boolean>(),buttons:[] as Array<{disabled?:boolean;onClick:()=>void}>,editor:undefined as {agent:ICatalogAgent;onClose:()=>void;onSaved:()=>Promise<void>}|undefined,draft:'',editorId:''}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),...hooks}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const scope=ui.owner;let captureOwner=ui.owners.get(scope);if(!captureOwner){captureOwner=()=>()=>scope===ui.owner;ui.owners.set(scope,captureOwner);}return{scope,captureOwner};}}));
vi.mock('../src/core/api',()=>({baseApi:{get:vi.fn(),post:vi.fn()},bffApi:{getSkill:vi.fn(),getAiPlugin:vi.fn()}}));
vi.mock('../src/features/AgentCatalog/api',()=>({agentCatalogApi:{get:vi.fn()}}));
vi.mock('../src/features/AssetSources/useAssetImports',()=>({useAssetImports:()=>({blocked:false,busy:false})}));
vi.mock('../src/features/AssetManagement/ArchiveAssetButton',()=>({ArchiveAssetButton:()=>null}));
vi.mock('../src/modules/Store/StoreEditModal',()=>({default:()=>null}));
vi.mock('../src/features/ModelCatalog/ModelEditModal',()=>({ModelEditModal:()=>null}));
vi.mock('../src/modules/Store/storeHelpers',()=>({fromPlugin:vi.fn(),fromSkill:vi.fn()}));
vi.mock('../src/features/AgentCatalog/AgentEditModal',()=>({AgentEditModal:(props:NonNullable<typeof ui.editor>)=>{if(ui.editorId!==props.agent.id){ui.editorId=props.agent.id;ui.draft='';}ui.editor=props;return createElement('div',null,props.agent.name,ui.draft);}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;const input=()=>null;
    return{Card:({children,title}:{children?:ReactNode;title?:ReactNode})=>createElement('div',null,title,children),Space:content,Tag:content,Typography:{Title:content,Text:content,Paragraph:content},Checkbox:content,
        Input:Object.assign(input,{Search:input}),List:()=>null,Spin:()=>null,Empty:()=>null,Modal:()=>null,
        Alert:({message}:{message:ReactNode})=>message,Button:({children,disabled,onClick}:{children?:ReactNode;disabled?:boolean;onClick:()=>void})=>{if(children==='Редактировать')ui.buttons.push({disabled,onClick});return children;}};
});
const source={source:{verified:true,commit:'a'.repeat(40)},assets:['a','b'].map(id=>({id:'source-'+id,kind:'agent',name:'Агент '+id,version:'1',license:'MIT',dependencies:[],imported:{id:'agent-'+id,originVersion:'1',version:1,updateAvailable:false}}))};
function render(){hooks.begin();ui.buttons=[];const html=renderToStaticMarkup(createElement(AssetSources));hooks.commit();return html;}
async function settle(){for(let n=0;n<15;n++)await Promise.resolve();return render();}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
beforeEach(()=>{vi.clearAllMocks();ui.owner='admin-a';ui.owners.clear();ui.editor=undefined;ui.draft='';ui.editorId='';vi.mocked(baseApi.get).mockResolvedValue({data:source});});
afterEach(()=>hooks.dispose());

it('Двойной клик и открытие второй карточки во время GET не создают конкурирующий редактор',async()=>{
    const first=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValue(first.promise);render();await settle();const[openA,openB]=ui.buttons;
    openA.onClick();openA.onClick();openB.onClick();expect(agentCatalogApi.get).toHaveBeenCalledExactlyOnceWith('agent-a');render();expect(ui.buttons.every(button=>button.disabled)).toBe(true);
    first.resolve(agent({id:'agent-a',name:'Агент a'}));await settle();ui.draft='НЕСОХРАНЁННЫЙ ПРОМПТ';expect(render()).toContain(ui.draft);expect(ui.editor?.agent.id).toBe('agent-a');expect(agentCatalogApi.get).toHaveBeenCalledOnce();
});
it('Поздний A старого owner не заменяет B draft и не освобождает активный lock B (ABA)',async()=>{
    const first=deferred<ICatalogAgent>(),second=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);render();await settle();ui.buttons[0].onClick();
    ui.owner='admin-b';render();await settle();ui.buttons[1].onClick();first.resolve(agent({id:'agent-a'}));await settle();expect(ui.editor).toBeUndefined();expect(ui.buttons.every(button=>button.disabled)).toBe(true);
    ui.buttons[0].onClick();expect(agentCatalogApi.get).toHaveBeenCalledTimes(2);second.resolve(agent({id:'agent-b',name:'Агент b'}));await settle();ui.draft='B DRAFT';expect(render()).toContain('B DRAFT');expect(ui.editor?.agent.id).toBe('agent-b');
});
it('Поздний A после открытия B не заменяет уже введённый B prompt',async()=>{
    const first=deferred<ICatalogAgent>(),second=deferred<ICatalogAgent>();vi.mocked(agentCatalogApi.get).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);render();await settle();ui.buttons[0].onClick();
    ui.owner='admin-b';render();await settle();ui.buttons[1].onClick();second.resolve(agent({id:'agent-b',name:'Агент b'}));await settle();ui.draft='СОХРАНИ B DRAFT';render();
    first.resolve(agent({id:'agent-a',name:'Агент a'}));await settle();expect(render()).toContain('СОХРАНИ B DRAFT');expect(ui.editor?.agent.id).toBe('agent-b');
});
it('Ошибка открытия отпускает lock для повторного запроса, обычный refresh не сбрасывает draft',async()=>{
    vi.mocked(agentCatalogApi.get).mockRejectedValueOnce(new Error('Нет сети')).mockResolvedValueOnce(agent({id:'agent-b',name:'Агент b'}));render();await settle();ui.buttons[0].onClick();await settle();expect(ui.buttons.every(button=>!button.disabled)).toBe(true);
    ui.buttons[1].onClick();await settle();ui.draft='МОЙ PROMPT';await ui.editor!.onSaved();expect(render()).toContain('МОЙ PROMPT');expect(ui.editor?.agent.id).toBe('agent-b');
});
