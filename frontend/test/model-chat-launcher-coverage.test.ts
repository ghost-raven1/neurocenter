import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChatLauncher} from '../src/features/ModelChat/ChatLauncher';
import {OPEN_CHAT_EVENT} from '../src/features/ModelChat/chatNavigation';
import type {IChatLaunch} from '../src/features/ModelChat/chatNavigation';
const hooks=vi.hoisted(()=>{let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},state<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(value:T)=>{slot.value=value;}];},ref<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},effect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,previous=slots[index];if(previous?.deps&&deps.length===previous.deps.length&&deps.every((value,i)=>Object.is(value,previous.deps![i])))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});}};});
const ui=vi.hoisted(()=>({user:{activeRole:'Разработчик',userRoles:['Разработчик','Главный админ']}as {activeRole:string;userRoles:string[]}|null,scope:'alice:developer',pathname:'/projects/prj-one',search:'',button:undefined as {disabled:boolean;onClick:()=>void;'aria-expanded':boolean}|undefined,overlay:undefined as (IChatLaunch&{onClose:()=>void})|undefined,fallbackClose:undefined as (()=>void)|undefined,tooltip:''}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state,useRef:hooks.ref,useEffect:hooks.effect}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:ui.user}})}));
vi.mock('react-router-dom',()=>({useLocation:()=>({pathname:ui.pathname,search:ui.search})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:ui.scope})}));
vi.mock('../src/features/ModelChat/ChatOverlay',()=>({default:(props:IChatLaunch&{onClose:()=>void})=>{ui.overlay=props;return createElement('section',{'data-chat-overlay':true},'Личные диалоги');}}));
vi.mock('antd',()=>({Button:(props:NonNullable<typeof ui.button>&{children:ReactNode})=>{ui.button=props;return createElement('button',{disabled:props.disabled,'aria-expanded':props['aria-expanded']},props.children);},Tooltip:({title,children}:{title:string;children:ReactNode})=>{ui.tooltip=title;return children;},Modal:({children,onCancel}:{children:ReactNode;onCancel:()=>void})=>{ui.fallbackClose=onCancel;return createElement('dialog',null,children);},Spin:({tip}:{tip:string})=>createElement('span',null,tip)}));
class FocusTarget {isConnected=true;focus=vi.fn();}
let target:FocusTarget,listeners:Map<string,EventListener>,add:ReturnType<typeof vi.fn>,remove:ReturnType<typeof vi.fn>;
const render=()=>{hooks.begin();ui.overlay=undefined;const html=renderToStaticMarkup(createElement(ChatLauncher));hooks.commit();return html;};
const dispatch=(detail:unknown)=>listeners.get(OPEN_CHAT_EVENT)!({detail}as unknown as Event);
const settle=async()=>{await vi.dynamicImportSettled();for(let i=0;i<8;i++)await Promise.resolve();render();};
beforeEach(()=>{hooks.dispose();vi.clearAllMocks();ui.user={activeRole:'Разработчик',userRoles:['Разработчик','Главный админ']};ui.scope='alice:developer';ui.pathname='/projects/prj-one';ui.search='';ui.overlay=undefined;ui.fallbackClose=undefined;target=new FocusTarget();listeners=new Map();add=vi.fn((name:string,callback:EventListener)=>listeners.set(name,callback));remove=vi.fn((name:string,callback:EventListener)=>{if(listeners.get(name)===callback)listeners.delete(name);});vi.stubGlobal('HTMLElement',FocusTarget);vi.stubGlobal('document',{activeElement:target});vi.stubGlobal('window',{addEventListener:add,removeEventListener:remove});});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();});

