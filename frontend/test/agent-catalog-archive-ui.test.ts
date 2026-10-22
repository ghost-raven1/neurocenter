import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentCatalog } from '../src/features/AgentCatalog/AgentCatalog';
import type { IAgentCatalog, ICatalogAgent } from '../src/features/AgentCatalog/types';
import { agent, assignment, bridge, catalog } from './agent-fixtures';

const ui=vi.hoisted(()=>({cursor:0,states:[] as unknown[],catalog:null as IAgentCatalog|null,refresh:vi.fn(),
    checks:new Map<string,{checked:boolean;onChange:(event:{target:{checked:boolean}})=>void}>(),cards:[] as Array<{agent:ICatalogAgent;onArchived:()=>void}>,
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useEffect:()=>undefined,
    useState:(initial:unknown)=>{const index=ui.cursor++;if(!(index in ui.states))ui.states[index]=typeof initial==='function'?initial():initial;return[ui.states[index],(value:unknown)=>{ui.states[index]=value;}];},
    useRef:(initial:unknown)=>{const index=ui.cursor++;return ui.states[index]??={current:initial};},
}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:()=>undefined})}));
vi.mock('react-redux',()=>({useSelector:()=>({activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'admin',captureOwner:()=>()=>true})}));
vi.mock('../src/features/AgentCatalog/useAgentCatalog',()=>({useAgentCatalog:()=>({catalog:ui.catalog,loading:false,error:'',refresh:ui.refresh})}));
vi.mock('../src/features/AgentCatalog/useAgentActions',()=>({useAgentActions:()=>({busy:false,error:'',notice:'',unconfirmed:false})}));
vi.mock('../src/features/AgentCatalog/useAgentReadiness',()=>({useAgentReadiness:()=>({items:[],loading:false,error:'',busy:false,uncertain:false})}));
vi.mock('../src/features/McpBridge/BridgeConnection',()=>({BridgeConnection:()=>null}));
vi.mock('../src/features/AgentCatalog/AgentEditModal',()=>({AgentEditModal:()=>null}));
vi.mock('../src/features/AgentCatalog/ProjectAgentEditor',()=>({ProjectAgentEditor:()=>null}));
vi.mock('../src/features/AgentCatalog/AgentDetails',()=>({AgentDetails:()=>null}));
vi.mock('../src/features/AgentCatalog/AgentCard',()=>({AgentCard:(props:typeof ui.cards[number])=>{ui.cards.push(props);return props.agent.name;}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;const input=()=>null;
    return{Space:content,Row:content,Col:content,Tooltip:content,Empty:content,Spin:()=>null,Modal:{confirm:vi.fn()},Typography:{Title:content,Text:content,Paragraph:content},Input:Object.assign(input,{Search:input}),
        Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),Button:content,
        Checkbox:({children,checked,onChange}:{children:string;checked:boolean;onChange:(event:{target:{checked:boolean}})=>void})=>{ui.checks.set(children,{checked,onChange});return children;}};
});
const archived=agent({id:'agent-archived',name:'Архивный агент',archivedAt:'2026-10-21'});
function render(isMain=true,projectId?:string,embedded=false){ui.cursor=0;ui.cards=[];ui.checks.clear();return renderToStaticMarkup(createElement(AgentCatalog,{isMain,canManage:isMain,projectId,embedded,bridge:bridge()}));}
beforeEach(()=>{vi.clearAllMocks();ui.states=[];ui.catalog=catalog({items:[agent(),archived],assignments:[],revision:null});ui.refresh.mockResolvedValue(ui.catalog);});

it('Главный админ явно открывает архив для restore; по умолчанию архив не засоряет каталог',async()=>{
    render();expect(ui.cards.map(card=>card.agent.id)).toEqual([agent().id]);expect(ui.checks.get('Показывать архив')?.checked).toBe(false);
    ui.checks.get('Показывать архив')!.onChange({target:{checked:true}});render();expect(ui.cards.map(card=>card.agent.id)).toContain(archived.id);
    ui.catalog={...ui.catalog!,items:[agent(),{...archived,archivedAt:null}]};ui.cards.find(card=>card.agent.id===archived.id)!.onArchived();await Promise.resolve();expect(ui.refresh).toHaveBeenCalledOnce();
    ui.checks.get('Показывать архив')!.onChange({target:{checked:false}});render();expect(ui.cards.map(card=>card.agent.id)).toContain(archived.id);
});
it('Роль без main-admin не получает archive filter и не наследует открытый архив',()=>{
    render();ui.checks.get('Показывать архив')!.onChange({target:{checked:true}});render(false);
    expect(ui.checks.has('Показывать архив')).toBe(false);expect(ui.cards.map(card=>card.agent.id)).toEqual([agent().id]);
});
it('Архивный pin виден в проекте; removed pin скрыт, но cleanup warning сохраняется',()=>{
    ui.catalog=catalog({items:[archived],assignments:[assignment({agentId:archived.id,card:archived})]});render(true,'project-one',true);expect(ui.cards.map(card=>card.agent.id)).toEqual([archived.id]);
    ui.catalog={...ui.catalog,assignments:[{...ui.catalog.assignments[0],removed:true}]};const html=render(true,'project-one',true);expect(ui.cards).toEqual([]);expect(html).toContain('Ожидают удаления из OpenCode: Архивный агент');
    ui.checks.get('Показывать архив')!.onChange({target:{checked:true}});render(true,'project-one',true);expect(ui.cards).toEqual([]);
});
