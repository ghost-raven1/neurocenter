// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {OpenCodeSetupStep} from '../src/modules/Start/OpenCodeSetupStep';
import {initialCliObservation,readCliJob} from '../src/features/ComputerSetup/model';
import {completed,deviceId,jobId,at} from './computer-setup.fixture';
const h=vi.hoisted(()=>({environment:undefined as unknown,bridge:vi.fn(),next:vi.fn()}));
vi.mock('../src/features/ComputerSetup/ComputerEnvironment',()=>({useComputerEnvironment:()=>h.environment}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>createElement('div',null,children);
    return {Space:content,Typography:{Title:content,Paragraph:content,Text:content},Alert:({message,description,action}:{message:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',{role:'alert'},message,description,action),
        Button:({children,disabled,onClick}:{children?:ReactNode;disabled?:boolean;onClick:()=>void})=>createElement('button',{disabled,onClick},children)};
});
const control=()=>({state:initialCliObservation(),canStart:true,canCancel:true,blocker:'',roleChanged:false,controller:{start:vi.fn(),check:vi.fn(),cancel:vi.fn(),replay:vi.fn()}});
let env:{cli:ReturnType<typeof control>;installation:ReturnType<typeof control>},root:Root,container:HTMLDivElement;
const render=async(enabled=true)=>{await act(async()=>root.render(createElement(OpenCodeSetupStep,{enabled,onBridge:h.bridge,onContinue:h.next})));};
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===label);
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);env={cli:control(),installation:control()};h.environment=env;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const installJob=(state='succeeded',status='installed')=>readCliJob({id:jobId,deviceId,kind:'install-opencode-cli',projectId:null,state,createdAt:at,updatedAt:at,result:state==='running'?null:{schemaVersion:1,scope:'global',deviceId,jobId,source:{buildId:'a'.repeat(64),target:'darwin-arm64',version:'1.14.48',sha256:'b'.repeat(64)},checkedAt:at,status,
    installedVersion:status==='unknown'?null:'1.14.48',commandVersion:null,commandReady:false,nextAction:status==='unknown'?'reconcile':'inspect-path',...(status==='unknown'?{failure:'interrupted'}:{})}},deviceId,jobId,'install-opencode-cli');

it('installs only after an explicit click on a confirmed missing CLI',async()=>{
    env.cli.state.job=readCliJob(completed('missing'),deviceId);await render();expect(env.installation.controller.start).not.toHaveBeenCalled();
    expect(button('Установить OpenCode через мост')?.disabled).toBe(false);await act(async()=>button('Установить OpenCode через мост')!.click());expect(env.installation.controller.start).toHaveBeenCalledOnce();expect(env.cli.controller.start).not.toHaveBeenCalled();
});
it('does not turn unobserved CLI into an install; first action is a fixed check',async()=>{
    await render();expect(button('Установить OpenCode через мост')).toBeUndefined();await act(async()=>button('Проверить OpenCode')!.click());expect(env.cli.controller.start).toHaveBeenCalledOnce();expect(env.installation.controller.start).not.toHaveBeenCalled();
});
it('existing CLI advances to local provider inheritance without another installation',async()=>{
    env.cli.state.job=readCliJob(completed(),deviceId);await render();await act(async()=>button('К провайдерам')!.click());expect(h.next).toHaveBeenCalledOnce();expect(env.installation.controller.start).not.toHaveBeenCalled();
});
it('queued installation can be read and cancelled while new admissions are OFF',async()=>{
    env.installation.state.job=installJob('running');env.installation.canStart=false;await render(false);
    expect(button('Установить OpenCode через мост')).toBeUndefined();await act(async()=>button('Отменить установку')!.click());expect(env.installation.controller.cancel).toHaveBeenCalledOnce();
    expect(env.installation.controller.start).not.toHaveBeenCalled();
});
it('unknown publication only offers inspection and never a fresh copy action',async()=>{
    env.installation.state.job=installJob('failed','unknown');await render();expect(container.textContent).toContain('Исход установки требует сверки');
    expect(button('Установить OpenCode через мост')).toBeUndefined();await act(async()=>button('Проверить OpenCode')!.click());expect(env.cli.controller.start).toHaveBeenCalledOnce();expect(env.installation.controller.start).not.toHaveBeenCalled();
});
it('a newer explicit missing inspection exposes the install action after uncertain publication',async()=>{
    env.installation.state.job=installJob('failed','unknown');env.cli.state.job=readCliJob({...completed('missing'),createdAt:'2026-10-28T00:02:00.000Z'},deviceId);
    await render();expect(button('Установить OpenCode через мост')?.disabled).toBe(false);expect(container.textContent).not.toContain('Исход установки требует сверки');
});
it('copied binary with unconfirmed PATH has an explicit next shell action',async()=>{
    env.installation.state.job=installJob();env.cli.state.job=env.installation.state.job;await render();expect(container.textContent).toContain('команда в PATH пока не подтверждена');expect(container.textContent).toContain('~/.local/bin');
    expect(button('К провайдерам')).toBeDefined();expect(env.cli.controller.start).not.toHaveBeenCalled();
});
