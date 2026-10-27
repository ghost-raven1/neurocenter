// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import UnifiedProjectSetup from '../src/modules/Start/UnifiedProjectSetup';

const h=vi.hoisted(()=>({enabled:false,search:'',replace:vi.fn(),push:vi.fn(),commands:vi.fn(),reload:vi.fn(),dispatch:vi.fn()}));
vi.mock('react-router-dom',()=>({useHistory:()=>({replace:h.replace,push:h.push}),useLocation:()=>({search:h.search,hash:''})}));
vi.mock('react-redux',()=>({useSelector:(selector:(state:unknown)=>unknown)=>selector({userBlock:{user:{id:'qa',email:'qa@example.test',activeRole:'Главный админ',userRoles:['Главный админ']}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa-setup',captureOwner:()=>()=>true})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:h.enabled,reason:h.enabled?'':'Единая настройка выключена'})}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>({devices:[],jobs:[],installations:[],devicesReady:true,jobsReady:true,installationsReady:true,errors:{devices:'',jobs:'',installations:''},reload:h.reload})}));
vi.mock('../src/features/McpBridge/useBridgeInstaller',()=>({useBridgeInstaller:()=>({origin:'https://qa.example.test',loading:false,error:'',reload:vi.fn()})}));
vi.mock('../src/features/McpBridge/BridgeInstallerCommand',()=>({BridgeInstallerCommand:()=>{h.commands();return createElement('code',null,'CONTROLLED INSTALLER COMMAND');}}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{create:h.dispatch}}));
vi.mock('../src/modules/Projects/useAvailableProjects',()=>({useAvailableProjects:()=>({ready:true,loading:false,error:'',projects:[],refresh:vi.fn()})}));
vi.mock('../src/modules/Store/useProjectCatalog',()=>({useProjectCatalog:()=>({ready:true,loading:false,error:'',assets:[],refresh:vi.fn()})}));
vi.mock('../src/modules/Start/BridgeSetup',()=>({BridgeSetup:()=>null}));
vi.mock('../src/modules/Start/StartProjectAssets',()=>({StartProjectAssets:()=>null}));
vi.mock('../src/modules/Projects/local/LocalProjectsFolder',()=>({LocalProjectsFolder:()=>null}));
vi.mock('../src/features/McpBridge/WorkspaceBindingWizard',()=>({WorkspaceBindingWizard:()=>null}));
vi.mock('../src/features/McpBridge/LocalInstallations',()=>({LocalInstallations:()=>null}));
vi.mock('../src/features/AgentCatalog/AgentCatalog',()=>({AgentCatalog:()=>null}));
vi.mock('../src/common/components/PageHeading',()=>({PageHeading:({actions}:{actions?:ReactNode})=>createElement('header',null,createElement('h1',null,'Начало работы'),actions)}));
vi.mock('@ant-design/icons',()=>({ArrowRightOutlined:()=>null,RocketOutlined:()=>null}));
vi.mock('antd',()=>{
    const content=({children,...props}:{children?:ReactNode;className?:string})=>createElement('div',{className:props.className},children);
    const Button=({children,onClick,disabled,href}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean;href?:string})=>createElement(href?'a':'button',{onClick,disabled,href},children);
    return {Card:content,Space:content,Typography:{Title:content,Paragraph:content,Text:content},Button,
        Alert:({message,description,action}:{message?:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',{role:'alert'},message,description,action),
        Descriptions:Object.assign(content,{Item:content}),Tag:content,Modal:({open,title,children}:{open:boolean;title:string;children?:ReactNode})=>open?createElement('section',{role:'dialog','aria-label':title},children):null,Select:()=>null,Radio:{Group:content},Tabs:()=>null,message:{success:vi.fn(),error:vi.fn()},
        Steps:({items,onChange}:{items:Array<{title:string}>;onChange:(index:number)=>void})=>createElement('div',null,...items.map((item,index)=>createElement('div',{role:'button',tabIndex:0,key:index,onClick:()=>onChange(index)},item.title)))};
});
let root:Root,container:HTMLDivElement;
const render=async()=>{await act(async()=>root.render(createElement(UnifiedProjectSetup)));};
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label);
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);h.enabled=false;h.search='';h.replace.mockImplementation((url:string)=>{h.search=new URL(url,'https://qa.example.test').search;});container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it('keeps default OFF landing status and a read-only wizard entry without preparing or dispatching an installer',async()=>{
    await render();expect(container.textContent).toContain('Единая настройка выключена');expect(container.querySelector('[aria-label="Состояние настройки окружения"]')).not.toBeNull();
    const open=button('Посмотреть состояние и настройку');expect(open).toBeDefined();expect(open!.disabled).toBe(false);await act(async()=>open!.click());await render();
    expect(h.search).toContain('setup=1');expect(container.querySelector('[aria-label="Шаг 1 основной настройки"]')).not.toBeNull();expect(h.commands).not.toHaveBeenCalled();expect(h.dispatch).not.toHaveBeenCalled();
});

it('opens a keyboard-selected step and moves focus into its current panel',async()=>{
    h.enabled=true;h.search='?setup=1';await render();const step=[...container.querySelectorAll<HTMLElement>('[role="button"]')].find(node=>node.textContent==='Агенты и инструменты')!;
    step.focus();await act(async()=>step.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true})));await render();
    const panel=container.querySelector<HTMLElement>('[aria-label="Шаг 3 основной настройки"]')!;expect(panel).not.toBeNull();expect(document.activeElement).toBe(panel);expect(h.dispatch).not.toHaveBeenCalled();
});

it('keeps legacy recovery in explicit help on every stage and OFF, without a repeated footer',async()=>{
    h.search='?setup=1&step=2';await render();expect(container.textContent).not.toContain('Открыть прежнее подключение моста');
    expect(button('Помощь')).toBeDefined();await act(async()=>button('Помощь')!.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();await act(async()=>button('Открыть прежнее подключение моста')!.click());
    expect(h.push).toHaveBeenCalledWith('/start?step=1');expect(h.commands).not.toHaveBeenCalled();expect(h.dispatch).not.toHaveBeenCalled();
});
