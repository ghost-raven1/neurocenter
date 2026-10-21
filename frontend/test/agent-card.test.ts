import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentCard } from '../src/features/AgentCatalog/AgentCard';
import { projectAgentStatus } from '../src/features/AgentCatalog/model';
import { agent, assignment, catalog, target } from './agent-fixtures';
vi.mock('../src/features/AssetManagement/ArchiveAssetButton',()=>({ArchiveAssetButton:({kind}:{kind:string})=>createElement('button',{'data-kind':kind},'Управление каталогом')}));
const callbacks={onView:()=>undefined,onEdit:()=>undefined,onArchived:()=>undefined,onAssign:()=>undefined,onConfigure:()=>undefined,onToggle:()=>undefined,onRemove:()=>undefined,onUpdate:()=>undefined};
const render=(changes:Partial<Parameters<typeof AgentCard>[0]>={})=>renderToStaticMarkup(createElement(AgentCard,{agent:agent(),projectSelected:true,isMain:false,canManage:false,busy:false,unavailable:false,...callbacks,...changes}));
describe('Карточка агента показывает права и сохраняет проектный pin',()=>{
    it('Наблюдатель читает промпт, но не получает действий изменения',()=>{
        const html=render({assignment:assignment()});expect(html).toContain('Промпт');expect(html).toContain('Настройками управляет администратор проекта');expect(html).not.toContain('>Включить<');expect(html).not.toContain('Удалить из проекта агента');expect(html).not.toContain('Изменить агента');
    });
    it('Project admin управляет desired, main admin дополнительно общим шаблоном',()=>{
        const html=render({canManage:true,assignment:assignment()});expect(html).toContain('>Включить<');expect(html).toContain('>Настроить<');expect(html).not.toContain('Управление каталогом');
        expect(render({isMain:true})).toContain('data-kind="agent"');
    });
    it('Desired enable до ACK не показывает успешную настройку',()=>{
        const desired=assignment({enabled:true});const html=render({canManage:true,assignment:desired,status:projectAgentStatus(catalog({assignments:[desired]}),desired,target)});
        expect(html).toContain('Нужно применить в OpenCode');expect(html).toContain('В проекте сохранено: включён');expect(html).not.toContain('Настроен в OpenCode');expect(html).toContain('>Отключить<');
    });
    it('Новая версия каталога не скрывает закреплённое имя, prompt и override',()=>{
        const desired=assignment({card:agent({name:'Прежний ревьюер'}),overrides:{prompt:'Мой промпт'}});const html=render({canManage:true,agent:agent({version:2,name:'Новый ревьюер'}),assignment:desired});
        expect(html).toContain('Прежний ревьюер');expect(html).toContain('Настроен для проекта');expect(html).toContain('Проект сохраняет v1');expect(html).toContain('Обновить шаблон');
    });
    it('Archived карточка сохраняет проектные действия, но не предлагает новое назначение',()=>{
        const archived=agent({archivedAt:'2026-10-21'});expect(render({canManage:true,agent:archived,assignment:assignment()})).toContain('>Настроить<');
        const html=render({canManage:true,agent:archived});expect(html).toContain('Убран из общего каталога');expect(html).toMatch(/disabled=""[^>]*>.*?Добавить в проект/s);
    });
});
