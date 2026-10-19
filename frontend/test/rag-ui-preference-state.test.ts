import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {OpenCodeRagUi} from '../src/features/McpBridge/ragUi/OpenCodeRagUi';
import {ragUiInstallationKey,ragUiRequest} from '../src/features/McpBridge/ragUi/ragUiState';
import type {IRagUiPreference} from '../src/features/McpBridge/ragUi/ragUiPreference';
import {ragUiFixture} from './ragUiFixture';

const hooks=vi.hoisted(()=>{let cursor=0;const slots:Array<{value:unknown}>=[];return{
    begin:()=>{cursor=0;},clear:()=>{slots.length=0;},
    useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
    useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
};});
interface Button{children:ReactNode;disabled?:boolean;onClick?:()=>void;}
interface Choice{value?:string;disabled?:boolean;onChange:(key:string)=>void;}
const ui=vi.hoisted(()=>({owner:'owner-a',buttons:[] as Button[],choice:undefined as Choice|undefined,submit:vi.fn(),targets:[] as string[],error:''}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner;return{scope:owner,captureOwner:()=>()=>owner===ui.owner};}}));
vi.mock('../src/features/McpBridge/ragUi/useRagUiLauncher',()=>({useRagUiLauncher:(target:string)=>{ui.targets.push(target);return{busy:false,error:ui.error,submit:ui.submit};}}));
vi.mock('@ant-design/icons',()=>({ExportOutlined:()=>null}));
vi.mock('antd',async()=>{const {createElement:h}=await import('react'),content=({children}:{children?:ReactNode})=>children;return{
    Space:content,Typography:{Text:content,Paragraph:content},Progress:()=>null,
    Select:(props:Choice)=>{ui.choice=props;return null;},Button:(props:Button)=>{ui.buttons.push(props);return h('button',{disabled:props.disabled},props.children);},
    Alert:({message,description}:{message:ReactNode;description?:ReactNode})=>h('div',null,message,description),
};});
let f:ReturnType<typeof ragUiFixture>,preferred:IRagUiPreference;
function render(){hooks.begin();ui.buttons=[];ui.choice=undefined;return renderToStaticMarkup(createElement(OpenCodeRagUi,{bridge:f.bridge,projectId:'prj-one',canWrite:true,preferred}));}
const open=()=>ui.buttons.find(item=>String(item.children).includes('OpenCodeRAG')||String(item.children)==='Проверить и повторить открытие')!;
const plugin=()=>({...f.item,assetId:'plugin',assetKind:'plugin' as const,name:'Плагин'});
beforeEach(()=>{vi.clearAllMocks();hooks.clear();ui.owner='owner-a';ui.targets=[];ui.error='';f=ragUiFixture();f.device.report.root='/fixture/root';preferred={owner:ui.owner,root:f.device.report.root,request:ragUiRequest(f.item,f.binding)};});
afterEach(()=>hooks.clear());

describe('Предпочтение единственного launcher принадлежит текущему контексту',()=>{
    it('Явный другой пакет выбирается только в свежем контексте, исчезновение не подменяет его MCP',()=>{
        const other=plugin();f.bridge.installations=[f.item,other];render();ui.choice!.onChange(ragUiInstallationKey(other));render();open().onClick!();expect(ui.submit).toHaveBeenLastCalledWith(ragUiRequest(other,f.binding));
        f.bridge.installations=[f.item];render();expect(open().disabled).toBe(true);open().onClick!();expect(ui.submit).toHaveBeenCalledOnce();
        f.bridge.installations=[f.item,other];render();open().onClick!();expect(ui.submit).toHaveBeenLastCalledWith(ragUiRequest(other,f.binding));
    });
    it('Временная пропажа предпочтённой установки сохраняет target неизвестного POST',()=>{
        const other=plugin();f.bridge.installations=[f.item,other];ui.error='Ответ потерян';render();const target=ui.targets.at(-1);open().onClick!();
        f.bridge.installations=[other];render();expect(open().disabled).toBe(true);expect(ui.targets.at(-1)).toBe(target);
        f.bridge.installations=[f.item,other];render();expect(ui.targets.at(-1)).toBe(target);open().onClick!();expect(ui.submit.mock.calls[1][0]).toEqual(ui.submit.mock.calls[0][0]);
    });
    it('Поздний выбор и нажатие после A→B→A не меняют новое действие',()=>{
        const other=plugin();f.bridge.installations=[f.item,other];render();const oldChoice=ui.choice!.onChange,oldOpen=open().onClick!;
        f.device.report.root='/fixture/other';render();f.device.report.root='/fixture/root';render();oldChoice(ragUiInstallationKey(other));oldOpen();render();expect(ui.submit).not.toHaveBeenCalled();
        open().onClick!();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(preferred.request);
    });
    it('Смена владельца до нового render и просроченные ресурсы запрещают старый обработчик выбора',()=>{
        const other=plugin();f.bridge.installations=[f.item,other];render();const old=ui.choice!.onChange;ui.owner='owner-b';old(ragUiInstallationKey(other));ui.owner='owner-a';render();open().onClick!();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(preferred.request);
        f.bridge.installationsReady=false;render();ui.choice!.onChange(ragUiInstallationKey(other));f.bridge.installationsReady=true;render();open().onClick!();expect(ui.submit).toHaveBeenLastCalledWith(preferred.request);
    });
});
