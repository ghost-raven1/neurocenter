import {describe, expect, it} from 'vitest';
import {canEditTool, skillProject, projectSkillReferenceBlocker, isToolInProject} from '../src/modules/Store/storeHelpers';
import {projectRoleLevel} from '../src/features/UserBlock/roles';

const user = {activeRole: 'Разработчик', userRoles: ['Разработчик', 'Главный админ', 'Наблюдатель'], projectRoles: [{projectId: 'prj-own', projectName: 'Мой проект', role: 'Разработчик'}]};
describe('Права редактора каталога', () => {
    it('Имя проекта не подменяет чужой ID в шапке и редакторе',()=>{
        const collision={...user,activeRole:'Админ проекта',userRoles:['Админ проекта'],projectRoles:[{projectId:'prj-own',projectName:'prj-foreign',role:'Админ проекта'}]};
        expect(projectRoleLevel(collision,'prj-foreign')).toBe(0);
        expect(canEditTool(collision,{kind:'skill',id:'project-prj-foreign/private'})).toBe(false);
    });
    it('Разработчик редактирует собственный проектный скилл', () => {
        expect(canEditTool(user, {kind: 'skill', id: 'project-prj-own/helper'})).toBe(true);
    });
    it.each(['project-prj-other/helper', 'common/helper', 'project-prj-own/../common/helper'])('Чужой или подменённый путь не открывает редактор: %s', id => {
        expect(canEditTool(user, {kind: 'skill', id})).toBe(false);
    });
    it('Наблюдатель не получает редактор через старшее назначение', () => {
        expect(canEditTool({...user, activeRole: 'Наблюдатель'}, {kind: 'skill', id: 'project-prj-own/helper'})).toBe(false);
    });
    it('Главный админ редактирует общий MCP', () => {
        expect(canEditTool({...user, activeRole: 'Главный админ'}, {kind: 'mcp', id: 'remote-mcp'})).toBe(true);
    });
    it('Одного похожего имени MCP недостаточно для проектного скилла', () => {
        expect(skillProject({kind: 'mcp', id: 'project-prj-own/helper'})).toBe(null);
    });
});

describe('Изоляция проектных скиллов при добавлении в каталог', () => {
    it('Скилл своего проекта уже доступен без повторного подключения', () => {
        expect(projectSkillReferenceBlocker({kind:'skill',id:'project-prj-own/helper'},'prj-own'))
            .toBe('Этот скилл уже доступен в каталоге своего проекта.');
    });
    it.each(['prj-other', undefined])('Не предлагает ссылку на проектный скилл для назначения %s', projectId => {
        expect(projectSkillReferenceBlocker({kind:'skill',id:'project-prj-own/helper'},projectId))
            .toContain('Используйте общий каталог или создайте отдельную копию');
    });
    it.each(['prj-own','prj-other',undefined])('Общий скилл можно добавить в выбранный каталог %s', projectId => {
        expect(projectSkillReferenceBlocker({kind:'skill',id:'common/helper'},projectId)).toBeNull();
    });
    it.each(['mcp','plugin'] as const)('Похожий ID не ограничивает добавление %s', kind => {
        expect(projectSkillReferenceBlocker({kind,id:'project-prj-own/helper'},'prj-other')).toBeNull();
    });
    it('Собственный проектный скилл входит в каталог без отдельной ссылки', () => {
        expect(isToolInProject({kind:'skill',id:'project-prj-own/helper',name:'Helper'},'prj-own',[])).toBe(true);
    });
    it('Совпадение имени и даже старая ссылка не включают чужой проектный скилл', () => {
        const app={kind:'skill' as const,id:'project-prj-other/helper',path:'project-prj-other/helper',name:'Helper'};
        expect(isToolInProject(app,'prj-own',[{assetKind:'skill',assetId:'helper'}])).toBe(false);
        expect(isToolInProject(app,'prj-own',[{assetKind:'skill',assetId:app.id}])).toBe(false);
    });
    it('Общие скиллы и MCP сохраняют существующее подключение к проекту', () => {
        expect(isToolInProject({kind:'skill',id:'common/helper',path:'common/helper',name:'Helper'},'prj-own',[
            {assetKind:'skill',assetId:'common/helper'},
        ])).toBe(true);
        expect(isToolInProject({kind:'mcp',id:'project-prj-other/helper',name:'Helper'},'prj-own',[
            {assetKind:'mcp',assetId:'project-prj-other/helper'},
        ])).toBe(true);
    });
});
