// @vitest-environment jsdom
import './feature-flags-enabled';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import ChatOverlay from '../src/features/ModelChat/ChatOverlay';
import type {IChatWorkspaceNavigation, IModelChatProps} from '../src/features/ModelChat/types';
import {modelChatApi} from '../src/features/ModelChat/api';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {detail, model} from './model-chat-fixtures';
import {projectRoom} from './project-chat-fixtures';
import {DEFAULT_PROJECT_CHAT_ROOM} from '../src/features/ProjectChat/types';

const h=vi.hoisted(()=>({owner:'',capture:()=>()=>true,send:vi.fn(),configure:vi.fn()}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:h.owner,captureOwner:h.capture})}));
vi.mock('react-redux',()=>({useSelector:(select:(value:unknown)=>unknown)=>select({userBlock:{user:{activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]}}})}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:vi.fn()})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('../src/modules/Projects/useAvailableProjects',()=>({useAvailableProjects:()=>({projects:[{id:'prj-one',name:'Проект'}],ready:true,loading:false,error:'',refresh:vi.fn()})}));
vi.mock('../src/features/ModelCatalog/useModelCatalog',()=>({useModelCatalog:()=>({catalog:{items:[{...model,id:'model-chat',modelPin:'a'.repeat(64)}],assignedModelIds:['model-chat']},loading:false,error:'',refresh:vi.fn()})}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{get:vi.fn(async()=>({...model,id:'model-chat'}))}}));
vi.mock('../src/features/ModelChat/api',()=>({modelChatApi:{list:vi.fn(),read:vi.fn(),agents:vi.fn()}}));
vi.mock('../src/features/ProjectChat/api',()=>({projectChatApi:{rooms:vi.fn()}}));
vi.mock('../src/features/ProjectChat/useProjectChat',()=>({useProjectChat:(_projectId:string,roomId:string)=>({
    detail:{...projectRoom(),room:{...projectRoom().room,id:roomId,title:roomId===DEFAULT_PROJECT_CHAT_ROOM?'Общий чат':'Закрытое ревью',visibility:roomId===DEFAULT_PROJECT_CHAT_ROOM?'PUBLIC':'PRIVATE'}},
    loading:false,error:'',action:'',retryPending:[],historyLoading:false,historyError:'',accessDenied:false,refresh:vi.fn(),refreshWorkflows:vi.fn(),clearAccess:vi.fn(),loadEarlier:vi.fn(),retry:vi.fn(),cancel:vi.fn(),send:h.send,configure:h.configure,
})}));
vi.mock('../src/features/ProjectChat/useProjectChatActivity',()=>({useProjectChatActivity:()=>({snapshot:undefined,enabled:false,connected:false,onVisible:vi.fn(),onTyping:vi.fn()})}));
vi.mock('../src/features/ProjectChat/ProjectChatWorkflowDialog',()=>({ProjectChatWorkflowDialog:()=>null}));
vi.mock('../src/features/SystemRoleChat/SystemRoleChat',()=>({SystemRoleChat:()=>null}));
vi.mock('../src/features/AgentTools/useAgentTools',()=>({useAgentTools:()=>({draft:{enabled:false},blocked:false,loading:false,update:vi.fn(),restore:vi.fn(),disable:vi.fn(),reload:vi.fn()})}));
vi.mock('../src/features/ModelChat/ChatWorkspace',()=>({ChatWorkspace:(props:IModelChatProps&{navigation?:IChatWorkspaceNavigation})=>createElement('section',{'aria-label':'Личные диалоги проекта'},
    props.navigation?.controls(action=>action()),
    props.navigation?.items.map(item=>createElement('button',{key:item.id,onClick:()=>props.navigation?.onSelect(item)},item.title)),
    props.navigation?.initialDetail&&createElement('p',null,'Открыта личная история'),
)}));

