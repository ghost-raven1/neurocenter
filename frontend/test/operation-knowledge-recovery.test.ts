import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IOperation } from '../src/core/api/interfaces';
import type { IUserInfo } from '../src/core/interfaces';
import OperationActionButtons from '../src/modules/Operations/OperationActionButtons';
import { operationActionPermissions } from '../src/modules/Operations/operationActions';
import { operationKnowledgeRecovery } from '../src/modules/Operations/operationKnowledgeRecovery';

const user: IUserInfo = {
    id: 'owner', email: 'owner@example.test', principalName: 'owner@example.test', displayName: 'Владелец',
    activeRole: 'Разработчик', userRoles: ['Разработчик'], routePermissions: ['/operations'],
    projectRoles: [{ projectId: 'prj-example', projectName: 'example', role: 'Разработчик' }],
};
const operation: IOperation = {
    operationId: 'bridge-12345678-1234-1234-1234-123456789abc',
    resourceType: 'bridge', resourceId: '12345678-1234-1234-1234-123456789abc',
    actor: user.email, projectId: 'prj-example', type: 'SYNC', state: 'FAILED',
    percent: 0, bytesDone: 0, bytesTotal: 0, startedAt: null, finishedAt: null,
    error: 'Синхронизация требует проверки плана в MCP. Изменения не подтверждены.',
};
const actions = { isBusy: () => false, retry: vi.fn(), cancel: vi.fn() };

describe('Выход из предварительного плана прежнего моста', () => {
    it('Ведёт к новой синхронизации выбранной папки без повтора старого задания', () => {
        expect(operationActionPermissions(operation, user)).toEqual({ cancel: false, retry: false, reopenKnowledge: true });
        const html = renderToStaticMarkup(createElement(OperationActionButtons, { operation, user, actions }));
        expect(html).toContain('href="/projects/prj-example?tab=rag"');
        expect(html).toContain('Открыть базу знаний');
        expect(html).toContain('Прежний мост остановил большую передачу на предварительном плане.');
        expect(html).toContain('Обновите мост и запустите синхронизацию');
        expect(html).not.toContain('Повторить через мост');
    });

    it('Открывает базу знаний для явно отклонённого задания прежнего контракта', () => {
        const legacy = { ...operation, error: 'Задание создано прежней версией моста. Индекс не подтверждён. Обновите мост и повторите действие для выбранной папки.' };
        expect(operationKnowledgeRecovery(legacy)?.href).toBe('/projects/prj-example?tab=rag');
        expect(operationActionPermissions(legacy, user).retry).toBe(false);
    });

    it('Список сохраняет компактную строку, а подробности показывают объяснение', () => {
        const list = renderToStaticMarkup(createElement(OperationActionButtons, { operation, user, actions, onDetails: vi.fn() }));
        const details = renderToStaticMarkup(createElement(OperationActionButtons, { operation, user, actions }));
        expect(list).toContain('Подробнее');
        expect(list).toContain('title="Прежний мост остановил большую передачу');
        expect(list).not.toContain('ant-space-vertical');
        expect(list).not.toContain('ant-typography-secondary');
        expect(details).toContain('ant-space-vertical');
        expect(details).toContain('ant-typography-secondary');
    });

    it.each([
        { error: 'Передача остановлена (HTTP 503).' },
        { error: 'Синхронизация требует проверки плана' },
        { type: 'INSTALL' as const }, { resourceType: 'rag' }, { state: 'SUCCEEDED' as const },
    ])('Другие операции не получают выход из прежнего плана: %j', change => {
        expect(operationKnowledgeRecovery({ ...operation, ...change })).toBeUndefined();
    });

    it('Сохраняет обычный повтор текущей синхронизации и другой ошибки установки', () => {
        expect(operationActionPermissions({ ...operation, error: 'Передача остановлена (HTTP 503).' }, user).retry).toBe(true);
        expect(operationActionPermissions({ ...operation, type: 'INSTALL' }, user).retry).toBe(true);
    });

    it.each([null, '', '../project', 'project?tab=files', 'https://example.test', 'project/other', 'project\\other', 'project#rag', 'project\n'])('Не строит переход для непроверенного идентификатора: %j', projectId => {
        expect(operationKnowledgeRecovery({ ...operation, projectId })).toBeUndefined();
        expect(operationActionPermissions({ ...operation, projectId }, { ...user, activeRole: 'Главный админ', userRoles: ['Главный админ'] }).retry).toBe(false);
    });

    it.each([
        null, { ...user, email: 'other@example.test' }, { ...user, userRoles: [] }, { ...user, projectRoles: [] },
        { ...user, activeRole: 'Наблюдатель', userRoles: ['Наблюдатель'], projectRoles: [{ projectId: 'prj-example', projectName: 'example', role: 'Наблюдатель' }] },
    ])('Не предлагает действие без текущих прав владельца', currentUser => {
        expect(operationActionPermissions(operation, currentUser).reopenKnowledge).toBe(false);
        const html = renderToStaticMarkup(createElement(OperationActionButtons, { operation, user: currentUser, actions }));
        expect(html).not.toContain('Открыть базу знаний');
    });
});
