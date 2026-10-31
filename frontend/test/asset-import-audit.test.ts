import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {IAuditEvent} from '../src/core/api/interfaces';
import AuditDetails from '../src/modules/Audit/AuditDetails';
import {describeAuditAction, filterAuditPage} from '../src/modules/Audit/auditHelpers';
import {auditEventSummary, auditResourceKind, auditResourceTitle} from '../src/modules/Audit/auditPresentation';

const event: IAuditEvent = {id: 'security:import', source: 'security', action: 'asset.import.request', resourceType: 'asset', resourceId: 'job-uuid', at: '2026-10-21T12:00:00Z', actor: 'admin@example.test', versionAuthor: '', outcome: 'SUCCEEDED', correlationId: '', decisionId: '', details: {before: null, after: {ids: ['one', 'two'], repository: 'owner/assets', commit: 'a'.repeat(40), items: [{assetId: 'one', name: 'Исторический MCP', kind: 'mcp', version: '1.2'}, {assetId: 'two', name: 'Планировщик', kind: 'agent', version: '1'}]}}};
describe('Понятный аудит запроса импорта', () => {
    it('Переводит действие и показывает названия выбранных ассетов вместо UUID заявки', () => {
        expect(describeAuditAction(event.action).label).toBe('Запрос импорта поставки'); expect(auditResourceKind(event)).toBe('Импорт поставки');
        expect(auditResourceTitle(event)).toBe('Исторический MCP, Планировщик'); expect(auditResourceTitle(event)).not.toContain(event.resourceId);
        expect(auditEventSummary(event)).toContain('Запрос принят в обработку'); expect(auditEventSummary(event)).not.toMatch(/ассеты добавлены|импорт завершён/i);
    });
    it('Детали содержат точные имена/версии, не называют запрос уже завершённой установкой', () => {
        const html = renderToStaticMarkup(createElement(AuditDetails, {event})); expect(html).toContain('Что выбрано для добавления'); expect(html).toContain('Исторический MCP'); expect(html).toContain('1.2'); expect(html).toContain('owner/assets'); expect(html).toContain('Технические сведения');
    });
    it('Поиск находит каждую позицию, ID заявки и русское действие', () => {
        for(const query of ['планировщик', 'исторический mcp', 'one', event.resourceId, 'запрос импорта поставки']) expect(filterAuditPage([event], query, 'all')).toEqual([event]);
    });
    it('Без job snapshot честно показывает число позиций, без придуманного инструмента', () => {
        const deleted = {...event, details: {before: null, after: {ids: ['one', 'two'], items: []}}}; expect(auditResourceTitle(deleted)).toBe('Импорт поставки · позиций: 2');
        expect(renderToStaticMarkup(createElement(AuditDetails, {event: deleted}))).toContain('Названия в исторической заявке не сохранились');
        expect(auditResourceTitle({...event, details: null})).toBe('Запрос импорта поставки');
    });
});
