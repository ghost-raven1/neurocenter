/** SSR actual setup/source panel; controlled AntD and hooks isolate discovery failure from public install metadata. */
import './feature-flags-enabled';
import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {BridgeSetup} from '../src/modules/Start/BridgeSetup';
import type {useBridge} from '../src/features/McpBridge/useBridge';
const hooks=vi.hoisted(()=>{let cursor=0;const slots:unknown[]=[];return{begin:()=>{cursor=0;},reset:()=>{slots.length=0;},useState<T>(initial:T){const index=cursor++;if(index>=slots.length)slots[index]=initial;return[slots[index],(next:T)=>{slots[index]=next;}];}};});
interface Button {children?:ReactNode;disabled?:boolean;onClick?:()=>void}
const io=vi.hoisted(()=>({bridge:undefined as unknown as ReturnType<typeof useBridge>,buttons:new Map<string,Button>(),copy:vi.fn(),reloadSource:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>io.bridge}));
vi.mock('../src/features/McpBridge/BridgeConnection',()=>({BridgeConnection:()=>null}));
vi.mock('../src/features/McpBridge/PairingCode',()=>({PairingCode:()=>null}));
vi.mock('../src/features/McpBridge/useBridgeSource',()=>({useBridgeSource:()=>({data:undefined,error:'Catalog source unavailable',loading:false,saving:false,reload:io.reloadSource,check:vi.fn(),save:vi.fn()})}));
vi.mock('../src/features/McpBridge/useBridgeSourceImport',()=>({useBridgeSourceImport:()=>({blocked:false,busy:false,error:'',start:vi.fn()})}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:vi.fn(),location:{pathname:'/start',search:''}})}));
vi.mock('antd',()=>{
 const content=({children}:{children?:ReactNode})=>children;
 return{Button:(props:Button)=>{io.buttons.set(String(props.children),props);return createElement('button',{disabled:props.disabled},props.children);},Space:content,Radio:{Group:content,Button:content},Select:()=>null,
 Typography:{Title:content,Text:content,Paragraph:content,Link:({children,href}:{children?:ReactNode;href?:string})=>createElement('a',{href},children)},Input:()=>null,Modal:()=>null,
 Alert:({message,description,action}:{message?:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',null,message,description,action),Collapse:Object.assign(content,{Panel:content})};
});
const installer={origin:'https://gateway.audit.test',devSupply:{version:'0.9.18',buildId:'a'.repeat(64),targets:['darwin-arm64']},loading:false,error:'',reload:vi.fn()};
function render(){hooks.begin();io.buttons.clear();return renderToStaticMarkup(createElement(BridgeSetup,{origin:'https://ui.audit.test',installer,windows:false,onCopy:io.copy}));}
beforeEach(()=>{vi.clearAllMocks();hooks.reset();io.bridge={device:undefined,devices:[],devicesReady:false,jobsReady:false,installationsReady:false,jobs:[],installations:[],loading:false,error:'Devices unavailable',errors:{devices:'Devices unavailable',jobs:'',installations:''},reload:vi.fn(),choose:vi.fn()};});
describe('Независимое подключение при ошибке списка устройств',()=>{
 it('Проверенный Gateway оставляет команду подключения и повтор списка устройств после отказа API',()=>{
  const html=render();expect(html).toContain('Devices unavailable');expect(html).not.toContain('Компьютер готов');expect(io.buttons.has('Выбрать папку проектов')).toBe(false);io.buttons.get('Повторить')!.onClick!();expect(io.bridge.reload).toHaveBeenCalledOnce();
  expect(html).toContain('https://gateway.audit.test/api/bridge/connect.sh');io.buttons.get('Копировать команду подключения')!.onClick!();expect(io.copy).toHaveBeenCalledExactlyOnceWith("curl -fsSL --insecure 'https://gateway.audit.test/api/bridge/connect.sh' | bash");
 });
 it('Настоящая dev-поставка открывает команду установки при отказе списка устройств и каталога',()=>{
  expect(render()).toContain('Dev-поставка: 0.9.18');expect(io.buttons.get('Установить dev-мост')?.disabled).not.toBe(true);io.buttons.get('Установить dev-мост')!.onClick!();
  const html=render();expect(io.buttons.has('Копировать команду')).toBe(true);expect(html).toContain('https://gateway.audit.test/api/bridge/install.sh');io.buttons.get('Копировать команду')!.onClick!();expect(io.copy).toHaveBeenCalledExactlyOnceWith("curl -fsSL --insecure 'https://gateway.audit.test/api/bridge/install.sh' | bash");
 });
});
