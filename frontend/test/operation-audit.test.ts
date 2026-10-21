import {describe,expect,it} from 'vitest';
import type {IAuditEvent} from '../src/core/api/interfaces';
import {auditResourceKind,auditResourceTitle} from '../src/modules/Audit/auditPresentation';
import {agentAuditChanges,agentAuditProject} from '../src/modules/Audit/agentAudit';

const event:IAuditEvent={id:'op',at:null,source:'operation',action:'bridge.install',resourceType:'bridge',resourceId:'a713c673-95c6-47f7-85a8-b5bb101280ea',actor:'admin@example.test',versionAuthor:'',outcome:'SUCCEEDED',decisionId:'',correlationId:'op',details:null};
describe('Названия проектов и действий моста в аудите',()=>{
    it('Имя pinned tool приоритетнее job UUID, тип отделён от транспорта моста',()=>{const installation={...event,details:{before:null,after:{name:'Исторический MCP',kind:'mcp',jobKind:'install'}}};expect(auditResourceTitle(installation)).toBe('Исторический MCP');expect(auditResourceKind(installation)).toBe('MCP-сервер · через мост');});
    it('Операция без карточки показывает конкретное подтверждённое действие или честный fallback',()=>{expect(auditResourceTitle({...event,details:{before:null,after:{jobKind:'choose-root'}}})).toBe('Выбор папки проектов');expect(auditResourceTitle(event)).toBe('Операция моста · название не сохранено');});
    it('Удалённый проект сохраняет историческое имя; UUID не подменяет отсутствующее название',()=>{const project={...event,action:'project.delete',resourceType:'project',resourceId:'prj-a713c673-95c6-47f7-85a8-b5bb101280ea'};expect(auditResourceTitle({...project,details:{before:null,after:{name:'Удалённый проект'}}})).toBe('Удалённый проект');expect(auditResourceTitle(project)).toBe('Проект · название не сохранено');});
    it('Проектный agent без projectName не показывает технический идентификатор как название',()=>{const agent={...event,action:'project.agent.assign',resourceType:'project',details:{before:null,after:{name:'Ревьюер',projectId:'prj-uuid'}}};expect(agentAuditProject(agent)).toBe('Название проекта не сохранено');expect(agentAuditChanges(agent).map(value=>value.label)).not.toContain('ID проекта');});
});
