import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {BridgeSourcePanel} from '../src/features/McpBridge/BridgeSourcePanel';
import type {IBridgeSource} from '../src/features/McpBridge/bridgeSource';
import type {IAssetImport} from '../src/features/AssetSources/types';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[]}>=[],effects:Array<()=>void>=[];
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.length=0;effects.length=0;},
        useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return [slot.value,(value:T)=>{slot.value=value;}];},
        useRef<T>(initial:T){return (slots[cursor++]??={value:{current:initial}}).value;},
        useEffect(effect:()=>void,deps:unknown[]){const index=cursor++,previous=slots[index];if(previous&&previous.deps?.length===deps.length&&deps.every((value,position)=>Object.is(value,previous.deps?.[position])))return;slots[index]={deps};effects.push(effect);},
    };
});
interface Button {children?:ReactNode;disabled?:boolean;onClick?:()=>void}
interface Modal {open:boolean;onOk:()=>void;children?:ReactNode}
const fixture=vi.hoisted(()=>({data:undefined as IBridgeSource|undefined,job:undefined as IAssetImport|undefined,canManage:true,buttons:new Map<string,Button>(),modal:undefined as Modal|undefined,resolve:vi.fn(),start:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useEffect}));
vi.mock('../src/features/McpBridge/useBridgeSource',()=>({useBridgeSource:()=>({data:fixture.data,error:'',loading:false,saving:false,reload:vi.fn(),check:vi.fn(),save:vi.fn()})}));
vi.mock('../src/features/McpBridge/useBridgeSourceImport',()=>({useBridgeSourceImport:()=>({job:fixture.job,intent:{expectedRevision:3},error:'',busy:false,blocked:false,start:fixture.start,resolve:fixture.resolve})}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Button:(props:Button)=>{fixture.buttons.set(Array.isArray(props.children)?props.children.join(''):String(props.children),props);return props.children;},Space:content,Typography:{Text:content,Paragraph:content,Link:content},
        Input:()=>null,Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),
        Modal:(props:Modal)=>{fixture.modal=props;return props.open?props.children:null;},Collapse:Object.assign(content,{Panel:content})};
});
const source:IBridgeSource={url:'https://github.com/fork/assets',revision:3,checkedAt:'2026-10-21T03:00:00Z',available:{assetId:'bridge',version:'0.10.0',buildId:'b'.repeat(64),repositoryCommit:'c'.repeat(40),targets:['darwin-arm64']},imported:{assetId:'bridge',version:'0.9.5',buildId:'a'.repeat(64),repositoryUrl:'https://github.com/original/assets',repositoryCommit:'d'.repeat(40),targets:['darwin-arm64']}};
const job:IAssetImport={id:'job-a',planDigest:'e'.repeat(64),state:'NEEDS_INPUT',message:'Нужен выбор источника',items:[{id:'bridge',kind:'bridge',name:'Мост',version:'0.10.0',current:true,action:'conflict',state:'NEEDS_INPUT',reason:'Поставка принадлежит другому источнику',replacement:{id:'bridge',version:1,hash:'f'.repeat(64)}}]};
function render(){hooks.begin();fixture.buttons.clear();const html=renderToStaticMarkup(createElement(BridgeSourcePanel,{installer:{origin:'https://gateway.test',loading:false,error:'',reload:vi.fn()},windows:false,verified:true,canManage:fixture.canManage,onInstall:vi.fn()}));hooks.commit();return html;}
beforeEach(()=>{vi.clearAllMocks();fixture.data=structuredClone(source);fixture.job=structuredClone(job);fixture.canManage=true;fixture.resolve.mockResolvedValue(true);});
afterEach(()=>hooks.dispose());
describe('Явное принятие поставки моста из другого источника',()=>{
    it('Сначала показывает старый/новый источник и версии, затем принимает только по подтверждению',async()=>{
        render();expect(fixture.resolve).not.toHaveBeenCalled();expect(fixture.buttons.get('Подготовить 0.10.0 к установке')?.disabled).toBe(true);
        fixture.buttons.get('Рассмотреть замену источника')?.onClick?.();const html=render();expect(fixture.modal?.open).toBe(true);
        expect(html).toContain('https://github.com/original/assets');expect(html).toContain('https://github.com/fork/assets');expect(html).toContain('0.9.5');expect(html).toContain('0.10.0');expect(html).toContain('другому источнику');
        fixture.modal?.onOk();await Promise.resolve();render();expect(fixture.resolve).toHaveBeenCalledOnce();expect(fixture.modal?.open).toBe(false);
    });
    it.each(['revision','job','role'] as const)('Устаревшее подтверждение не принимает замену после изменения %s',change=>{
        render();fixture.buttons.get('Рассмотреть замену источника')?.onClick?.();render();const old=fixture.modal!.onOk;
        if(change==='revision')fixture.data={...fixture.data!,revision:4};if(change==='job')fixture.job={...fixture.job!,id:'job-b'};if(change==='role')fixture.canManage=false;
        render();expect(fixture.modal?.open).toBe(false);old();expect(fixture.resolve).not.toHaveBeenCalled();
    });
    it('Не предлагает принять неразрешимый конфликт или делать это обычному участнику',()=>{
        fixture.job!.items[0].replacement=undefined;render();expect(fixture.buttons.has('Рассмотреть замену источника')).toBe(false);
        fixture.job=structuredClone(job);fixture.canManage=false;render();expect(fixture.buttons.has('Рассмотреть замену источника')).toBe(false);
    });
    it('Импорт прежней настройки не описывается как подготовка текущего источника',()=>{
        fixture.data={...fixture.data!,revision:4,url:'https://github.com/other/assets'};const html=render();expect(html).toContain('результат относится к прежней настройке');expect(fixture.buttons.has('Рассмотреть замену источника')).toBe(false);expect(fixture.modal?.open).toBe(false);
        fixture.job={...fixture.job!,state:'FAILED'};render();expect(fixture.buttons.has('Повторить подготовку')).toBe(false);
    });
});
