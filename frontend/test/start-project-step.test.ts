import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {IBridgeBinding,IBridgeDevice} from '../src/features/McpBridge/api';
import type {useBridge} from '../src/features/McpBridge/useBridge';
import {StartProjectStep} from '../src/modules/Start/StartProjectStep';

type Bridge=ReturnType<typeof useBridge>;
interface Button {disabled?:boolean;type?:string;onClick?:()=>void;children?:ReactNode}
const fixture=vi.hoisted(()=>({
    bridge:undefined as Bridge|undefined,connection:undefined as Bridge|undefined,
    user:{email:'owner@example.test',activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[] as Array<{projectId:string;projectName:string;role:string}>},
    alerts:[] as Array<{type?:string;message?:ReactNode}>,buttons:new Map<string,Button>(),push:vi.fn(),refresh:vi.fn(),select:vi.fn(),back:vi.fn(),
}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:fixture.push})}));
vi.mock('react-redux',()=>({useSelector:(selector:(state:unknown)=>unknown)=>selector({userBlock:{user:fixture.user}})}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>fixture.bridge}));
vi.mock('../src/features/McpBridge/BridgeConnection',()=>({BridgeConnection:({bridge}:{bridge:Bridge})=>{fixture.connection=bridge;return null;}}));
vi.mock('antd',async original=>{
    const actual=await original<typeof import('antd')>();return {...actual,
        Alert:(props:Parameters<typeof actual.Alert>[0])=>{fixture.alerts.push(props);return createElement(actual.Alert,props);},
        Button:(props:Parameters<typeof actual.Button>[0])=>{
            const label=(Array.isArray(props.children)?props.children:[props.children]).filter(value=>typeof value==='string').join('').trim();
            fixture.buttons.set(label,props as Button);return createElement(actual.Button,props);
        },
    };
});
const project={id:'prj-current',name:'Текущий проект'},other={id:'prj-other',name:'Другой проект'};
function binding(changes:Partial<IBridgeBinding>={}):IBridgeBinding{return {projectId:project.id,folderName:'work/current',valid:true,identityStatus:'verified',bindingId:'a'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111',...changes};}
function device(changes:Partial<IBridgeDevice>={}):IBridgeDevice{return {id:'computer-current',name:'Выбранный компьютер',role:'Главный админ',fingerprint:'test',online:true,lastSeen:'2026-10-21T00:00:00.000Z',report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','install-set-v1','workspace-instance-v1'],bindings:[binding()]},...changes};}
function selectDevice(value?:IBridgeDevice){fixture.bridge!.device=value;if(value&&!fixture.bridge!.devices.some(item=>item.id===value.id))fixture.bridge!.devices.push(value);}
function render(changes:Partial<Parameters<typeof StartProjectStep>[0]>={}){
    fixture.alerts=[];fixture.buttons.clear();fixture.connection=undefined;
    return renderToStaticMarkup(createElement(StartProjectStep,{projects:[project,other],ready:true,loading:false,error:'',requestedProject:project.id,selectedProject:project,refresh:fixture.refresh,onSelect:fixture.select,onBack:fixture.back,...changes}));
}
const success=()=>fixture.alerts.some(alert=>alert.type==='success');
beforeEach(()=>{
    vi.clearAllMocks();fixture.user={email:'owner@example.test',activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]};
    const selected=device();fixture.bridge={devices:[selected],device:selected,jobs:[],installations:[],devicesReady:true,jobsReady:true,installationsReady:true,loading:false,error:'',errors:{devices:'',jobs:'',installations:''},reload:vi.fn(),choose:vi.fn()};
});

describe('Текущая привязка на последнем этапе первого запуска',()=>{
    it('Показывает exact подтверждённую папку и делает каталог главным действием',()=>{
        const html=render();expect(success()).toBe(true);expect(html).toContain('Папка и проект связаны');expect(html).toContain('work/current');expect(html).toContain('Выбранный компьютер');
        expect(fixture.connection).toBe(fixture.bridge);expect(fixture.buttons.get('Подобрать инструменты')?.type).toBe('primary');expect(fixture.buttons.get('Связать другую папку')?.type).toBe('default');
        fixture.buttons.get('Подобрать инструменты')!.onClick!();expect(fixture.push).toHaveBeenLastCalledWith('/store?p='+encodeURIComponent(project.name));
        fixture.buttons.get('Связать другую папку')!.onClick!();expect(fixture.push).toHaveBeenLastCalledWith('/projects?bind='+project.id);
        fixture.buttons.get('Проверить привязку')!.onClick!();expect(fixture.bridge!.reload).toHaveBeenCalledOnce();fixture.buttons.get('Назад')!.onClick!();expect(fixture.back).toHaveBeenCalledOnce();
    });
    it.each(['invalid','unknown-validity','legacy','copied','changed','missing-hash','invalid-hash','missing-instance','invalid-instance','error','empty-folder'] as const)('Не принимает неподтверждённую идентичность: %s',state=>{
        const item=binding();if(state==='invalid')item.valid=false;if(state==='unknown-validity')item.valid=undefined;
        if(state==='legacy'||state==='copied'||state==='changed')item.identityStatus=state;
        if(state==='missing-hash')item.bindingId=undefined;if(state==='invalid-hash')item.bindingId='A'.repeat(64);
        if(state==='missing-instance')item.instanceId=undefined;if(state==='invalid-instance')item.instanceId='not-an-instance';
        if(state==='error')item.error='Не удалось проверить папку';if(state==='empty-folder')item.folderName='';
        fixture.bridge!.device!.report.bindings=[item];const html=render();expect(success()).toBe(false);expect(html).toContain('Подтвердите привязку папки заново');expect(html).not.toContain('Папка и проект связаны');
        expect(fixture.buttons.has('Связать другую папку')).toBe(false);
    });
    it('Не выдаёт чужой проект и старое успешное задание за текущую привязку',()=>{
        fixture.bridge!.device!.report.bindings=[binding({projectId:other.id,folderName:'private/other'})];
        fixture.bridge!.jobs=[{id:'old',deviceId:'computer-current',projectId:project.id,kind:'bind-project',state:'succeeded',message:'Готово',createdAt:'2026-10-20',updatedAt:'2026-10-20',result:{folderName:'old/current'}}];
        const html=render();expect(success()).toBe(false);expect(html).toContain('папка этого проекта пока не связана');expect(html).not.toContain('private/other');expect(html).not.toContain('old/current');
    });
    it('Переключение выбранного проекта и компьютера сразу убирает прошлую папку',()=>{
        expect(successAfterRender()).toBe(true);expect(render({selectedProject:other,requestedProject:other.id})).not.toContain('work/current');expect(success()).toBe(false);
        const replacement=device({id:'computer-other',name:'Другой компьютер',report:{...device().report,bindings:[]}});selectDevice(replacement);
        expect(render()).not.toContain('work/current');expect(success()).toBe(false);expect(fixture.connection!.device?.id).toBe('computer-other');
        selectDevice(undefined);expect(render()).toContain('Выберите компьютер');expect(success()).toBe(false);
    });
    it.each(['stale','device-error','owner-changed','foreign-device'] as const)('Скрывает прежнюю папку при неподтверждённом контексте: %s',state=>{
        if(state==='stale')fixture.bridge!.devicesReady=false;
        if(state==='device-error')fixture.bridge!.errors.devices='Ошибка нового запроса';
        if(state==='owner-changed'){fixture.user.email='another@example.test';fixture.bridge!.devicesReady=false;}
        if(state==='foreign-device')fixture.bridge!.devices=[];
        const html=render();expect(success()).toBe(false);expect(html).not.toContain('work/current');expect(html).toContain('Статус папки пока не подтверждён');
    });
    it.each(['offline','reconnect','device-role','user-role','missing-capability','old-protocol','root-error'] as const)('Показывает подтверждённую привязку без обещания установки: %s',state=>{
        const current=fixture.bridge!.device!;
        if(state==='offline')current.online=false;if(state==='reconnect')current.requiresReconnect=true;if(state==='device-role')current.role='Наблюдатель';
        if(state==='user-role'){fixture.user.activeRole='Наблюдатель';fixture.user.userRoles=['Наблюдатель'];}
        if(state==='missing-capability')current.report.capabilities=[];if(state==='old-protocol')current.report.protocolVersion=1;if(state==='root-error')current.report.rootError='Папка проектов недоступна';
        const html=render();expect(success()).toBe(false);expect(html).toContain('work/current');expect(fixture.alerts.some(alert=>alert.type==='warning')).toBe(true);expect(fixture.buttons.get('Подобрать инструменты')?.type).toBe('primary');
        if(state==='user-role')expect(fixture.buttons.get('Связать другую папку')?.disabled).toBe(true);
    });
    it('Перечисляет несколько папок и неподтверждённые записи без выбора первой за пользователя',()=>{
        fixture.bridge!.device!.report.bindings=[binding(),binding({folderName:'work/second',bindingId:'b'.repeat(64),instanceId:'22222222-2222-4222-8222-222222222222'}),binding({folderName:'work/damaged',valid:false}),binding({projectId:other.id,folderName:'other/hidden'})];
        const html=render();expect(success()).toBe(false);expect(html).toContain('Папки связаны с проектом');expect(html).toContain('work/current');expect(html).toContain('work/second');expect(html).toContain('work/damaged');expect(html).toContain('привязка не подтверждена');expect(html).not.toContain('other/hidden');
    });
    it.each(['loading','error','missing','empty'] as const)('Не показывает binding success без доступного выбранного проекта: %s',state=>{
        const changes=state==='loading'?{ready:false,loading:true}:state==='error'?{error:'Нет доступа'}:state==='missing'?{selectedProject:undefined}:{projects:[]};
        const html=render(changes);expect(success()).toBe(false);expect(html).not.toContain('work/current');expect(fixture.connection).toBeUndefined();
        if(state!=='loading')expect(fixture.buttons.get('Выбрать папку и связать проект')?.disabled).toBe(true);
    });
});
function successAfterRender(){render();return success();}
