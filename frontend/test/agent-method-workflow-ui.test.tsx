// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AgentMethodWorkflow} from '../src/features/AgentMethods/AgentMethodWorkflow';
import {workflowStorageKey} from '../src/features/AgentMethods/model';
import {agent,assignment,bridge,catalog} from './agent-fixtures';
import type {IProjectAgent} from '../src/features/AgentCatalog/types';
import type {IBridgeJob} from '../src/features/McpBridge/api';

const h=vi.hoisted(()=>({create:vi.fn(),request:vi.fn(),cancel:vi.fn(),flags:{agent_method_workflows:true,project_agent_workflows:true} as Record<string,boolean>}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:h}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa-ui',captureOwner:()=>()=>true})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:(key:string)=>({enabled:h.flags[key],reason:h.flags[key]?'':'Функция выключена',known:true,loading:false})}));
vi.mock('antd',()=>{
    const content=({children,className}:{children?:ReactNode;className?:string})=>createElement('div',{className},children);
    const text=({children,strong}:{children?:ReactNode;strong?:boolean})=>createElement(strong?'strong':'span',null,children);
    const Select=({options=[],value,onChange,disabled,...rest}:{options?:Array<{value:string;label:string;disabled?:boolean}>;value?:string;onChange?:(value:string|undefined)=>void;disabled?:boolean;'aria-label'?:string})=>createElement('select',{'aria-label':rest['aria-label'],value:value??'',disabled,onChange:(event:{target:{value:string}})=>onChange?.(event.target.value||undefined)},
        createElement('option',{value:''},'Без проектного агента'),...options.map(option=>createElement('option',{key:option.value,value:option.value,disabled:option.disabled},option.label)));
    const Button=({children,onClick,disabled,href}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean;href?:string})=>href?createElement('a',{href},children):createElement('button',{disabled,onClick},children);
    return {Space:content,Typography:{Text:text,Paragraph:text},Select,Button,Tag:text,
        Collapse:Object.assign(content,{Panel:content}),
        Alert:({message,description,action}:{message?:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',{role:'alert'},message,description,action),
        Empty:({description}:{description?:ReactNode})=>createElement('div',null,description),
        Input:{TextArea:({value,disabled,'aria-label':label}:{value:string;disabled?:boolean;'aria-label'?:string})=>createElement('textarea',{'aria-label':label,value,readOnly:true,disabled})},
        Checkbox:{Group:content},
        List:Object.assign(({dataSource,renderItem,header}:{dataSource:unknown[];renderItem:(item:unknown)=>ReactNode;header?:ReactNode})=>createElement('div',null,header,...dataSource.map((item,index)=>createElement('div',{key:index},renderItem(item)))),{Item:content})};
});

type Props=Parameters<typeof AgentMethodWorkflow>[0];
const identity={agentId:agent().id,slug:agent().slug,version:1,agentsRevision:3,agentsManifestSha256:'a'.repeat(64),compiledManifestSha256:'b'.repeat(64),fileSha256:'c'.repeat(64),configurationJobId:'11111111-1111-4111-8111-111111111111'};
const eligible=(patch:Partial<IProjectAgent>={}):IProjectAgent=>assignment({enabled:true,effective:{...agent().definition,mode:'primary',model:'owned/model'},...patch});
const job=(patch:Partial<IBridgeJob>={}):IBridgeJob=>({id:'selected-job',deviceId:'device-one',projectId:'project-one',kind:'run-agent-method-workflow',workflowId:'22222222-2222-4222-8222-222222222222',
    method:'openspec',state:'succeeded',message:'Готово',createdAt:'2026-10-27T00:00:00Z',agent:identity,
    result:{protocol:'agent-method-workflow-v1',workflowId:'22222222-2222-4222-8222-222222222222',method:'openspec',methodVersion:'1.15.0',runtime:'opencode',state:'succeeded',stage:'completed',agent:identity,
        codeChanged:true,changes:[{path:'app.ts',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64)}],artifacts:[],checks:[{command:'npm',args:['test'],exitCode:0,signal:null,state:'passed'}]},...patch});
let props:Props,root:Root,container:HTMLDivElement;
const storageKey=workflowStorageKey('qa-ui','project-one');
const seed=(agentId?:string,pending?:unknown)=>localStorage.setItem(storageKey,JSON.stringify({method:'openspec',instruction:'Сохранённая задача',checks:['test'],...(agentId?{agentId}:{}),...(pending?{pending}:{})}));
const intent=(selected=true)=>({kind:'run-agent-method-workflow',deviceId:'device-one',projectId:'project-one',requestKey:'22222222-2222-4222-8222-222222222222',expectedBindingId:'b'.repeat(64),expectedInstanceId:'11111111-1111-4111-8111-111111111111',
    workflow:{method:'openspec',instruction:'Сохранённая задача',checks:[{command:'npm',args:['test']}],...(selected?{agentId:identity.agentId,expectedAgentsRevision:3}:{})}});
const render=async()=>{await act(async()=>root.render(createElement(AgentMethodWorkflow,props)));};
const button=(label:string):HTMLButtonElement=>{const value=[...container.querySelectorAll('button')].find(item=>item.textContent===label);if(!value)throw Error('Button missing: '+label);return value;};
const select=():HTMLSelectElement=>container.querySelector('select[aria-label="Агент для задачи методики"]')!;
const choose=async(value:string)=>{await act(async()=>{select().value=value;select().dispatchEvent(new Event('change',{bubbles:true}));});};
beforeEach(()=>{
    vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);h.flags.agent_method_workflows=true;h.flags.project_agent_workflows=true;localStorage.clear();
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
    const connection=bridge();connection.device!.report.capabilities=['agent-method-workflow-v1','agent-method-selected-agent-v1'];connection.reload=vi.fn(async()=>undefined);
    props={projectId:'project-one',canManage:true,bridge:connection,agentCatalog:catalog({assignments:[eligible()]}),agentsLoading:false,agentsError:'',onReloadAgents:vi.fn(async()=>null)};
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it('requires an explicit ready agent instead of selecting the first option and sends only its ID/revision',async()=>{
    seed();await render();expect(select().value).toBe('');expect(button('Выполнить задачу').disabled).toBe(true);
    await choose(identity.agentId);expect(button('Выполнить задачу').disabled).toBe(false);h.create.mockRejectedValueOnce(Error('ACK lost'));
    await act(async()=>button('Выполнить задачу').click());expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0].workflow).toEqual({...intent().workflow});expect(select().disabled).toBe(true);
    expect(JSON.stringify(h.create.mock.calls[0][0])).not.toContain('owned/model');expect(JSON.stringify(h.create.mock.calls[0][0])).not.toContain('prompt');
});

