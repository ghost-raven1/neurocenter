import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, it, vi } from 'vitest';

import bffApi from '../src/core/api/bff';
import type { IAuditEvent } from '../src/core/api/interfaces';
import { auditActorLabel, auditResourceLabel, describeAuditAction, filterAuditPage, formatAuditTime } from '../src/modules/Audit/auditHelpers';
import reducer, { setPage } from '../src/modules/Audit/redux/reducers';
import { fetchAudit } from '../src/modules/Audit/redux/actions';
import { authInit } from '../src/features/UserBlock/redux/actions';
import userBlock from '../src/features/UserBlock/redux/reducers';
import type { IAuthMe } from '../src/core/interfaces';

vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn() } }));
vi.mock('../src/core/api/bff', () => ({ default: { listAudit: vi.fn() } }));

const event: IAuditEvent = {
    id: 'event-1', at: '2026-10-16T10:00:00.000Z', actor: 'user@example.test', versionAuthor: '',
    action: 'skill.install', resourceType: 'skill', resourceId: 'rag-index-monitor', outcome: 'SUCCEEDED',
    decisionId: '', correlationId: 'operation-123',
};

describe('Поиск в странице журнала', () => {
    it('Показывает изменение настроек проекта понятным названием и находит его в поиске', () => {
        const settings = { ...event, action: 'project.settings.update', resourceType: 'project' };
        expect(describeAuditAction(settings.action)).toEqual({ label: 'Настройки проекта', color: 'cyan' });
        expect(filterAuditPage([settings], 'настройки проекта', 'all')).toEqual([settings]);
    });
    it('Отличает создание папки от создания скилла и находит её по действию', () => {
        const directory = { ...event, action: 'skill.directory.create', resourceId: 'common/team/tools' };
        expect(describeAuditAction(directory.action)).toEqual({ label: 'Создание папки', color: 'blue' });
        expect(filterAuditPage([directory], 'создание папки', 'all')).toEqual([directory]);
    });
    it.each([['skill.create','Создание'],['skill.update','Обновление'],['skill.delete','Удаление']])('Показывает и находит файловое событие %s по-русски', (action,label) => {
        const mutation={...event,action,resourceId:'common/helper'};
        expect(describeAuditAction(action).label).toBe(label);
        expect(auditResourceLabel(mutation.resourceType)).toBe('Скилл');
        expect(filterAuditPage([mutation],label,'all')).toEqual([mutation]);
        expect(filterAuditPage([mutation],'common/helper','all')).toEqual([mutation]);
    });
    it('Называет квитанцию сохранения старых ссылок историей, не успешным исправлением скилла', () => {
        const preserved = { ...event, action: 'skill.dependencies.preserve', resourceId: 'common/old-helper · sha256', actor: 'skills-service' };
        expect(describeAuditAction(preserved.action)).toEqual({ label: 'История зависимостей', color: 'orange' });
        expect(filterAuditPage([preserved], 'история зависимостей', 'all')).toEqual([preserved]);
        expect(filterAuditPage([preserved], 'common/old-helper', 'all')).toEqual([preserved]);
    });
    it('Находит действие по русскому названию без учёта регистра и пробелов', () => {
        expect(filterAuditPage([event], ' УСТАНОВКА ', 'all')).toEqual([event]);
    });

    it('Ищет по ID операции и электронной почте', () => {
        expect(filterAuditPage([event], 'operation-123', 'all')).toEqual([event]);
        expect(filterAuditPage([event], 'USER@EXAMPLE', 'all')).toEqual([event]);
    });

    it('Совмещает текст и результат, не выдавая успех за ошибку', () => {
        const failure = { ...event, id: 'failed', outcome: 'FAILED' };
        expect(filterAuditPage([event, failure], 'rag-index', 'FAILED')).toEqual([failure]);
        expect(filterAuditPage([event], '', 'RUNNING')).toEqual([]);
    });

    it('Поиск MCP находит события общего реестра MCP и плагинов', () => {
        const deletion = { ...event, action: 'plugin.delete', resourceType: 'plugin', resourceId: 'ai-plug-example' };
        expect(filterAuditPage([deletion], 'MCP', 'all')).toEqual([deletion]);
        expect(filterAuditPage([deletion], 'удаление', 'all')).toEqual([deletion]);
    });

    it('Переводит фактические коды квот и резервного копирования', () => {
        expect(describeAuditAction('quota.project').label).toBe('Изменение квот');
        expect(describeAuditAction('backup.catalog').label).toBe('Резервное копирование');
        expect(describeAuditAction('custom.unknown').label).toBe('custom.unknown');
    });

    it('Различает выдачу, смену и отзыв проектной роли в истории и поиске', () => {
        expect(describeAuditAction('project.member.add').label).toBe('Доступ выдан');
        expect(describeAuditAction('project.member.update').label).toBe('Роль изменена');
        expect(describeAuditAction('project.member.remove').label).toBe('Доступ отозван');
        expect(filterAuditPage([{ ...event, action: 'project.member.remove' }], 'доступ отозван', 'all')).toHaveLength(1);
    });

    it('Находит изменение состава каталога по действию, проекту и инструменту', () => {
        const assignment = { ...event, action: 'project.asset.add', resourceType: 'project', resourceId: 'prj-example · mcp · ai-plug-example' };
        expect(describeAuditAction(assignment.action).label).toBe('Добавлен в проект');
        expect(describeAuditAction('project.asset.remove').label).toBe('Убран из проекта');
        expect(filterAuditPage([assignment], 'добавлен в проект', 'all')).toEqual([assignment]);
        expect(filterAuditPage([assignment], 'prj-example', 'all')).toEqual([assignment]);
        expect(filterAuditPage([assignment], 'ai-plug-example', 'all')).toEqual([assignment]);
    });

    it('Не приписывает техническую запись admin конкретному человеку', () => {
        expect(auditActorLabel('admin')).toBe('Служебная запись');
        expect(auditActorLabel('')).toBe('Служебная запись');
        expect(auditActorLabel(event.actor)).toBe(event.actor);
    });

    it('Не отображает испорченную дату как Invalid Date', () => {
        expect(formatAuditTime('нет даты')).toBe('Дата не указана');
    });
});

