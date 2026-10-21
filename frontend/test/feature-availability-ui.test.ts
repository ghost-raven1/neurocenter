import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {FeatureAvailabilityContext,FeatureButton} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys} from '../src/features/FeatureFlags/types';
import type {IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import {ConversationList} from '../src/features/ModelChat/ConversationList';
import {ModelHosting} from '../src/features/ModelCatalog/ModelHosting';
import {model} from './model-chat-fixtures';

const ui=vi.hoisted(()=>({buttons:new Map<string,{disabled?:boolean;onClick?:(event:unknown)=>void}>(),operate:vi.fn(),refresh:vi.fn()}));
vi.mock('antd',async original=>({...await original<typeof import('antd')>(),Button:(props:import('antd').ButtonProps)=>{
    const label=typeof props.children==='string'?props.children:String(props['aria-label']??'');
    ui.buttons.set(label,props as unknown as {disabled?:boolean;onClick?:(event:unknown)=>void});
    return createElement('button',{disabled:props.disabled},props.children);
}}));
vi.mock('../src/features/ModelCatalog/useModelHosting',()=>({useModelHosting:()=>({hosting:{state:'ready'},busy:false,loading:false,error:'',operate:ui.operate,refresh:ui.refresh})}));
const flags=(enabled:boolean):IEvaluatedFeatureFlags=>({flags:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),configured:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),blockedBy:Object.fromEntries(featureFlagKeys.map(key=>[key,[]]))})as IEvaluatedFeatureFlags;
function render(children:ReactNode,data:IEvaluatedFeatureFlags|null=flags(true)):string {
    return renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider,{value:{data,loading:false,error:null,refresh:async()=>undefined}},children));
}
beforeEach(()=>{vi.clearAllMocks();ui.buttons.clear();});

describe('Отключённые функции сохраняют чтение и recovery',()=>{
    it.each(featureFlagKeys)('Кнопка %s проверяет серверный effective и не вызывает обработчик при выключении',key=>{
        const action=vi.fn(),button=createElement(FeatureButton,{features:[key],onClick:action},key);
        const disabledHtml=render(button,flags(false));expect(ui.buttons.get(key)?.disabled).toBe(true);expect(disabledHtml).toContain('выключено главным администратором');
        ui.buttons.get(key)?.onClick?.({});expect(action).not.toHaveBeenCalled();
        render(button,flags(true));expect(ui.buttons.get(key)?.disabled).toBe(false);ui.buttons.get(key)?.onClick?.({});expect(action).toHaveBeenCalledOnce();
    });
    it('Отсутствующий provider и неизвестное состояние блокируют действие, recovery без требований доступен',()=>{
        const action=vi.fn();renderToStaticMarkup(createElement(FeatureButton,{features:['projects'],onClick:action},'Создать'));
        expect(ui.buttons.get('Создать')?.disabled).toBe(true);ui.buttons.get('Создать')?.onClick?.({});expect(action).not.toHaveBeenCalled();
        render(createElement(FeatureButton,{features:[],onClick:action},'Отменить'),null);expect(ui.buttons.get('Отменить')?.disabled).toBe(false);
        ui.buttons.get('Отменить')?.onClick?.({});expect(action).toHaveBeenCalledOnce();
    });
    it('Group off запрещает новую группу, но сохраняет модельный чат, список и refresh',()=>{
        const data=flags(true);data.flags.group_chat=false;data.configured.group_chat=false;
        render(createElement(ConversationList,{items:[],disabled:false,loading:false,onNew:vi.fn(),onNewGroup:vi.fn(),onSelect:vi.fn(),onRefresh:vi.fn()}),data);
        expect(ui.buttons.get('Группа агентов')?.disabled).toBe(true);expect(ui.buttons.get('Новый диалог')?.disabled).toBe(false);expect(ui.buttons.get('Обновить диалоги')?.disabled).toBe(false);
    });
    it('Hosting off блокирует start/check, сохраняя stop и чтение статуса',()=>{
        render(createElement(ModelHosting,{model:{...model,runtime:'ollama'},canManage:true}),flags(false));
        expect(ui.buttons.get('Запустить')?.disabled).toBe(true);expect(ui.buttons.get('Проверить модель')?.disabled).toBe(true);
        expect(ui.buttons.get('Выгрузить из памяти')?.disabled).toBe(false);ui.buttons.get('Выгрузить из памяти')?.onClick?.({});expect(ui.operate).toHaveBeenCalledWith('stop');
        expect(ui.buttons.get('Обновить статус')?.disabled).toBe(false);
    });
    it('Зависимость выключает только требуемое действие, ACL disabled остаётся независимым',()=>{
        const data=flags(true);data.flags.group_chat=false;data.blockedBy.group_chat=['agents'];
        expect(render(createElement(FeatureButton,{features:['group_chat']},'Группа'),data)).toContain('Управление агентами');
        render(createElement(FeatureButton,{features:['projects'],disabled:true},'Чужой проект'),flags(true));expect(ui.buttons.get('Чужой проект')?.disabled).toBe(true);
    });
});
