import { describe, expect, it, vi } from 'vitest';

import { accessEmail, applyGrantChange, grantChanges, grantMap, platformUserPayload, sameManagedGrants } from '../src/modules/Access/accessHelpers';
import reducer from '../src/modules/Access/redux/reducers';
import { fetchDecisions } from '../src/modules/Access/redux/actions';
import type { IAccessProjectRef } from '../src/core/api/interfaces';

vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn() } }));

describe('Безопасная выдача проектного доступа', () => {
    const projects = [{ id: 'one', name: 'Первый проект' }, { id: 'two', name: 'Второй проект' }];
    const email = 'user@example.com';
    const old: IAccessProjectRef[] = [{ projectId: 'one', projectName: 'Первый проект', role: 'Наблюдатель', userId: 'legacy-member-8' }];

    it('Нормализует почту и допускает локальную учётную запись', () => {
        expect(accessEmail('  User@EXAMPLE.com  ')).toBe(email);
        expect(accessEmail('dev@localhost')).toBe('dev@localhost');
        for (const value of ['user', 'user @example.com', 'user@example.com\0', '@example.com']) { expect(() => accessEmail(value)).toThrow('корректную'); }
    });

    it('Использует реальный ID существующего участника для изменения и отзыва', () => {
        expect(grantChanges(projects, old, { one: { checked: true, role: 'Разработчик' } }, email, false)[0]).toMatchObject({ userId: 'legacy-member-8', previousRole: 'Наблюдатель', desiredRole: 'Разработчик' });
        expect(grantChanges(projects, old, {}, email, false)[0]).toMatchObject({ userId: 'legacy-member-8', desiredRole: null });
    });

    it('Игнорирует проекты за пределами управляемой области', () => {
        const foreign = { projectId: 'foreign', projectName: 'Чужой', role: 'Разработчик', userId: 'foreign-user' };
        expect(grantChanges(projects, [foreign], { foreign: { checked: false, role: 'Наблюдатель' } }, email, false)).toEqual([]);
    });

    it('Создаёт назначение только на явно выбранный проект', () => {
        expect(grantChanges(projects, [], { two: { checked: true, role: 'Наблюдатель' } }, email, false)).toEqual([{ projectId: 'two', projectName: 'Второй проект', previousRole: null, desiredRole: 'Наблюдатель', userId: `u-${email}` }]);
    });

    it('Админ проекта не назначает и не изменяет другого администратора', () => {
        expect(() => grantChanges(projects, [], { one: { checked: true, role: 'Админ проекта' } }, email, false)).toThrow('главный админ');
        const admin = [{ ...old[0], role: 'Админ проекта' }];
        expect(() => grantChanges(projects, admin, {}, email, false)).toThrow('главный админ');
        expect(grantChanges(projects, admin, grantMap(admin), email, false)).toEqual([]);
        expect(grantChanges(projects, admin, {}, email, true)).toHaveLength(1);
    });

    it('Не превращает системную или неизвестную роль в роль проекта', () => {
        for (const role of ['Главный админ', 'admin', '']) { expect(() => grantChanges(projects, [], { one: { checked: true, role } }, email, true)).toThrow(); }
    });

    it('Повторная попытка не отправляет уже успешно применённую часть', () => {
        const desired = { one: { checked: true, role: 'Разработчик' }, two: { checked: true, role: 'Наблюдатель' } };
        const changes = grantChanges(projects, old, desired, email, false);
        const partial = applyGrantChange(old, changes[0]);
        expect(grantChanges(projects, partial, desired, email, false)).toEqual([changes[1]]);
        expect(partial[0].userId).toBe('legacy-member-8');
    });

    it('Обнаруживает чужую правку только в управляемых проектах', () => {
        const scope = new Set(['one']);
        expect(sameManagedGrants(old, [...old, { projectId: 'foreign', projectName: 'Чужой', role: 'Наблюдатель' }], scope)).toBe(true);
        expect(sameManagedGrants(old, [{ ...old[0], role: 'Разработчик' }], scope)).toBe(false);
        expect(sameManagedGrants(old, [{ ...old[0], userId: 'other-id' }], scope)).toBe(false);
    });
});

describe('Пользователи по электронной почте', () => {
    const user = { email: 'user@example.com', displayName: 'Сотрудник', isMainAdmin: true, enabled: false, createdAt: '2026-10-16' };

    it('Новое добавление не сбрасывает права или блокировку существующего человека', () => {
        expect(() => platformUserPayload({ email: ' USER@EXAMPLE.COM ', displayName: '', isMainAdmin: false, enabled: true }, true, [user])).toThrow('уже добавлен');
    });

    it('Разделяет создание и редактирование серверным createOnly без служебных полей', () => {
        const values = { email: ' New@EXAMPLE.com ', displayName: '  Алексей  ', isMainAdmin: false, enabled: true, createdAt: 'ignored' };
        expect(platformUserPayload(values, true, [user])).toEqual({ email: 'new@example.com', displayName: 'Алексей', isMainAdmin: false, enabled: true, createOnly: true });
        expect(platformUserPayload(user, false, [user]).createOnly).toBe(false);
    });

    it('Сравнивает сохранение с открытой копией, даже если список уже обновился в фоне', () => {
        const updated = { ...user, isMainAdmin: false, enabled: true };
        const values = { ...user, displayName: 'Новое имя' };
        expect(platformUserPayload(values, false, [updated], user).expected).toEqual({ displayName: 'Сотрудник', isMainAdmin: true, enabled: false });
    });
});

describe('Права после смены активной роли', () => {
    const payload = { decisions: [{ scope: 'platform', scopeId: 'all', actions: ['platform.admin'], decisionId: 'main', policyRevision: 1, ttlSeconds: 0 }], externalServiceUrl: null };

    it('Медленный ответ предыдущей роли не заменяет актуальные права', () => {
        let state = reducer(undefined, fetchDecisions.pending('old', 'project'));
        state = reducer(state, fetchDecisions.pending('current', 'project'));
        state = reducer(state, fetchDecisions.fulfilled(payload, 'old', 'project'));
        expect(state.decisions).toEqual([]);
        expect(state.loading).toBe(true);
        state = reducer(state, fetchDecisions.fulfilled({ decisions: [], externalServiceUrl: null }, 'current', 'project'));
        expect(state.decisions).toEqual([]);
        expect(state.loading).toBe(false);
    });

    it('Сетевой отказ показан явно и не оставляет старые права на экране', () => {
        let state = reducer(undefined, fetchDecisions.pending('first', 'project'));
        state = reducer(state, fetchDecisions.fulfilled(payload, 'first', 'project'));
        state = reducer(state, fetchDecisions.pending('refresh', 'project'));
        state = reducer(state, fetchDecisions.rejected(null, 'refresh', 'project', 'Нет связи с сервером'));
        expect(state.decisions).toEqual([]);
        expect(state.error).toBe('Нет связи с сервером');
        expect(state.loading).toBe(false);
    });
});
