import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
import {ArchiveAssetButton} from '../src/features/AssetManagement/ArchiveAssetButton';
import {baseApi} from '../src/core/api';

interface ButtonProps {children?:ReactNode;disabled?:boolean;onClick?:()=>void}
const ui=vi.hoisted(()=>({cursor:0,states:[] as unknown[],buttons:new Map<string,ButtonProps>(),radios:new Map<string,{disabled?:boolean}>(),alerts:[] as Array<{type:string;showIcon?:boolean}>}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:(initial:unknown)=>{
 const index=ui.cursor++;if(!(index in ui.states))ui.states[index]=initial;return [ui.states[index],(value:unknown)=>{ui.states[index]=value;}];
}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'admin',captureOwner:()=>()=>true})}));
vi.mock('../src/core/api',()=>({baseApi:{post:vi.fn()}}));
vi.mock('antd',()=>{
 const content=({children}:{children?:ReactNode})=>children;
 const radio=({value,disabled,children}:{value:string;disabled?:boolean;children?:ReactNode})=>{ui.radios.set(value,{disabled});return children;};
 return {Space:content,Typography:{Paragraph:content,Text:content},Radio:Object.assign(radio,{Group:content}),
  Button:(props:ButtonProps)=>{ui.buttons.set(String(props.children),props);return props.children;},
  Alert:({type,showIcon,message,description,action}:{type:string;showIcon?:boolean;message?:ReactNode;description?:ReactNode;action?:ReactNode})=>{ui.alerts.push({type,showIcon});return createElement('div',null,message,description,action);},
  Modal:({open,children,footer}:{open:boolean;children?:ReactNode;footer?:ReactNode})=>open?createElement('div',null,children,footer):null,
 };
});
function render(restore=false){ui.cursor=0;ui.buttons.clear();ui.radios.clear();ui.alerts=[];return renderToStaticMarkup(createElement(ArchiveAssetButton,{kind:'model',id:'model-seven',restore,children:restore?'Вернуть из архива':'Удалить'}));}
const flush=async()=>{for(let n=0;n<10;n++)await Promise.resolve();};
beforeEach(()=>{vi.resetAllMocks();ui.states=[];ui.cursor=0;});

it('Объясняет active-model blockers, оставляет catalog-only и убирает warning после свежей проверки без blockers',async()=>{
 const projects=[{id:'prj-one',name:'Досье'},{id:'prj-two',name:'База команды'}];
 const impact={impactId:'impact-one',digest:'a'.repeat(64),target:{kind:'model',id:'model-seven',name:'Модель7d',version:1,archived:false},projects,preserved:[]};
 vi.mocked(baseApi.post).mockResolvedValueOnce({data:{...impact,removeBlockers:projects}});
 render();ui.buttons.get('Удалить')!.onClick!();await flush();const blocked=render();
 expect(ui.alerts).toEqual([{type:'warning',showIcon:true}]);expect(blocked).toContain('Досье, База команды');
 expect(blocked).toContain('Сначала выберите другую модель в настройках базы знаний этих проектов, затем обновите проверку.');
 expect(ui.radios.get('catalog-and-projects')?.disabled).toBe(true);expect(ui.radios.get('catalog-only')?.disabled).not.toBe(true);
 expect(ui.buttons.get('Убрать из каталога')?.disabled).toBe(false);
 vi.mocked(baseApi.post).mockResolvedValueOnce({data:{...impact,impactId:'impact-two',removeBlockers:[]}});
 ui.buttons.get('Обновить проверку')!.onClick!();await flush();const clear=render();
 expect(ui.alerts).toEqual([]);expect(clear).not.toContain('Сначала выберите другую модель');expect(ui.radios.get('catalog-and-projects')?.disabled).toBe(false);
 expect(baseApi.post).toHaveBeenCalledTimes(2);expect(baseApi.post).toHaveBeenLastCalledWith('/api/asset-management/impact',{kind:'model',id:'model-seven'});
});
it.each([{projects:[]},{projects:[{id:'prj-one',name:'Сохранённый проект'}]}])('Восстановление показывает точные назначения $projects без выбора последствий удаления',async({projects})=>{
 const impact={impactId:'restore-one',digest:'b'.repeat(64),target:{kind:'model',id:'model-seven',name:'Модель7d',version:2,archived:true},projects,preserved:[]};
 vi.mocked(baseApi.post).mockResolvedValueOnce({data:impact}).mockResolvedValueOnce({data:{state:'SUCCEEDED',message:'Восстановлено'}});
 render(true);ui.buttons.get('Вернуть из архива')!.onClick!();await flush();const html=render(true);
 if(projects.length){expect(html).toContain('Карточка подключена к проектам: Сохранённый проект.');expect(html).not.toContain('Подключений к проектам нет.');}
 else{expect(html).toContain('Подключений к проектам нет.');expect(html).not.toContain('Карточка подключена к проектам:');}
 expect(ui.radios.size).toBe(0);expect(html).not.toContain('Также убрать из');
 ui.buttons.get('Вернуть в каталог')!.onClick!();await flush();expect(baseApi.post).toHaveBeenLastCalledWith('/api/asset-management/archive',{impactId:impact.impactId,expectedDigest:impact.digest,mode:'restore'});
});
