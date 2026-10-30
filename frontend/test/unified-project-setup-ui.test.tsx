// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Start from '../src/modules/Start/Start';
import {initialCliObservation} from '../src/features/ComputerSetup/model';

const h=vi.hoisted(()=>({enabled:false,search:'',hash:'',replace:vi.fn(),push:vi.fn(),commands:vi.fn(),reload:vi.fn(),dispatch:vi.fn()}));
vi.mock('react-router-dom',()=>({useHistory:()=>({replace:h.replace,push:h.push}),useLocation:()=>({search:h.search,hash:h.hash})}));
vi.mock('react-redux',()=>({useSelector:(selector:(state:unknown)=>unknown)=>selector({userBlock:{user:{id:'qa',email:'qa@example.test',activeRole:'Главный админ',userRoles:['Главный админ']}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa-setup',captureOwner:()=>()=>true})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:h.enabled,reason:h.enabled?'':'Единая настройка выключена'})}));
vi.mock('../src/features/ComputerSetup/ComputerEnvironment',()=>({useComputerEnvironment:()=>({bridge:{devices:[],jobs:[],installations:[],devicesReady:true,jobsReady:true,installationsReady:true,errors:{devices:'',jobs:'',installations:''},reload:h.reload},installer:{},cli:{state:initialCliObservation(),canStart:false,controller:{start:vi.fn()}},installation:{state:initialCliObservation(),canStart:false,controller:{start:vi.fn()}}})}));
vi.mock('../src/features/McpBridge/useBridgeInstaller',()=>({useBridgeInstaller:()=>({origin:'https://qa.example.test',loading:false,error:'',reload:vi.fn()})}));
vi.mock('../src/features/McpBridge/BridgeInstallerCommand',()=>({BridgeInstallerCommand:()=>{h.commands();return createElement('code',null,'CONTROLLED INSTALLER COMMAND');}}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{create:h.dispatch}}));
vi.mock('../src/modules/Projects/useAvailableProjects',()=>({useAvailableProjects:()=>({ready:true,loading:false,error:'',projects:[],refresh:vi.fn()})}));
vi.mock('../src/modules/Store/useProjectCatalog',()=>({useProjectCatalog:()=>({ready:true,loading:false,error:'',assets:[],refresh:vi.fn()})}));
vi.mock('../src/modules/Start/BridgeConnectionStep',()=>({BridgeConnectionStep:()=>createElement('div',null,'PRIMARY COMPUTER CONNECTION')}));
vi.mock('../src/modules/Start/OpenCodeSetupStep',()=>({OpenCodeSetupStep:()=>createElement('div',null,'BRIDGE CLI INSTALL')}));
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
const render=async()=>{await act(async()=>root.render(createElement(Start)));};
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label);
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);h.enabled=false;h.search='';h.hash='';h.replace.mockImplementation((url:string)=>{const parsed=new URL(url,'https://qa.example.test');h.search=parsed.search;h.hash=parsed.hash;});container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it('keeps default OFF landing status and a read-only wizard entry without preparing or dispatching an installer',async()=>{
    await render();expect(container.textContent).toContain('Единая настройка выключена');expect(container.querySelector('[aria-label="Состояние настройки окружения"]')).toBeNull();
    const open=button('Посмотреть состояние и настройку');expect(open).toBeDefined();expect(open!.disabled).toBe(false);await act(async()=>open!.click());await render();
    expect(h.search).toContain('setup=1');expect(container.querySelector('[aria-label="Шаг 1 основной настройки"]')).not.toBeNull();expect(h.commands).not.toHaveBeenCalled();expect(h.dispatch).not.toHaveBeenCalled();
});

it('opens a keyboard-selected step and moves focus into its current panel',async()=>{
    h.enabled=true;h.search='?setup=1';await render();const step=[...container.querySelectorAll<HTMLElement>('[role="button"]')].find(node=>node.textContent==='Агенты и инструменты')!;
    step.focus();await act(async()=>step.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true})));await render();
    const panel=container.querySelector<HTMLElement>('[aria-label="Шаг 5 основной настройки"]')!;expect(panel).not.toBeNull();expect(document.activeElement).toBe(panel);expect(h.dispatch).not.toHaveBeenCalled();
});

it('opens the primary computer stage from help while OFF without dispatching an installer',async()=>{
    h.search='?setup=1&step=2';await render();expect(container.textContent).not.toContain('Открыть прежнее подключение моста');
    expect(button('Помощь')).toBeDefined();await act(async()=>button('Помощь')!.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();await act(async()=>button('Открыть подключение моста')!.click());await render();
    expect(h.replace).toHaveBeenCalledWith('/start?setup=1&step=0&setupFlow=bridge-first');expect(container.querySelector('[aria-label="Шаг 1 основной настройки"]')).not.toBeNull();expect(h.commands).not.toHaveBeenCalled();expect(h.dispatch).not.toHaveBeenCalled();
});

it.each(['?step=1','?step=2&p=prj-qa','?legacy=1&step=2','?addComputer=1','?connect=PAIR','?setup=1&connect=PAIR','?step=2&connect=PAIR&legacy=1'])('renders the primary computer stage for historical link %s',async search=>{
    h.enabled=true;h.search=search;await render();
    expect(container.querySelector('[aria-label="Шаг 1 основной настройки"]')).not.toBeNull();expect(container.textContent).toContain('PRIMARY COMPUTER CONNECTION');
    expect(container.textContent).not.toContain('Начните с ИИ-помощника');expect(container.textContent).not.toContain('Расширения OpenCode');expect(h.dispatch).not.toHaveBeenCalled();
});

it('retains pairing, project, extension and hash when collapsing, reopening and changing stages',async()=>{
    h.enabled=true;h.search='?legacy=1&step=2&p=prj-qa&connect=PAIR&extension=rag';h.hash='#computer';await render();
    await act(async()=>button('Свернуть мастер')!.click());await render();
    expect(container.querySelector('[aria-label="Шаг 1 основной настройки"]')).toBeNull();expect(button('Начать настройку')).toBeDefined();
    await act(async()=>button('Начать настройку')!.click());await render();
    const step=[...container.querySelectorAll<HTMLElement>('[role="button"]')].find(node=>node.textContent==='Агенты и инструменты')!;
    await act(async()=>step.click());await render();
    expect(container.querySelector('[aria-label="Шаг 5 основной настройки"]')).not.toBeNull();const params=new URLSearchParams(h.search);
    expect(params.get('p')).toBe('prj-qa');expect(params.get('connect')).toBe('PAIR');expect(params.get('extension')).toBe('rag');expect(params.has('legacy')).toBe(false);expect(h.hash).toBe('#computer');expect(h.dispatch).not.toHaveBeenCalled();
});
