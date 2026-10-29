// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SystemRoleChat} from '../src/features/SystemRoleChat/SystemRoleChat';
import type {RoleOverview,RoleRun} from '../src/features/SystemRoles/types';
import type {ServiceTurn} from '../src/features/SystemRoleChat/types';

const h=vi.hoisted(()=>({owner:'developer',capture:()=>{const owner=h.owner;return()=>owner===h.owner;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:h.owner,captureOwner:h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:true,reason:''})}));
vi.mock('../src/features/SystemRoleChat/McpTaskPicker',()=>({McpTaskPicker:()=>null}));
vi.mock('../src/features/SystemRoles/IndexerOwnerActions',()=>({IndexerOwnerActions:()=>null}));
vi.mock('../src/features/SystemRoles/api',()=>({systemRolesApi:{overview:vi.fn(),action:vi.fn()}}));
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),post:vi.fn()}}));
vi.mock('../src/features/SystemRoleChat/api',()=>{
    const api={list:vi.fn(),create:vi.fn(),read:vi.fn(),prepare:vi.fn(),start:vi.fn(),request:vi.fn(),cancel:vi.fn()};
    return {systemRoleChatsApi:api,roleConversationApi:()=>api};
});
import base from '../src/core/api/base';
import {systemRolesApi} from '../src/features/SystemRoles/api';
import {systemRoleChatsApi as api} from '../src/features/SystemRoleChat/api';

const origin={kind:'model-chat' as const,originId:'9fcb43ec-7101-4547-8eca-0b7b446c9fba',projectId:'prj-one'};
const dialog={id:'27172bcb-bb2d-4c16-a48c-ce9247cec33e',title:'Own saved task',projectId:'prj-one',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z'};
const model={id:'model-one',name:'Own model',pin:'a'.repeat(64)};
const overview={definitions:[{id:'agent-ai-admin',diagnostics:[],targets:[]}],models:[model],targets:[],budget:{diagnostics:5}} as unknown as RoleOverview;
const turn:ServiceTurn={id:'accepted-request',agentId:'agent-ai-admin',instruction:'Own task',createdAt:dialog.createdAt,cancelRequested:false,
    run:{id:'saved-run',state:'succeeded',revision:1,canCancel:false,canApply:false,canRollback:false,facts:[],targets:[],steps:[],applied:[],result:{kind:'diagnosis',summary:'Saved private response',findings:[],nextSteps:[],changes:[]}} as unknown as RoleRun};
const denied={response:{status:403,data:{message:'Forbidden overview'}}};
let root:Root,container:HTMLDivElement;
const settle=async()=>{await act(async()=>{await new Promise(done=>setTimeout(done,5));});};
const render=async(props:Parameters<typeof SystemRoleChat>[0])=>{await act(async()=>{root.render(createElement(SystemRoleChat,props));});await settle();await settle();};
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label)!;
const click=async(label:string)=>{expect(button(label)).toBeTruthy();await act(async()=>button(label).click());await settle();};
beforeEach(()=>{
    vi.resetAllMocks();h.owner='developer';sessionStorage.clear();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    vi.stubGlobal('matchMedia',(query:string)=>({matches:false,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:()=>false}));
    vi.mocked(base.get).mockResolvedValue({data:null});vi.mocked(api.list).mockResolvedValue([dialog]);vi.mocked(api.read).mockResolvedValue({dialog,turns:[turn]});
    vi.mocked(systemRolesApi.overview).mockResolvedValue(overview);
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();sessionStorage.clear();vi.unstubAllGlobals();});

it('ordinary Developer model chat reads its allowed private origin without requesting admin overview or showing a partial refresh warning',async()=>{
    vi.mocked(systemRolesApi.overview).mockRejectedValue(denied);
    await render({embedded:true,origin,projectId:'prj-one',historyOnly:true,canExecute:false});
    expect(base.get).toHaveBeenCalledWith('/api/chat-system-roles/origin',{params:origin});
    expect(systemRolesApi.overview).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Часть данных не обновилась');
    expect(container.querySelector('.service-chat__composer')).toBeNull();expect(api.start).not.toHaveBeenCalled();
});
it('a read-only role view keeps accepted history available without mounting preparation capabilities',async()=>{
    vi.mocked(systemRolesApi.overview).mockRejectedValue(denied);
    await render({agentId:'agent-ai-admin',projectId:'prj-one',canExecute:false});
    expect(container.textContent).toContain('Saved private response');
    expect(container.querySelector('.service-chat__composer')).toBeNull();expect(systemRolesApi.overview).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();
});
it('an unexpected Admin overview 403 remains visible, preserves accepted history and clears only after an explicit successful retry',async()=>{
    h.owner='project-admin';await render({agentId:'agent-ai-admin',projectId:'prj-one'});
    expect(container.textContent).toContain('Saved private response');
    vi.mocked(systemRolesApi.overview).mockRejectedValueOnce(denied);await click('Обновить');
    expect(container.textContent).toContain('Часть данных не обновилась');expect(container.textContent).toContain('Saved private response');
    const before=vi.mocked(systemRolesApi.overview).mock.calls.length;
    await click('Повторить проверку');
    expect(systemRolesApi.overview).toHaveBeenCalledTimes(before+1);expect(container.textContent).not.toContain('Часть данных не обновилась');
    expect(container.textContent).toContain('Saved private response');expect(api.start).not.toHaveBeenCalled();
});
it('an initial Admin overview 403 is not erased when automatic selection successfully reads the saved history',async()=>{
    h.owner='project-admin';vi.mocked(systemRolesApi.overview).mockRejectedValueOnce(denied);
    await render({agentId:'agent-ai-admin',projectId:'prj-one'});
    expect(container.textContent).toContain('Saved private response');expect(container.textContent).toContain('Часть данных не обновилась');
    await click('Повторить проверку');
    expect(container.textContent).toContain('Saved private response');expect(container.textContent).not.toContain('Часть данных не обновилась');
    expect(api.start).not.toHaveBeenCalled();
});
it('a Developer private-history failure remains visible and retries the permitted origin read',async()=>{
    vi.mocked(base.get).mockRejectedValueOnce({response:{status:503}});
    await render({embedded:true,origin,projectId:'prj-one',historyOnly:true,canExecute:false});
    expect(container.textContent).toContain('Часть данных не обновилась');
    await click('Повторить проверку');
    expect(base.get).toHaveBeenCalledTimes(2);expect(container.textContent).not.toContain('Часть данных не обновилась');
    expect(systemRolesApi.overview).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();
});
it('a late overview failure from the former preparation capability cannot replace the current read-only history',async()=>{
    let reject!:(cause:unknown)=>void;
    vi.mocked(systemRolesApi.overview).mockReturnValueOnce(new Promise((_resolve,no)=>{reject=no;}));
    await render({agentId:'agent-ai-admin',projectId:'prj-one',canExecute:true});
    await render({agentId:'agent-ai-admin',projectId:'prj-one',canExecute:false});
    expect(container.textContent).toContain('Saved private response');
    await act(async()=>reject(denied));await settle();
    expect(container.textContent).not.toContain('Часть данных не обновилась');expect(container.textContent).toContain('Saved private response');
    expect(systemRolesApi.overview).toHaveBeenCalledTimes(1);expect(container.querySelector('.service-chat__composer')).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
});
