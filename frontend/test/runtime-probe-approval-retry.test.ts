import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {bridgeApi, type IBridgeInstallation, type IInstallPlan} from '../src/features/McpBridge/api';
import {RuntimeProbeModal} from '../src/features/McpBridge/RuntimeProbeModal';
import {ragUiFixture} from './ragUiFixture';

const hooks=vi.hoisted(()=>{
    let cursor=0;
    const slots:Array<{value?:unknown;dependencies?:unknown[];cleanup?:()=>void}>=[];
    const effects:Array<()=>void>=[];
    return {
        begin:()=>{cursor=0;},
        commit:()=>effects.splice(0).forEach(effect=>effect()),
        dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial:T|(()=>T)) {
            const slot=slots[cursor++]??={value:typeof initial==='function'?(initial as ()=>T)():initial};
            return [slot.value,(next:T|((previous:T)=>T))=>{slot.value=typeof next==='function'?(next as (previous:T)=>T)(slot.value as T):next;}];
        },
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useEffect(effect:()=>void|(()=>void),dependencies?:unknown[]){
            const index=cursor++,previous=slots[index];
            if(previous&&dependencies&&previous.dependencies?.length===dependencies.length
                &&dependencies.every((value,item)=>Object.is(value,previous.dependencies![item])))return;
            const slot=slots[index]={dependencies};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});
        },
    };
});
interface Button {children:ReactNode;disabled?:boolean;loading?:boolean;onClick?:()=>void;}
interface Checkbox {checked:boolean;disabled?:boolean;onChange:(event:{target:{checked:boolean}})=>void;}
const ui=vi.hoisted(()=>({buttons:new Map<string,Button>(),checkbox:undefined as Checkbox|undefined}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
    useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useEffect,
}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{preparePlan:vi.fn(),plan:vi.fn(),create:vi.fn()}}));
vi.mock('../src/features/McpBridge/RuntimeProbeStatus',()=>({RuntimeProbeStatus:()=>null}));
vi.mock('antd',async()=>{
    const {createElement:h}=await import('react');
    const content=({children}:{children?:ReactNode})=>children;
    return {Modal:content,Space:content,Typography:{Text:content,Paragraph:content},
        Alert:({message,description}:{message:ReactNode;description?:ReactNode})=>h('div',null,message,description),
        Button:(props:Button)=>{if(typeof props.children==='string')ui.buttons.set(props.children,props);return h('button',{disabled:props.disabled},props.children);},
        Checkbox:(props:Checkbox)=>{ui.checkbox=props;return null;},
        List:Object.assign(({dataSource,renderItem}:{dataSource:unknown[];renderItem:(value:unknown)=>ReactNode})=>dataSource.map(renderItem),{Item:content}),
    };
});
function deferred<T>() {
    let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;
    const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};
}
function fixture() {
    const value=ragUiFixture();value.device.report.capabilities!.push('workspace-instance-v1','runtime-probe-v1');
    const item:IBridgeInstallation={...value.item,inspection:{schemaVersion:1,projectId:value.item.projectId,bindingId:value.binding.bindingId,
        assetId:value.item.assetId,assetKind:value.item.assetKind,version:value.item.version,manifest:value.item.manifest,
        checkedAt:'2026-10-19T01:00:00Z',readiness:'unverified',state:'checked',status:'synced',issues:[]}};
    value.bridge.installations=[item];
    const plan:IInstallPlan={id:'approved-plan',projectId:item.projectId,assetId:item.assetId,assetKind:item.assetKind,version:item.version,
        manifest:item.manifest,status:'approved',revision:1,approvedBy:'admin@example.test',files:[],config:null,requirements:{}};
    return {...value,item,plan};
}
let current:ReturnType<typeof fixture>;
function render() {
    hooks.begin();ui.buttons.clear();ui.checkbox=undefined;
    const html=renderToStaticMarkup(createElement(RuntimeProbeModal,{item:current.item,bridge:current.bridge,canManage:true,onClose:vi.fn()}));
    hooks.commit();return html;
}
async function settle(){for(let i=0;i<8;i++)await Promise.resolve();render();render();}
function retry(){const value=ui.buttons.get('Повторить загрузку одобрения');expect(value).toBeDefined();return value!;}

beforeEach(()=>{
    vi.clearAllMocks();current=fixture();
    vi.mocked(bridgeApi.preparePlan).mockResolvedValue(current.plan);vi.mocked(bridgeApi.plan).mockResolvedValue(current.plan);
    vi.mocked(bridgeApi.create).mockResolvedValue(current.job({kind:'probe-runtime'}));
});
afterEach(()=>{hooks.dispose();vi.restoreAllMocks();});

describe('Повтор загрузки одобрения для диагностики в открытом окне',()=>{
    it('После временного сбоя можно повторить загрузку, но запуск по-прежнему требует отдельного согласия',async()=>{
        vi.mocked(bridgeApi.preparePlan).mockRejectedValueOnce(new Error('Каталог временно недоступен'));
        render();await settle();expect(render()).toContain('Каталог временно недоступен');expect(retry().disabled).not.toBe(true);
        expect(ui.buttons.get('Запустить диагностику')!.disabled).toBe(true);retry().onClick!();render();await settle();
        expect(bridgeApi.preparePlan).toHaveBeenCalledTimes(2);
        expect(vi.mocked(bridgeApi.preparePlan).mock.calls[1][0]).toEqual(vi.mocked(bridgeApi.preparePlan).mock.calls[0][0]);
        expect(render()).not.toContain('Каталог временно недоступен');expect(ui.checkbox?.checked).toBe(false);
        expect(ui.buttons.get('Запустить диагностику')!.disabled).toBe(true);expect(bridgeApi.create).not.toHaveBeenCalled();
        ui.checkbox!.onChange({target:{checked:true}});render();ui.buttons.get('Запустить диагностику')!.onClick!();await settle();
        expect(bridgeApi.create).toHaveBeenCalledOnce();expect(vi.mocked(bridgeApi.create).mock.calls[0][0]).toMatchObject({kind:'probe-runtime',
            deviceId:current.device.id,projectId:current.item.projectId,expectedManifest:current.item.manifest,consentManifest:current.plan.manifest});
    });
    it('Повторная ошибка сохраняет доступный retry и не запускает код автоматически',async()=>{
        vi.mocked(bridgeApi.preparePlan).mockRejectedValue(new Error('Каталог недоступен'));
        render();await settle();retry().onClick!();render();await settle();
        expect(retry().disabled).not.toBe(true);expect(bridgeApi.preparePlan).toHaveBeenCalledTimes(2);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Неподтверждённое одобрение можно перечитать после его одобрения администратором',async()=>{
        vi.mocked(bridgeApi.preparePlan).mockResolvedValueOnce({...current.plan,status:'pending'});
        render();await settle();expect(render()).toContain('действующее одобрение');retry().onClick!();render();await settle();
        expect(ui.checkbox?.checked).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('Поздний ответ закрытого окна не подставляет одобрение в повторно открытое окно',async()=>{
        const old=deferred<IInstallPlan>(),fresh=deferred<IInstallPlan>();
        vi.mocked(bridgeApi.preparePlan).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        render();hooks.dispose();render();old.resolve(current.plan);await settle();
        expect(ui.checkbox).toBeUndefined();expect(bridgeApi.create).not.toHaveBeenCalled();fresh.resolve(current.plan);await settle();
        expect(ui.checkbox?.checked).toBe(false);expect(bridgeApi.create).not.toHaveBeenCalled();
    });
});