const roomId='115af965-9952-402f-8811-20ae55f47991';
let root:Root,container:HTMLDivElement,sequence=0;
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,70));});};
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(value=>value.textContent===label||value.getAttribute('aria-label')===label)!;
const click=async(value:HTMLElement)=>{expect(value).toBeTruthy();await act(async()=>value.click());await settle();};
const mode=(value:'team'|'personal')=>document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
const render=async()=>{await act(async()=>root.render(createElement(ChatOverlay,{projectId:'prj-one',team:true,onClose:vi.fn()})));await vi.dynamicImportSettled();await settle();};
const type=async(value:string)=>{const input=document.querySelector<HTMLTextAreaElement>('#project-chat-message')!;expect(input).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});await settle();};
beforeEach(()=>{
    vi.clearAllMocks();h.owner='personal-entry-'+ ++sequence;vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    const computed=window.getComputedStyle.bind(window);vi.spyOn(window,'getComputedStyle').mockImplementation(element=>computed(element));
    vi.mocked(projectChatApi.rooms).mockResolvedValue({rooms:[{id:DEFAULT_PROJECT_CHAT_ROOM,title:'Общий чат',visibility:'PUBLIC',revision:1,updatedAt:'',canManage:false,memberEmails:[]},
        {id:roomId,title:'Закрытое ревью',visibility:'PRIVATE',revision:1,updatedAt:'',canManage:true,memberEmails:['alice@example.test']}],members:projectRoom().members,canCreate:true});
    const saved=detail({conversation:{...detail().conversation,id:'private-saved',modelId:'model-chat',projectId:'prj-one',title:'Личный сохранённый'},turns:[]});
    vi.mocked(modelChatApi.list).mockResolvedValue([saved.conversation]);vi.mocked(modelChatApi.read).mockResolvedValue(saved);vi.mocked(modelChatApi.agents).mockResolvedValue(projectRoom().agents);
    h.configure.mockResolvedValue(false);container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('keeps personal history reachable in the visible navigation when project settings are collapsed',async()=>{
    await render();const settings=button('Настройки командного чата: проект');expect(settings.getAttribute('aria-expanded')).toBe('false');
    const navigation=document.querySelector('nav[aria-label="Режимы и сервисные роли чата"]');expect(navigation).toBeTruthy();expect(navigation?.contains(mode('personal'))).toBe(true);
    expect(modelChatApi.list).not.toHaveBeenCalled();await click(mode('personal'));expect(modelChatApi.list).toHaveBeenCalledWith(undefined,'prj-one',expect.any(AbortSignal));
    await click(button('Личный сохранённый'));expect(modelChatApi.read).toHaveBeenCalledWith('private-saved',expect.any(AbortSignal));expect(document.body.textContent).toContain('Открыта личная история');expect(h.send).not.toHaveBeenCalled();
});

it('returns from personal history to the same project room and its unsubmitted draft',async()=>{
    await render();await click(document.querySelector('[title="Закрытое ревью"]')!.closest('button')!);await type('Черновик закрытого ревью');
    await click(mode('personal'));expect(document.querySelector('[aria-label="Личные диалоги проекта"]')).toBeTruthy();await click(mode('team'));
    expect(document.querySelector('.project-chat__room-title')?.textContent).toContain('Закрытое ревью');
    expect(document.querySelector<HTMLTextAreaElement>('#project-chat-message')?.value).toBe('Черновик закрытого ревью');expect(h.send).not.toHaveBeenCalled();expect(modelChatApi.read).not.toHaveBeenCalled();
});

it('retries an unavailable agent model without discarding the chosen participants',async()=>{
    vi.mocked(modelChatApi.agents).mockRejectedValueOnce(Error('Модель не добавлена в каталог выбранного проекта')).mockResolvedValueOnce(projectRoom().agents);
    await render();await click(button('Настроить агентов'));expect(document.body.textContent).toContain('Модель не добавлена в каталог выбранного проекта');
    const reviewer=[...document.querySelectorAll<HTMLInputElement>('.project-chat__settings input[type="checkbox"]')].find(input=>input.closest('label')?.textContent?.includes('Ревьюер'))!;
    await click(reviewer);expect(reviewer.checked).toBe(false);await click(button('Повторить проверку агентов'));
    expect(document.body.textContent).not.toContain('Модель не добавлена в каталог выбранного проекта');expect(reviewer.checked).toBe(false);expect(modelChatApi.agents).toHaveBeenCalledTimes(2);expect(h.send).not.toHaveBeenCalled();
});
