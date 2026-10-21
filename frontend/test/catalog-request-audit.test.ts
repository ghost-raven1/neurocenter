import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import type {IAuditEvent} from '../src/core/api/interfaces';
import {requestAuditAction,requestAuditChanges} from '../src/features/CatalogRequests/auditPresentation';
import {describeAuditAction,filterAuditPage} from '../src/modules/Audit/auditHelpers';
import {auditEventSummary,auditResourceKind,auditResourceTitle} from '../src/modules/Audit/auditPresentation';
import AuditDetails from '../src/modules/Audit/AuditDetails';

const event:IAuditEvent={id:'security:request',source:'security',action:'catalog_request.complete',resourceType:'catalog_request',
    resourceId:'request-fixture',at:'2026-10-21T08:00:00Z',actor:'reviewer@example.test',versionAuthor:'',outcome:'SUCCEEDED',correlationId:'',decisionId:'',
    details:{before:{title:'Добавить поиск',status:'in_progress',revision:2},after:{title:'Добавить поиск',status:'completed',revision:3}}};

describe('Request decisions in the common audit journal',()=>{
    it('shows the saved title, action and actual status transition',()=>{
        expect(describeAuditAction(event.action).label).toBe('Заявка выполнена');
        expect(auditResourceTitle(event)).toBe('Добавить поиск');
        expect(auditResourceKind(event)).toBe('Заявка по каталогу');
        expect(requestAuditChanges(event)).toEqual([{label:'Статус заявки',before:'В работе',after:'Выполнена'}]);
        expect(auditEventSummary(event)).toContain('Выполнена');
        expect(filterAuditPage([event],'Добавить поиск','all')).toEqual([event]);
    });
    it('renders decision details without exposing arbitrary request payloads',()=>{
        const html=renderToStaticMarkup(createElement(AuditDetails,{event:{...event,details:{...event.details,
            after:{...event.details?.after,description:'PRIVATE_DESCRIPTION',sourceUrl:'https://private.example.test',comment:'PRIVATE_COMMENT'}}}}));
        expect(html).toContain('Что изменилось');expect(html).toContain('Выполнена');
        expect(html).not.toMatch(/PRIVATE_DESCRIPTION|private\.example|PRIVATE_COMMENT/);
        expect(html).not.toContain('Подробный состав изменений не сохранён');
    });
    it('keeps unknown and historical events honest',()=>{
        expect(requestAuditAction('catalog_request.toString')).toBeUndefined();
        expect(requestAuditChanges({...event,action:'catalog_request.unknown'})).toEqual([]);
        expect(auditResourceTitle({...event,details:null})).toBe('request-fixture');
        expect(auditResourceTitle({...event,details:{before:{title:'Сохранённое название'},after:null}})).toBe('Сохранённое название');
    });
});
