import { describe, expect, it, vi } from 'vitest';
import type { IProjectSummary } from '../src/core/api/interfaces';
import type { IStoreApp } from '../src/modules/Store/AppCard';
import { selectStoreTarget, storeProjectAssetRequest, visibleStoreApps } from '../src/modules/Store/storeCatalogView';
import { addToProjectCatalogs } from '../src/modules/Store/projectCatalogBatch';

const projects = [
    { id: 'prj-first', name: 'prj-second' },
    { id: 'prj-second', name: 'Второй проект' },
] as IProjectSummary[];
const user = { activeRole: 'Админ проекта', userRoles: ['Админ проекта'],
    projectRoles: [{ projectId: projects[0].id, projectName: projects[0].name, role: 'Админ проекта' }] };
const apps: IStoreApp[] = [
    { id: 'rag', name: 'OpenCodeRAG', kind: 'plugin', description: 'Поиск по знаниям', version: 1, tags: [], origin: '' },
    { id: 'memory', name: 'MCP Memory', kind: 'mcp', description: 'Память', version: 1, tags: [], origin: '' },
];
const filters = { projectOnly: false, projectSelected: true, installedOnly: true, kind: 'all' as const,
    query: '', inProject: (app: IStoreApp) => app.id === 'rag' };

describe('Выбор каталога и доступных действий', () => {
    it('Ссылка с ID выбирает нужный проект даже при совпадении с именем другого', () => {
        const selected = selectStoreTarget(projects, 'prj-second', user);
        expect(selected.project?.id).toBe('prj-second');
        expect(selected.level).toBe(0);
    });

    it('Имя проекта с префиксом prj не лишает его администратора установки и управления', () => {
        const selected = selectStoreTarget(projects, 'prj-first', user);
        expect(selected.project?.name).toBe('prj-second');
        expect(selected.level).toBe(3);
    });

    it('Обычная ссылка по имени и отсутствие выбранного проекта остаются доступными', () => {
        expect(selectStoreTarget(projects, 'Второй проект', user).project?.id).toBe('prj-second');
        expect(selectStoreTarget(projects, null, user)).toEqual({ project: undefined, level: 0 });
    });

    it('Назначение и снятие инструмента отправляют ID выбранного проекта вместо совпадающего чужого ID имени', async () => {
        const selected = selectStoreTarget(projects, 'prj-first', user).project!;
        const add = vi.fn().mockResolvedValue({ ok: true });
        const remove = vi.fn().mockResolvedValue({ ok: true });
        await add(...storeProjectAssetRequest(selected, apps[0]));
        await remove(...storeProjectAssetRequest(selected, apps[0], 'legacy-reference'));
        expect(add).toHaveBeenCalledExactlyOnceWith('prj-first', { assetId: 'rag', assetKind: 'plugin' });
        expect(remove).toHaveBeenCalledExactlyOnceWith('prj-first', { assetId: 'legacy-reference', assetKind: 'plugin' });
    });

    it('Массовое назначение различает ID и совпавшее имя соседнего проекта', async () => {
        const add = vi.fn().mockResolvedValue({ ok: true });
        const result = await addToProjectCatalogs(['prj-first', 'prj-second'],
            projectId => add(...storeProjectAssetRequest({ id: projectId }, apps[1])), () => true);
        expect(result).toEqual({ ok: 2, fail: 0 });
        expect(add.mock.calls).toEqual([
            ['prj-first', { assetId: 'memory', assetKind: 'mcp' }],
            ['prj-second', { assetId: 'memory', assetKind: 'mcp' }],
        ]);
    });
});

describe('Фильтры карточек каталога', () => {
    it('Снятие проекта показывает общий каталог даже при прежней включённой галочке', () => {
        expect(visibleStoreApps(apps, filters).map(app => app.id)).toEqual(['rag']);
        expect(visibleStoreApps(apps, { ...filters, projectSelected: false, inProject: () => false })).toEqual(apps);
    });

    it('Снятие проектного фильтра сохраняет выбранный тип и поисковый запрос', () => {
        expect(visibleStoreApps(apps, { ...filters, projectSelected: false, kind: 'mcp', query: 'память' }))
            .toEqual([apps[1]]);
    });

    it('Разработчик и встроенный каталог сохраняют ограничение инструментами выбранного проекта', () => {
        expect(visibleStoreApps(apps, { ...filters, projectOnly: true, installedOnly: false })).toEqual([apps[0]]);
        expect(visibleStoreApps(apps, { ...filters, projectOnly: true, projectSelected: false, inProject: () => false })).toEqual([]);
    });
});
