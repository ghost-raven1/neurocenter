// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ProjectChatMethodWorkflows} from '../src/features/ProjectChat/ProjectChatMethodWorkflows';
import type {ProjectChatMethodWorkflow} from '../src/features/ProjectChat/types';

const h=vi.hoisted(()=>({cancel:vi.fn(),refresh:vi.fn(),history:vi.fn(),owns:true}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:h}));
vi.mock('../src/features/ProjectChat/api',()=>({projectChatApi:{workflows:h.history}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:()=>()=>h.owns})}));
vi.mock('antd',()=>{
    const content=({children,className}:{children?:ReactNode;className?:string})=>createElement('div',{className},children);
    return {Space:content,Typography:{Text:content,Paragraph:content},Tag:content,
        Button:({children,onClick,disabled}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean})=>createElement('button',{onClick,disabled},children),
        Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('div',{role:'alert'},message,description),
        List:Object.assign(({dataSource,renderItem}:{dataSource:unknown[];renderItem:(item:unknown)=>ReactNode})=>createElement('div',null,...dataSource.map((item,index)=>createElement('div',{key:index},renderItem(item)))),{Item:content})};
});
const agent={agentId:'agent-review',slug:'nc-reviewer',version:2,agentsRevision:4,agentsManifestSha256:'b'.repeat(64),compiledManifestSha256:'c'.repeat(64),fileSha256:'d'.repeat(64),configurationJobId:'33333333-3333-4333-8333-333333333333'};
const receipt=(patch:Partial<ProjectChatMethodWorkflow>={}):ProjectChatMethodWorkflow=>({jobId:'job',workflowId:'22222222-2222-4222-8222-222222222222',method:'openspec',agent,state:'succeeded',percent:100,createdAt:'2026-10-27T00:00:00Z',startedAt:null,updatedAt:'2026-10-27T00:01:00Z',canCancel:false,publicationState:'published',
    result:{protocol:'agent-method-workflow-v1',workflowId:'22222222-2222-4222-8222-222222222222',method:'openspec',methodVersion:'1.15.0',runtime:'opencode',state:'succeeded',stage:'completed',agent,codeChanged:true,changes:[{path:'app.ts',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64)}],artifacts:[],checks:[{command:'npm',args:['test'],state:'passed',exitCode:0,signal:null}]},...patch});
let root:Root,container:HTMLDivElement,items:ProjectChatMethodWorkflow[],history:{hasMore:boolean;nextCursor:string|null}|undefined;
const render=async()=>{await act(async()=>root.render(createElement(ProjectChatMethodWorkflows,{items,history,projectId:'prj-qa',roomId:'room-qa',messageId:'source-qa',onRefresh:h.refresh})));};
const cancelButton=()=>[...container.querySelectorAll('button')].find(node=>node.textContent==='Отменить задачу методики');
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);h.owns=true;history=undefined;h.refresh.mockResolvedValue(undefined);h.history.mockImplementation(async()=>({items,hasMore:false,nextCursor:null}));container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);items=[receipt()];});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it('renders the durable safe receipt for another member with pinned identity and closed result details',async()=>{
    await render();expect(container.textContent).toContain('nc-reviewer · v2');expect(container.textContent).toContain('Проверки: 1/1');expect(container.querySelector('details')?.open).toBe(false);expect(cancelButton()).toBeUndefined();
    expect(h.cancel).not.toHaveBeenCalled();await act(async()=>root.unmount());root=createRoot(container);await render();expect(container.textContent).toContain('Задание выполнено');expect(h.cancel).not.toHaveBeenCalled();
});

it('uses server cancellation authority for running and reconciling receipts and refreshes rather than inventing a terminal state',async()=>{
    items=[receipt({state:'reconciling',publicationState:'pending',canCancel:true,result:undefined})];await render();h.cancel.mockResolvedValueOnce(undefined);
    await act(async()=>cancelButton()!.click());expect(h.cancel).toHaveBeenCalledExactlyOnceWith('job');expect(h.refresh).toHaveBeenCalledOnce();expect(container.textContent).toContain('Проверяем исход');
    items=[{...items[0],canCancel:false}];await render();expect(cancelButton()).toBeUndefined();
});

