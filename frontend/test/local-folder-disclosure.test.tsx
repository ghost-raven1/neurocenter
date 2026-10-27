// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LocalProjectsFolder} from '../src/modules/Projects/local/LocalProjectsFolder';
import type {useBridge} from '../src/features/McpBridge/useBridge';
import type {IBridgeJob} from '../src/features/McpBridge/api';

const io=vi.hoisted(()=>({operation:{job:undefined,busy:false,error:'',setError:vi.fn(),submit:vi.fn(),canRetry:vi.fn()},mounts:0,unmounts:0}));
vi.mock('../src/features/McpBridge/useLocalJob',()=>({useLocalJob:()=>io.operation}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{cancel:vi.fn()}}));
vi.mock('../src/features/McpBridge/WorkspaceBindingWizard',()=>({WorkspaceBindingWizard:()=>null}));
vi.mock('../src/features/McpBridge/BridgeConnection',async()=>{const React=await import('react');return{BridgeConnection:()=>{
    React.useEffect(()=>{io.mounts++;return()=>{io.unmounts++;};},[]);return React.createElement('input',{'aria-label':'Сохранённый выбор',defaultValue:''});
}};});
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({FeatureButton:({children,onClick,disabled}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean})=>createElement('button',{onClick,disabled},children)}));
vi.mock('@ant-design/icons',()=>({FolderOpenOutlined:()=>null}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>createElement('div',null,children);
    return{Card:({children,extra}:{children?:ReactNode;extra?:ReactNode})=>createElement('div',null,extra,children),Button:({children,onClick}:{children?:ReactNode;onClick?:()=>void})=>createElement('button',{onClick},children),
        Typography:{Paragraph:content},Alert:({message,description,action}:{message?:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',{role:'alert'},message,description,action)};
});
let root:Root,host:HTMLDivElement,bridge:ReturnType<typeof useBridge>;
const job=(state:string):IBridgeJob=>({id:'folder-transition',deviceId:'qa-computer',projectId:null,kind:'choose-root',state,message:'Проверьте папку',createdAt:'2026-10-27T00:00:00Z',updatedAt:'2026-10-27T00:00:01Z'});
const render=async()=>{await act(async()=>root.render(createElement(LocalProjectsFolder,{bridge,project:null,collapsed:true,onClose:vi.fn()})));};
beforeEach(()=>{
    vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);io.mounts=0;io.unmounts=0;io.operation.busy=false;io.operation.error='';
    const device={id:'qa-computer',name:'QA',role:'Разработчик',fingerprint:'',online:true,lastSeen:null,report:{root:'/owned',protocolVersion:2,capabilities:['durable-completions','managed-installations','install-set-v1','workspace-instance-v1']}};
    bridge={device,devices:[device],devicesReady:true,jobsReady:true,installationsReady:true,jobs:[job('queued')],installations:[],loading:false,error:'',errors:{devices:'',jobs:'',installations:''},choose:vi.fn(),reload:vi.fn()} as ReturnType<typeof useBridge>;
    host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

it('новая ошибка раскрывается после ручного сворачивания pending, сохраняя mounted выбор',async()=>{
    await render();const details=host.querySelector('details.local-projects-folder__details')!,input=host.querySelector('input')!;
    expect((details as HTMLDetailsElement).open).toBe(true);input.value='Ручной выбор';
    await act(async()=>{(details as HTMLDetailsElement).open=false;details.dispatchEvent(new Event('toggle'));});
    expect((details as HTMLDetailsElement).open).toBe(false);
    bridge.jobs=[job('failed')];await render();expect((details as HTMLDetailsElement).open).toBe(true);
    expect(input.value).toBe('Ручной выбор');expect(io.mounts).toBe(1);expect(io.unmounts).toBe(0);expect(io.operation.submit).not.toHaveBeenCalled();
});
