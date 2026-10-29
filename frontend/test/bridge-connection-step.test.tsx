// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BridgeConnectionStep} from '../src/modules/Start/BridgeConnectionStep';
import type {useBridge} from '../src/features/McpBridge/useBridge';
const h=vi.hoisted(()=>({command:vi.fn(),next:vi.fn()}));
vi.mock('../src/features/McpBridge/BridgeInstallerCommand',()=>({BridgeInstallerCommand:(props:unknown)=>{h.command(props);return createElement('code',null,'BRIDGE ONLY');}}));
vi.mock('../src/features/McpBridge/PairingCode',()=>({PairingCode:()=>null}));
vi.mock('../src/features/McpBridge/InstalledBridgeConnect',()=>({InstalledBridgeConnect:()=>null}));
vi.mock('../src/features/McpBridge/BridgeSourcePanel',()=>({BridgeSourcePanel:({onInstall}:{onInstall:()=>void})=>createElement('button',{onClick:onInstall},'Обновить пакет моста')}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>createElement('div',null,children);
    return {Space:content,Typography:{Title:content,Paragraph:content,Text:content},Collapse:Object.assign(content,{Panel:content}),Radio:{Group:()=>null},Alert:()=>null,
        Button:({children,disabled,onClick}:{children?:ReactNode;disabled?:boolean;onClick:()=>void})=>createElement('button',{disabled,onClick},children)};
});
let root:Root,container:HTMLDivElement,bridge:ReturnType<typeof useBridge>;
const render=async()=>{await act(async()=>root.render(createElement(BridgeConnectionStep,{bridge,installer:{origin:'https://qa.test',loading:false,error:'',reload:vi.fn()},enabled:true,canManage:false,onCopy:vi.fn(),onContinue:h.next})));};
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);bridge={devicesReady:true,errors:{devices:''},devices:[],jobs:[],reload:vi.fn()} as unknown as ReturnType<typeof useBridge>;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it('first stage offers only bridge installation, with no combined OpenCode installer or automatic dispatch',async()=>{
    await render();expect(h.command).toHaveBeenCalledOnce();expect(h.command.mock.calls[0][0]).toMatchObject({reconnect:false});
    expect(h.command.mock.calls[0][0]).not.toHaveProperty('workspace');expect(h.command.mock.calls[0][0]).not.toHaveProperty('openCode');expect(h.next).not.toHaveBeenCalled();
});
it('a connected computer advances explicitly and does not repeat an installer command',async()=>{
    bridge.device={id:'owned',online:true,report:{platform:'linux'}} as ReturnType<typeof useBridge>['device'];await render();expect(h.command).not.toHaveBeenCalled();
    const next=[...container.querySelectorAll('button')].find(node=>node.textContent==='К OpenCode')!;await act(async()=>next.click());expect(h.next).toHaveBeenCalledOnce();
});
it('a connected computer can open its real bridge update command from source details',async()=>{
    bridge.device={id:'owned',online:true,report:{platform:'linux'}} as ReturnType<typeof useBridge>['device'];await render();
    const update=[...container.querySelectorAll('button')].find(node=>node.textContent==='Обновить пакет моста')!;await act(async()=>update.click());
    expect(h.command).toHaveBeenCalledOnce();expect(container.textContent).toContain('BRIDGE ONLY');expect(h.next).not.toHaveBeenCalled();
});