it.each([
    ['disabled',()=>eligible({enabled:false}),'Включите'],
    ['removed',()=>eligible({removed:true}),'не доступен'],
    ['archived',()=>eligible({card:agent({archivedAt:'2026-10-27'})}),'не доступен'],
    ['subagent',()=>eligible({effective:{...agent().definition,mode:'subagent',model:'owned/model'}}),'основной агент'],
    ['missing explicit model',()=>eligible({effective:{...agent().definition,mode:'all'}}),'явную модель'],
] as const)('keeps an unavailable saved %s choice and task without generic fallback',async(_name,create,reason)=>{
    props.agentCatalog=catalog({assignments:[create()]});seed(identity.agentId);await render();
    expect(select().value).toBe(identity.agentId);expect(container.textContent).toContain(reason);expect(button('Выполнить задачу').disabled).toBe(true);
    expect(container.querySelector('textarea')?.value).toBe('Сохранённая задача');expect(h.create).not.toHaveBeenCalled();
});

it('uses current catalog archive state when the immutable assigned card still has archivedAt null',async()=>{
    props.agentCatalog=catalog({items:[agent({archivedAt:'2026-10-27'})],assignments:[eligible()]});seed(identity.agentId);await render();
    expect(props.agentCatalog.assignments[0].card.archivedAt).toBeNull();expect(select().value).toBe(identity.agentId);
    expect(button('Выполнить задачу').disabled).toBe(true);expect(container.textContent).toContain('не доступен');
    expect(container.querySelector('textarea')?.value).toBe('Сохранённая задача');expect(h.create).not.toHaveBeenCalled();
});

it('uses current head only for archive eligibility and keeps the pinned version and effective model',async()=>{
    props.agentCatalog=catalog({items:[agent({version:2,name:'Новый общий шаблон',definition:{...agent().definition,mode:'subagent'}})],assignments:[eligible()]});
    seed(identity.agentId);await render();expect(button('Выполнить задачу').disabled).toBe(false);
    expect(select().selectedOptions[0].textContent).toBe('Ревьюер · nc-reviewer · v1');expect(container.querySelector('textarea')?.value).toBe('Сохранённая задача');
});

