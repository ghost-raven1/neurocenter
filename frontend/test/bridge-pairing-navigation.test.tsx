// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {MemoryRouter,useLocation} from 'react-router-dom';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PairingCode} from '../src/features/McpBridge/PairingCode';
import {BridgePairing} from '../src/features/McpBridge/BridgePairing';
const io=vi.hoisted(()=>({pair:vi.fn(),approve:vi.fn(),devices:vi.fn(),connected:vi.fn()}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{pair:io.pair,approve:io.approve,devices:io.devices}}));
vi.mock('react-redux',()=>({useSelector:()=> 'Главный админ'}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:true}),FeatureAvailabilityNotice:()=>null}));
vi.mock('antd',()=>{
 const content=({children}:{children?:ReactNode})=>createElement('div',null,children);
 return {Button:({children,onClick,disabled}:{children?:ReactNode;onClick?:()=>void;disabled?:boolean})=>createElement('button',{onClick,disabled},children),
  Input:({onPressEnter,...props}:{onPressEnter?:()=>void})=>createElement('input',{...props,onKeyDown:(event:KeyboardEvent)=>{if(event.key==='Enter')onPressEnter?.();}}),
  Modal:({open,children,onOk,onCancel,okText,cancelText,okButtonProps}:{open:boolean;children?:ReactNode;onOk:()=>void;onCancel:()=>void;okText:string;cancelText:string;okButtonProps:{disabled:boolean}})=>open?createElement('section',{role:'dialog'},children,createElement('button',{onClick:onOk,disabled:okButtonProps.disabled},okText),createElement('button',{onClick:onCancel},cancelText)):null,
  Space:content,Spin:()=>null,Typography:{Paragraph:content,Text:content},Alert:({message,description}:{message:ReactNode;description?:ReactNode})=>createElement('section',null,message,description)};
});
let root:Root,container:HTMLDivElement;
function Location(){const value=useLocation();return createElement('output',{'data-route':true},value.pathname+value.search+value.hash);}
async function mount(url:string){await act(async()=>root.render(createElement(MemoryRouter,{initialEntries:[url]},createElement(PairingCode),createElement(BridgePairing,{onConnected:io.connected}),createElement(Location))));}
const button=(label:string)=>{const value=[...container.querySelectorAll('button')].find(item=>item.textContent===label);expect(value,'button '+label).toBeTruthy();return value!;};
const route=()=>new URL(container.querySelector('output')!.textContent!,'https://panel.example.test');
async function click(label:string){await act(async()=>button(label).click());}
async function enter(code:string,key=false){const input=container.querySelector('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,code);input.dispatchEvent(new Event('input',{bubbles:true}));});if(key)await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));else await click('Проверить компьютер');}
const code='ABCDEF1234567890';
beforeEach(()=>{vi.clearAllMocks();globalThis.IS_REACT_ACT_ENVIRONMENT=true;container=document.createElement('div');document.body.append(container);root=createRoot(container);io.pair.mockResolvedValue({name:'QA computer',fingerprint:'own-fingerprint',approved:false,expiresAt:'2026-10-29T18:00:00Z'});io.approve.mockResolvedValue({ok:true});io.devices.mockResolvedValue([{id:'own-device',fingerprint:'own-fingerprint',online:true}]);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
describe('Manual pairing keeps the primary bridge-first route',()=>{
 it.each([false,true])('Manual code navigation (%s=Enter) retains project/help/hash and starts at bridge',async key=>{
  await mount('/start?setup=1&setupFlow=bridge-first&step=0&p=prj+%E6%97%A5%E6%9C%AC&help=bridge#computer');await enter(code,key);
  const value=route();expect(value.pathname).toBe('/start');expect(value.searchParams.get('connect')).toBe(code);expect(value.searchParams.get('setup')).toBe('1');expect(value.searchParams.get('setupFlow')).toBe('bridge-first');expect(value.searchParams.get('step')).toBe('0');expect(value.searchParams.get('p')).toBe('prj 日本');expect(value.searchParams.get('help')).toBe('bridge');expect(value.hash).toBe('#computer');
 });
 it('Approval plus a live report continues to OpenCode before folder selection',async()=>{
  await mount('/start?setup=1&setupFlow=bridge-first&step=0&p=own&help=bridge#computer');await enter(code);await click('Подключить компьютер');
  expect(io.connected).toHaveBeenCalledExactlyOnceWith('own-device');expect(container.textContent).not.toContain('Теперь выберите общую папку');await click('К OpenCode');
  const value=route();expect(value.pathname).toBe('/start');expect(value.searchParams.get('step')).toBe('1');expect(value.searchParams.get('setupFlow')).toBe('bridge-first');expect(value.searchParams.get('p')).toBe('own');expect(value.searchParams.get('help')).toBe('bridge');expect(value.searchParams.has('connect')).toBe(false);expect(value.hash).toBe('#computer');
 });
 it('A historical external pairing link still approves and continues in the primary wizard',async()=>{
  await mount('/projects?connect='+code+'&p=own&extension=rag#computer');await click('Подключить компьютер');await click('К OpenCode');const value=route();
  expect(value.pathname).toBe('/start');expect(value.searchParams.get('setup')).toBe('1');expect(value.searchParams.get('step')).toBe('1');expect(value.searchParams.get('p')).toBe('own');expect(value.searchParams.get('extension')).toBe('rag');expect(value.hash).toBe('#computer');expect(value.searchParams.has('connect')).toBe(false);
 });
 it('An expired code returns to the bridge stage, preserving context and removing the expired pair',async()=>{
  io.pair.mockRejectedValue(new Error('Expired pair'));await mount('/start?connect='+code+'&p=own&help=bridge#computer');await click('Вернуться к подключению');const value=route();expect(value.pathname).toBe('/start');expect(value.searchParams.get('step')).toBe('0');expect(value.searchParams.get('setupFlow')).toBe('bridge-first');expect(value.searchParams.has('connect')).toBe(false);expect(value.searchParams.get('p')).toBe('own');expect(value.hash).toBe('#computer');expect(io.approve).not.toHaveBeenCalled();
 });
 it('Cancelling pair review retains the current wizard step and anchor without approval',async()=>{
  await mount('/start?setup=1&setupFlow=bridge-first&step=0&connect='+code+'&p=own#computer');await click('Отмена');const value=route();expect(value.pathname).toBe('/start');expect(value.searchParams.get('step')).toBe('0');expect(value.searchParams.get('p')).toBe('own');expect(value.hash).toBe('#computer');expect(value.searchParams.has('connect')).toBe(false);expect(io.approve).not.toHaveBeenCalled();
 });
});
