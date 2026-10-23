import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { normalizeEmail, roleLevel, type IAccessActor } from '../access/access.model';
import type { ProjectChatDb } from './project-chat.types';
export interface ProjectChatActor extends IAccessActor { level: number; displayName: string; writable: boolean }
/** Every shared read and write is authorized by current project grants, never conversation ownership. */
export class ProjectChatPolicy {
    /** Admission and worker execution must use the same durable author, never the administrator clicking retry. */
    request(actor:IAccessActor):Request {
        const token=process.env.NEUROCENTER_INTERNAL_TOKEN;
        if(!token)throw new ServiceUnavailableException('Внутренний доступ сервиса не настроен.');
        return {headers:{'x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify(actor))}} as unknown as Request;
    }
    input(req: Request): IAccessActor {
        assertInternal(req.headers['x-neurocenter-internal']);
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Чат проекта доступен пользователям в интерфейсе.');
        try {
            const input = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null')));
            return { email: normalizeEmail(input.email), activeRole: input.activeRole };
        } catch { throw new ForbiddenException('Нужна действующая роль пользователя.'); }
    }
    async authorize(db: ProjectChatDb, projectId: string, actor: IAccessActor, minimum = 1, lock = false, recovery = false): Promise<ProjectChatActor> {
        const suffix = lock ? ' FOR SHARE' : '';
        const account = (await db.query<{ enabled: boolean; is_main_admin: boolean; display_name: string }>('SELECT enabled,is_main_admin,display_name FROM platform_users WHERE email=$1' + suffix, [actor.email])).rows[0];
        if (!account?.enabled || !roleLevel(actor.activeRole)) throw new ForbiddenException('Доступ пользователя отозван.');
        const grants = (await db.query<{ project_id: string; role: string }>('SELECT project_id,role FROM project_members WHERE lower(principal_name)=$1' + suffix, [actor.email])).rows;
        const assignedRole = actor.activeRole === 'Главный админ' ? account.is_main_admin : grants.some(row => row.role === actor.activeRole);
        const level = assignedRole ? actor.activeRole === 'Главный админ' ? 4 : Math.min(roleLevel(actor.activeRole), ...grants.filter(row => row.project_id === projectId).map(row => roleLevel(row.role)), 4) : 0;
        if (!assignedRole || actor.activeRole !== 'Главный админ' && !grants.some(row => row.project_id === projectId) || level < minimum) throw new ForbiddenException('Активная роль не разрешает это действие в проекте.');
        const project = (await db.query<{ state: string }>('SELECT state FROM projects WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [projectId])).rows[0];
        if (!project) throw new NotFoundException('Проект удалён.');
        if (minimum > 1 && project.state !== 'ACTIVE' && !recovery) throw new ForbiddenException('Проект доступен только для чтения.');
        return { ...actor, level, displayName: account.display_name || actor.email, writable: project.state === 'ACTIVE' };
    }
}