describe('Загрузка страниц журнала', () => {
    const auth: IAuthMe = {user:{id:'one',email:'one@example.test',principalName:'one',displayName:'Первый',activeRole:'Главный администратор',
        userRoles:['Главный администратор'],routePermissions:['audit'],projectRoles:[]},policies:{audit:['read']}};
    const authorizedState = () => reducer(reducer(undefined,authInit.pending('login',undefined)),authInit.fulfilled(auth,'login',undefined));
    const firstPage = { items: [event], page: 1, size: 20, total: 40 };
    const secondPage = { ...firstPage, items: [{ ...event, id: 'event-2' }], page: 2 };

    it('Запоздалый ответ первой страницы не подменяет вторую', () => {
        let state = reducer(authorizedState(), fetchAudit.pending('first', {page:1,size:20}));
        state = reducer(state, setPage(2));
        state = reducer(state, fetchAudit.pending('second', {page:2,size:20}));
        state = reducer(state, fetchAudit.fulfilled(secondPage, 'second', {page:2,size:20}));
        state = reducer(state, fetchAudit.fulfilled(firstPage, 'first', {page:1,size:20}));
        expect(state.loadedPage).toBe(2);
        expect(state.list).toEqual(secondPage.items);
        expect(state.loading).toBe(false);
    });

    it('Ошибка обновления сохраняет прежние записи с явным состоянием ошибки', () => {
        let state = reducer(authorizedState(), fetchAudit.pending('first', {page:1,size:20}));
        state = reducer(state, fetchAudit.fulfilled(firstPage, 'first', {page:1,size:20}));
        state = reducer(state, fetchAudit.pending('retry', {page:1,size:20}));
        state = reducer(state, fetchAudit.rejected(new Error('Сеть'), 'retry', {page:1,size:20}, {message:'Журнал недоступен',accessDenied:false}));
        expect(state.list).toEqual(firstPage.items);
        expect(state.error).toBe('Журнал недоступен');
        expect(state.loading).toBe(false);
    });

    it('Старая ошибка не завершает более новый запрос', () => {
        let state = reducer(authorizedState(), fetchAudit.pending('first', {page:1,size:20}));
        state = reducer(state, fetchAudit.pending('second', {page:1,size:20}));
        state = reducer(state, fetchAudit.rejected(new Error('Сеть'), 'first', {page:1,size:20}, {message:'Старая ошибка',accessDenied:false}));
        expect(state.loading).toBe(true);
        expect(state.error).toBeNull();
    });

    it('Фоновое перечитывание сохраняет страницу и записи до получения нового результата', async () => {
        let resolveRefresh!: (value: typeof secondPage) => void;
        vi.mocked(bffApi.listAudit).mockResolvedValueOnce(secondPage)
            .mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
        const store = configureStore({ reducer:{userBlock,audit:reducer} });
        store.dispatch(authInit.pending('login',undefined));store.dispatch(authInit.fulfilled(auth,'login',undefined));
        store.dispatch(setPage(2));
        await store.dispatch(fetchAudit({ page: 2, size: 20 }));
        const update = store.dispatch(fetchAudit({ page: 2, size: 20 }));
        expect(store.getState().audit.page).toBe(2);
        expect(store.getState().audit.list).toEqual(secondPage.items);
        const refreshedPage = { ...secondPage, items: [{ ...secondPage.items[0], outcome: 'FAILED' }] };
        resolveRefresh(refreshedPage);
        await update;
        expect(store.getState().audit.page).toBe(2);
        expect(store.getState().audit.list).toEqual(refreshedPage.items);
    });
});