it('withholds even a supplied result when publication is denied and never shows another execution identity as success',async()=>{
    items=[receipt({publicationState:'withheld'})];await render();expect(container.textContent).toContain('Результат не опубликован');expect(container.textContent).not.toContain('app.ts');expect(container.textContent).not.toContain('Проверки: 1/1');
    items=[receipt({result:{...receipt().result!,agent:{...agent,fileSha256:'f'.repeat(64)}}})];await render();expect(container.textContent).toContain('Результат исполнения не подтверждён');expect(container.textContent).not.toContain('Задание выполнено');
});

it('keeps cancellation failures separate and does not refresh a previous owner after a late ACK',async()=>{
    items=[receipt({state:'running',publicationState:'pending',canCancel:true,result:undefined})];await render();h.cancel.mockRejectedValueOnce(Error('Связь недоступна'));
    await act(async()=>cancelButton()!.click());expect(container.textContent).toContain('Связь недоступна');expect(h.refresh).not.toHaveBeenCalled();
    let resolve!:()=>void;h.cancel.mockReturnValueOnce(new Promise<void>(done=>{resolve=done;}));await act(async()=>cancelButton()!.click());h.owns=false;await act(async()=>resolve());expect(h.refresh).not.toHaveBeenCalled();
});

it('appends bounded history by its source cursor, deduplicates jobs and retains loaded cards after a failed next page',async()=>{
    history={hasMore:true,nextCursor:'job'};await render();const more=()=>[...container.querySelectorAll('button')].find(node=>node.textContent==='Ещё задачи этого сообщения')!;
    h.history.mockResolvedValueOnce({items:[receipt(),receipt({jobId:'older',workflowId:'older-workflow',state:'cancelled',result:undefined})],hasMore:true,nextCursor:'older'});
    await act(async()=>more().click());expect(h.history.mock.calls[0].slice(0,3)).toEqual(['prj-qa','source-qa','job']);expect(h.history.mock.calls[0][4]).toBe('room-qa');expect(container.querySelectorAll('.project-chat__method-workflow')).toHaveLength(2);
    h.history.mockRejectedValueOnce(Error('Временно недоступно'));await act(async()=>more().click());expect(container.textContent).toContain('Временно недоступно');expect(container.querySelectorAll('.project-chat__method-workflow')).toHaveLength(2);
    h.history.mockResolvedValueOnce({items:[receipt({jobId:'oldest',workflowId:'oldest-workflow',state:'failed',result:undefined})],hasMore:false,nextCursor:null});await act(async()=>more().click());
    expect(h.history.mock.calls[1][2]).toBe('older');expect(h.history.mock.calls[2][2]).toBe('older');expect(container.querySelectorAll('.project-chat__method-workflow')).toHaveLength(3);expect(more()).toBeUndefined();
});

it('aborts a history read on unmount so a late page cannot update another source',async()=>{
    history={hasMore:true,nextCursor:'job'};let resolve!:(value:unknown)=>void;h.history.mockReturnValueOnce(new Promise(done=>{resolve=done;}));await render();
    await act(async()=>[...container.querySelectorAll('button')].find(node=>node.textContent==='Ещё задачи этого сообщения')!.click());const signal=h.history.mock.calls[0][3] as AbortSignal;
    await act(async()=>root.unmount());expect(signal.aborted).toBe(true);root=createRoot(container);items=[receipt({jobId:'new-source'})];history=undefined;await render();
    await act(async()=>resolve({items:[receipt({jobId:'old-private-page'})],hasMore:false,nextCursor:null}));expect(container.querySelectorAll('.project-chat__method-workflow')).toHaveLength(1);
});
