import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { securityEvent } from '../access/security-events';
import type { IProjectMember } from './dto';
import type { IAccessActor } from '../access/access.model';
import {authorizeAccessWrite} from '../access/access-write-policy';
import {MEMBER_ROLE_OPTIONS} from './rbac';

export interface IProjectMemberRow {
    user_id: string;
    principal_name: string;
    display_name: string;
    role: string;
    added_at: string;
}

export function projectMemberFromRow(row: IProjectMemberRow): IProjectMember {
    return { userId: row.user_id, principalName: row.principal_name, displayName: row.display_name, role: row.role, addedAt: row.added_at };
}

/** Изменение назначения и его аудит фиксируются одной транзакцией. */
export class ProjectMemberRepository {
    constructor(private readonly pool: Pool) {}

    private async transaction<T>(projectId:string,actor:IAccessActor,work: (client: PoolClient,currentActor:IAccessActor) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client,await authorizeAccessWrite(client,actor,projectId));
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    /** The active role cannot inherit platform privileges or change an administrator target after a wait. */
    private role(actor:IAccessActor,next:string|undefined,before?:string):void{
        if(next!==undefined&&!(MEMBER_ROLE_OPTIONS as readonly string[]).includes(next))throw new BadRequestException('Неизвестная роль сотрудника проекта.');
        if(actor.activeRole!=='Главный админ'&&(next==='Админ проекта'||before==='Админ проекта'))throw new ForbiddenException('Назначение администратора проекта меняет Главный админ.');
    }

    private async audit(client: PoolClient, projectId: string, actor: string, action: string, before: IProjectMember | null, after: IProjectMember | null): Promise<void> {
        const member = after ?? before!;
        await securityEvent(client, { actor, action: `project.member.${action}`, resourceId: `${projectId} · ${member.principalName}`,
            before: before ? { projectId, ...before } : null, after: after ? { projectId, ...after } : null });
    }

    add(projectId: string, member: IProjectMember, actor: IAccessActor): Promise<IProjectMember> {
        return this.transaction(projectId,actor,async (client,currentActor) => {
            this.role(currentActor,member.role);
            const result = await client.query<IProjectMemberRow>(
                `INSERT INTO project_members (project_id, user_id, principal_name, display_name, role, added_at)
                 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, user_id) DO NOTHING RETURNING *`,
                [projectId, member.userId, member.principalName, member.displayName, member.role, member.addedAt]);
            if (!result.rows.length) { throw new ConflictException('Сотрудник уже в проекте. Обновите назначения.'); }
            const saved = projectMemberFromRow(result.rows[0]);
            await this.audit(client, projectId, currentActor.email, 'add', null, saved);
            return saved;
        });
    }

    update(projectId: string, userId: string, role: string, expectedRole: string | undefined, actor: IAccessActor): Promise<IProjectMember | null> {
        return this.transaction(projectId,actor,async (client,currentActor) => {
            const result = await client.query<IProjectMemberRow>('SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE', [projectId, userId]);
            const row = result.rows[0];
            if (!row || expectedRole !== undefined && row.role !== expectedRole) { return null; }
            this.role(currentActor,role,row.role);
            const before = projectMemberFromRow(row);
            if (before.role === role) { return before; }
            const changed = await client.query<IProjectMemberRow>('UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2 RETURNING *', [projectId, userId, role]);
            const after = projectMemberFromRow(changed.rows[0]);
            await this.audit(client, projectId, currentActor.email, 'update', before, after);
            return after;
        });
    }

    remove(projectId: string, userId: string, expectedRole: string | undefined, actor: IAccessActor): Promise<boolean> {
        return this.transaction(projectId,actor,async (client,currentActor) => {
            const result = await client.query<IProjectMemberRow>('SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE', [projectId, userId]);
            const row = result.rows[0];
            if (!row || expectedRole !== undefined && row.role !== expectedRole) { return false; }
            this.role(currentActor,undefined,row.role);
            await client.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId]);
            await this.audit(client, projectId, currentActor.email, 'remove', projectMemberFromRow(row), null);
            return true;
        });
    }
}