it('allows the old generic mode with the new flag OFF only after an explicit clear of the saved choice',async()=>{
    h.flags.project_agent_workflows=false;seed(identity.agentId);await render();expect(button('Выполнить задачу').disabled).toBe(true);expect(select().value).toBe(identity.agentId);
    await choose('');expect(button('Выполнить задачу').disabled).toBe(false);h.create.mockRejectedValueOnce(Error('ACK lost'));await act(async()=>button('Выполнить задачу').click());
    expect(h.create.mock.calls[0][0].workflow).toEqual(intent(false).workflow);expect(container.querySelector('textarea')?.value).toBe('Сохранённая задача');
});

it('replays a legacy pending request when the selected-agent flag is OFF',async()=>{
    h.flags.project_agent_workflows=false;const original=intent(false);seed(undefined,original);h.request.mockRejectedValueOnce({response:{status:404}});await render();
    await act(async()=>button('Проверить отправку').click());expect(button('Повторить тот же запрос').disabled).toBe(false);
    h.create.mockRejectedValueOnce(Error('ACK lost'));await act(async()=>button('Повторить тот же запрос').click());expect(h.create).toHaveBeenCalledExactlyOnceWith(original);
});

it('keeps selected history, readonly acceptance recovery and cancellation available with both flags OFF',async()=>{
    h.flags.project_agent_workflows=false;h.flags.agent_method_workflows=false;seed(identity.agentId,intent());
    props.bridge.jobs=[job({state:'running',result:undefined})];props.agentCatalog=null;props.agentsError='Агенты временно недоступны';
    h.request.mockRejectedValueOnce({response:{status:404}});await render();expect(container.textContent).toContain('nc-reviewer · v1');
    await act(async()=>button('Проверить отправку').click());expect(h.request).toHaveBeenCalledOnce();expect(button('Повторить тот же запрос').disabled).toBe(true);
    h.cancel.mockResolvedValueOnce(undefined);await act(async()=>button('Отменить задание').click());expect(h.cancel).toHaveBeenCalledExactlyOnceWith('selected-job');
});

it.each(['loading','error','missing capability'] as const)('blocks a selected dispatch while %s is unconfirmed and retains input',async state=>{
    seed(identity.agentId);if(state==='loading')props.agentsLoading=true;if(state==='error')props.agentsError='Catalog503';
    if(state==='missing capability')props.bridge.device!.report.capabilities=['agent-method-workflow-v1'];
    await render();expect(button('Выполнить задачу').disabled).toBe(true);expect(select().value).toBe(identity.agentId);expect(container.querySelector('textarea')?.value).toBe('Сохранённая задача');
    expect(h.create).not.toHaveBeenCalled();
});

it('renders pinned agent identity without taking a current name from a newer assignment revision',async()=>{
    props.bridge.jobs=[job()];await render();expect(container.querySelector('.agent-methods__result strong')?.textContent).toBe('Исполнитель: Ревьюер · nc-reviewer · v1');
    props.agentCatalog=catalog({revision:4,assignments:[eligible({card:agent({name:'Новый агент'})})]});await render();
    expect(container.querySelector('.agent-methods__result strong')?.textContent).toBe('Исполнитель: nc-reviewer · v1');expect(container.textContent).toContain('Задание выполнено');
});

it('labels agentless history explicitly and rejects a mismatched selected result as successful execution',async()=>{
    props.bridge.jobs=[job({agent:null,result:{...job().result!,agent:undefined}})];await render();expect(container.textContent).toContain('Прежний запуск без выбранного агента');
    props.bridge.jobs=[job({result:{...job().result!,agent:{...identity,fileSha256:'f'.repeat(64)}}})];await render();
    expect(container.textContent).not.toContain('Задание выполнено');expect(container.textContent).toContain('Результат исполнения не подтверждён');expect(container.textContent).toContain('nc-reviewer · v1');
});

it('explains SELECTED_AGENT_NOT_READY without losing the task or claiming that checks passed',async()=>{
    seed(identity.agentId);props.bridge.jobs=[job({state:'failed',result:{...job().result!,state:'needs_setup',stage:'prerequisites',codeChanged:false,changes:[],agent:identity,
        checks:[{command:'npm',args:['test'],exitCode:null,signal:null,state:'not_run'}],failure:{code:'SELECTED_AGENT_NOT_READY',action:'setup-agent'}}})];
    await render();expect(container.textContent).toContain('Примените текущие настройки агентов');expect(container.textContent).toContain('явную модель');expect(container.textContent).toContain('Не запускалась');
    expect(container.textContent).not.toContain('Задание выполнено');expect(container.querySelector('textarea')?.value).toBe('Сохранённая задача');
});
