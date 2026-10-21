import { describe, expect, it } from 'vitest';
import type { IAuditEvent } from '../src/core/api/interfaces';
import { agentAuditChanges, agentAuditProject, agentAuditSummary, isAgentAudit } from '../src/modules/Audit/agentAudit';
import { auditResourceKind, auditResourceTitle } from '../src/modules/Audit/auditPresentation';
import { describeAuditAction, filterAuditPage } from '../src/modules/Audit/auditHelpers';
const event=(changes:Partial<IAuditEvent>={}):IAuditEvent=>({id:'event-one',at:'2026-10-21',actor:'admin@test',versionAuthor:'',action:'agent.update',resourceType:'agent',resourceId:'agent-one',outcome:'SUCCEEDED',decisionId:'',correlationId:'',...changes});
describe('Агенты в общем журнале',()=>{
    it.each(['agent.create','agent.update','agent.archive','agent.restore','project.agent.assign','project.agent.update','project.agent.remove','project.agents.connect'])('Человекочитаемое действие %s',action=>{
        expect(describeAuditAction(action).label).not.toContain('.');expect(isAgentAudit(event({action}))).toBe(true);expect(auditResourceKind(event({action}))).toBe('Агент OpenCode');
    });
    it('Имя сохраняется из снимка после удаления, поиск находит имя и русское действие',()=>{
        const value=event({action:'project.agent.remove',details:{before:{name:'Архитектор'},after:{name:'Архитектор',removed:true,revision:5}}});
        expect(auditResourceTitle(value)).toBe('Архитектор');expect(filterAuditPage([value],'Архитектор','all')).toEqual([value]);expect(filterAuditPage([value],'Агент убран из проекта','all')).toEqual([value]);
        expect(agentAuditSummary(value)).toContain('после подтверждения моста');
    });
    it('Сравнивает только безопасные метаданные и hash промпта без его текста',()=>{
        const value=event({action:'project.agent.update',details:{before:{name:'Ревьюер',enabled:false,revision:3,promptSha256:'a',prompt:'PRIVATE_OLD'},after:{name:'Ревьюер',enabled:true,revision:4,promptSha256:'b',prompt:'PRIVATE_NEW',apiKey:'SECRET',definition:{prompt:'OTHER_SECRET'}}}});
        expect(agentAuditChanges(value)).toContainEqual({label:'Промпт',before:'Предыдущая версия',after:'Изменён; текст в журнале не хранится'});
        expect(agentAuditChanges(value)).toContainEqual({label:'В проекте сохранено',before:'Отключён',after:'Включён'});
        const presentation=JSON.stringify([agentAuditChanges(value),agentAuditSummary(value),auditResourceTitle(value)]);expect(presentation).not.toMatch(/PRIVATE|SECRET|apiKey|promptSha256/);
    });
    it('Без прежнего hash не заявляет, что промпт точно изменился',()=>{
        const value=event({details:{before:{version:1},after:{version:2,promptSha256:'b'}}});expect(agentAuditChanges(value).some(change=>change.label==='Промпт')).toBe(false);
    });
    it('Показывает историческое имя проекта и не выдаёт ID за его название',()=>{
        expect(agentAuditProject(event({action:'project.agent.update',details:{before:{projectId:'project-one'},after:{projectId:'project-one',projectName:'Проект при изменении'}}}))).toBe('Проект при изменении');
        expect(agentAuditProject(event({action:'project.agent.update',details:{before:{projectId:'project-one'},after:{projectId:'project-one'}}}))).toBe('Название проекта не сохранено');
    });
    it('Archive kind=agent входит в тот же журнал и не захватывает другие assets',()=>{
        const value=event({action:'asset.archive',resourceType:'asset',details:{before:{kind:'agent',name:'Ревьюер',archived:false},after:{kind:'agent',name:'Ревьюер',archived:true}}});
        expect(isAgentAudit(value)).toBe(true);expect(auditResourceTitle(value)).toBe('Ревьюер');expect(agentAuditChanges(value)).toContainEqual({label:'Общий каталог',before:'Доступен',after:'В архиве'});
        expect(isAgentAudit({...value,details:{before:{kind:'model'},after:{kind:'model'}}})).toBe(false);
    });
});