describe('Общий launcher: права, intent, scope и клавиатурный фокус',()=>{
    it('Явное открытие фиксирует проект текущего route, lazy overlay сохраняет его при навигации под ним',async()=>{
        render();expect(ui.button?.['aria-expanded']).toBe(false);expect(ui.overlay).toBeUndefined();expect(ui.tooltip).toContain('Команда проекта');ui.button!.onClick();render();await settle();expect(ui.overlay?.projectId).toBe('prj-one');expect(ui.overlay?.team).toBe(true);expect(ui.button?.['aria-expanded']).toBe(true);ui.pathname='/projects/prj-two';render();expect(ui.overlay?.projectId).toBe('prj-one');
    });
    it('Закрытие возвращает фокус подключённому trigger, следующее открытие берёт новый route scope',async()=>{
        render();ui.button!.onClick();render();await settle();ui.overlay!.onClose();await Promise.resolve();expect(target.focus).toHaveBeenCalledWith({preventScroll:true});render();expect(ui.button?.['aria-expanded']).toBe(false);ui.pathname='/store';ui.search='?p=prj-next';render();ui.button!.onClick();render();expect(ui.overlay?.projectId).toBe('prj-next');
    });
    it('Intent из project agents открывает группу, неизвестные поля не попадают в overlay',async()=>{
        render();dispatch({projectId:'prj-agent',group:true,url:'https://wrong.invalid',secret:'not-forwarded'});render();await settle();expect(ui.overlay).toMatchObject({projectId:'prj-agent',group:true});expect(ui.overlay).not.toHaveProperty('url');expect(ui.overlay).not.toHaveProperty('secret');
    });
    it('Невалидный payload игнорируется, частично валидный payload не подменяет тип projectId/group',async()=>{
        render();for(const detail of [undefined,null,'project',42,false])dispatch(detail);render();expect(ui.overlay).toBeUndefined();dispatch({projectId:99,group:'true'});render();await settle();expect(ui.overlay?.projectId).toBeUndefined();expect(ui.overlay?.group).toBe(false);
    });
    it.each([null,{activeRole:'Главный админ',userRoles:['Разработчик']},{activeRole:'unknown',userRoles:['unknown']}])('Не назначенная роль %j не открывает чат через кнопку или событие',async(user)=>{
        ui.user=user;render();expect(ui.button?.disabled).toBe(true);expect(ui.tooltip).toContain('нужен доступ');ui.button!.onClick();dispatch({projectId:'prj-one',group:true});render();await settle();expect(ui.overlay).toBeUndefined();expect(ui.button?.['aria-expanded']).toBe(false);
    });
    it('Наблюдатель открывает общую команду для чтения, не личный inference-диалог',async()=>{
        ui.user={activeRole:'Наблюдатель',userRoles:['Наблюдатель']};render();expect(ui.button?.disabled).toBe(false);ui.button!.onClick();render();await settle();expect(ui.overlay).toMatchObject({projectId:'prj-one',team:true});
    });
    it('Смена auth scope немедленно скрывает private overlay и заменяет listener',async()=>{
        render();const original=listeners.get(OPEN_CHAT_EVENT);ui.button!.onClick();render();await settle();expect(ui.overlay).toBeDefined();ui.scope='bob:admin';ui.user={activeRole:'Главный админ',userRoles:['Главный админ']};render();expect(ui.overlay).toBeUndefined();expect(remove).toHaveBeenCalledWith(OPEN_CHAT_EVENT,original);expect(listeners.get(OPEN_CHAT_EVENT)).not.toBe(original);
    });
    it('Удалённый trigger и не-HTMLElement activeElement безопасны при закрытии',async()=>{
        render();ui.button!.onClick();render();await settle();target.isConnected=false;ui.overlay!.onClose();await Promise.resolve();expect(target.focus).not.toHaveBeenCalled();render();vi.stubGlobal('document',{activeElement:{}});ui.button!.onClick();render();ui.overlay!.onClose();await Promise.resolve();expect(target.focus).not.toHaveBeenCalled();
    });
    it('Unmount удаляет обработчик открытия, поэтому глобальный intent не сохраняет старый owner',()=>{
        render();const callback=listeners.get(OPEN_CHAT_EVENT);hooks.dispose();expect(remove).toHaveBeenCalledWith(OPEN_CHAT_EVENT,callback);expect(listeners.has(OPEN_CHAT_EVENT)).toBe(false);
    });
});
