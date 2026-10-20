import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IAuditEvent } from '../src/core/api/interfaces';
import AuditDetails from '../src/modules/Audit/AuditDetails';
import { auditActorLabel, filterAuditPage } from '../src/modules/Audit/auditHelpers';
import { auditEventSummary, auditResourceKind, auditResourceTitle, publicationAuditChanges } from '../src/modules/Audit/auditPresentation';

const event: IAuditEvent = { id: 'security:one', source: 'security', action: 'plugin.update', resourceType: 'plugin',
    resourceId: 'ai-plug-id', at: '2026-10-20T03:57:20Z', actor: 'builtin-catalog', versionAuthor: '', outcome: 'SUCCEEDED',
    correlationId: '', decisionId: '', details: {
        before: { name: 'OpenCodeRAG', kind: 'plugin', version: 5, filesCount: 3, contentHash: 'before' },
        after: { name: 'OpenCodeRAG (плагин)', kind: 'plugin', version: 6, filesCount: 4, contentHash: 'after' },
    } };

describe('Понятные сведения истории публикаций', () => {
    it('Показывает сохранённое название, тип инструмента и изменение версии вместо одного ID', () => {
        expect(auditResourceTitle(event)).toBe('OpenCodeRAG (плагин)');
        expect(auditResourceKind(event)).toBe('Плагин OpenCode');
        expect(auditEventSummary(event)).toContain('Версия: 5 → 6');
        expect(auditActorLabel(event.actor)).toBe('Встроенный каталог');
        expect(publicationAuditChanges(event)).toContainEqual({ label: 'Файлов в комплекте', before: '3', after: '4' });
    });
    it('Находит событие по старому и новому названию, а также по исходному ID', () => {
        expect(filterAuditPage([event], 'OpenCodeRAG (плагин)', 'all')).toEqual([event]);
        expect(filterAuditPage([event], 'OpenCodeRAG', 'all')).toEqual([event]);
        expect(filterAuditPage([event], event.resourceId, 'all')).toEqual([event]);
    });
    it('Сохраняет имя удалённого инструмента и не подменяет его текущей карточкой', () => {
        const deleted = { ...event, action: 'plugin.delete', details: { before: event.details?.before, after: null } };
        expect(auditResourceTitle(deleted)).toBe('OpenCodeRAG');
        expect(auditEventSummary(deleted)).toBe('Удалён из общего каталога · версия 5');
    });
    it('Показывает добавление в каталог без выдуманного сравнения с прежней версией', () => {
        const added = { ...event, action: 'plugin.create', details: { before: null, after: event.details?.after } };
        expect(auditEventSummary(added)).toBe('Добавлен в общий каталог · версия 6');
    });
    it('Не выдумывает название и состав изменений у старой записи без снимка', () => {
        const old = { ...event, details: null };
        expect(auditResourceTitle(old)).toBe(event.resourceId);
        expect(auditEventSummary(old)).toBeUndefined();
        expect(publicationAuditChanges(old)).toEqual([]);
        expect(renderToStaticMarkup(createElement(AuditDetails, { event: old }))).toContain('Подробный состав изменений не сохранён');
    });
    it('В подробностях первым показывает изменения, а коды оставляет в техническом раскрытии', () => {
        const html = renderToStaticMarkup(createElement(AuditDetails, { event }));
        expect(html).toContain('OpenCodeRAG (плагин)');
        expect(html).toContain('Что изменилось');
        expect(html).toContain('Технические сведения');
        expect(html.indexOf('Что изменилось')).toBeLessThan(html.indexOf('Технические сведения'));
        expect(html).not.toContain('Связанная операция не указана');
    });
    it('Игнорирует неизвестные поля снимка и некорректную версию', () => {
        const invalid = { ...event, details: { before: null, after: { name: ['bad'], version: '4', filesCount: -1, config: 'secret' } } };
        expect(auditResourceTitle(invalid)).toBe(event.resourceId);
        expect(auditEventSummary(invalid)).toBeUndefined();
        expect(publicationAuditChanges(invalid)).toEqual([]);
    });
});
