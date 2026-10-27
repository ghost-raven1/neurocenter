import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys,type IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import {CatalogHeaderActions} from '../src/features/CatalogRequests/CatalogHeaderActions';
import StoreCreateModal from '../src/modules/Store/StoreCreateModal';

const ui=vi.hoisted(()=>({buttons:new Map<string,{disabled?:boolean;onClick?:(event?:unknown)=>void}>(),
    submit:undefined as undefined|((value:unknown)=>void),create:vi.fn(),kind:'mcp'}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:()=>()=>true})}));
vi.mock('../src/features/CatalogRequests/CatalogRequestButton',()=>({CatalogRequestButton:()=>null}));
vi.mock('../src/features/Catalog/publication/SkillResourceEditor',()=>({SkillResources:()=>null}));
vi.mock('../src/features/Catalog/publication/DependencyPinsEditor',()=>({DependencyPinsEditor:()=>null}));
vi.mock('../src/core/api/bff',()=>({default:{createSkill:ui.create,createAiPlugin:ui.create}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children,input=()=>null;
    return {Button:(props:{children?:ReactNode;disabled?:boolean;onClick?:(event?:unknown)=>void})=>{
        ui.buttons.set(String(props.children),props);return createElement('button',{disabled:props.disabled},props.children);
    },Form:Object.assign(({children,onFinish}:{children?:ReactNode;onFinish:typeof ui.submit})=>{ui.submit=onFinish;return children;},
        {Item:content,useForm:()=>[{}],useWatch:(name:string)=>name==='kind'?ui.kind:'remote'}),
    Alert:({message,action}:{message?:ReactNode;action?:ReactNode})=>createElement('div',null,message,action),
    Tooltip:content,Space:content,Modal:content,Checkbox:content,Input:Object.assign(input,{TextArea:input}),Radio:{Group:input},Select:input,
    Typography:{Paragraph:content},message:{success:vi.fn()}};
});
function render(children:ReactNode,enabled:boolean|null){
    const data=enabled===null?null:{flags:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),
        configured:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),blockedBy:Object.fromEntries(featureFlagKeys.map(key=>[key,[]]))}as IEvaluatedFeatureFlags;
    return renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider,{value:{data,loading:false,error:null,refresh:async()=>undefined}},children));
}
const header=(onPackage:()=>void,isMain=true)=>createElement(CatalogHeaderActions,{section:'tools',projects:[],isMain,onCreate:vi.fn(),onPackage});
beforeEach(()=>{vi.clearAllMocks();ui.buttons.clear();ui.submit=undefined;ui.kind='mcp';});

/** Flags control new writes; opening existing work must remain reachable through the normal product launcher. */
describe('Packaging recovery entry with actual feature availability',()=>{
    it('Moves manual creation into a labelled disclosure without hiding the retained packaging launcher',()=>{
        const html=render(header(vi.fn()),false);
        expect(html).toContain('<details class="catalog-requests__more">');expect(html).not.toContain('<details open');
        expect(html).toContain('aria-label="Другие действия с каталогом инструментов"');
        expect(ui.buttons.get('Упаковать инструмент')?.disabled).not.toBe(true);
        expect(ui.buttons.get('Добавить вручную')?.disabled).toBe(true);
    });
    it.each([false,null,true])('The main administrator can open existing builds with availability %s',enabled=>{
        const open=vi.fn();render(header(open),enabled);
        const button=ui.buttons.get('Упаковать инструмент');expect(button).toBeDefined();expect(button!.disabled).not.toBe(true);
        button!.onClick?.();expect(open).toHaveBeenCalledOnce();
    });
    it('Does not grant the administrative launcher to another role',()=>{
        const open=vi.fn();render(header(open,false),false);expect(ui.buttons.has('Упаковать инструмент')).toBe(false);expect(open).not.toHaveBeenCalled();
    });
    it.each(['mcp','skill'])('The manual %s form opens recovery while new publication is OFF',kind=>{
        ui.kind=kind;const open=vi.fn();render(createElement(StoreCreateModal,{open:true,onClose:vi.fn(),onCreated:vi.fn(),onPackage:open}),false);
        const button=ui.buttons.get(kind==='skill'?'Добавить скилл архивом':'Упаковать инструмент');
        expect(button).toBeDefined();expect(button!.disabled).not.toBe(true);button!.onClick?.();
        expect(open).toHaveBeenCalledExactlyOnceWith(kind==='skill'?'files':undefined);
        expect(ui.buttons.get('Добавить в магазин')?.disabled).toBe(true);
    });
    it.each([false,null])('Opening recovery does not bypass a new publication guard for %s',async enabled=>{
        render(createElement(StoreCreateModal,{open:true,onClose:vi.fn(),onCreated:vi.fn(),onPackage:vi.fn()}),enabled);
        ui.submit?.({kind:'mcp',name:'Retained draft',description:'Keep me',mode:'remote',url:'https://example.test/mcp'});
        for(let index=0;index<10;index++)await Promise.resolve();
        expect(ui.create).not.toHaveBeenCalled();
    });
});
