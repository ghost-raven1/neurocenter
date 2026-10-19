import { ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { securityEvent } from '../access/security-events';
import type { IProjectMember } from './dto';

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

    private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    private async audit(client: PoolClient, projectId: string, actor: string, action: string, before: IProjectMember | null, after: IProjectMember | null): Promise<void> {
        const member = after ?? before!;
        await securityEvent(client, { actor, action: `project.member.${action}`, resourceId: `${projectId} · ${member.principalName}`,
            before: before ? { projectId, ...before } : null, after: after ? { projectId, ...after } : null });
    }

    add(projectId: string, member: IProjectMember, actor: string): Promise<IProjectMember> {
        return this.transaction(async client => {
            const result = await client.query<IProjectMemberRow>(
                `INSERT INTO project_members (project_id, user_id, principal_name, display_name, role, added_at)
                 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, user_id) DO NOTHING RETURNING *`,
                [projectId, member.userId, member.principalName, member.displayName, member.role, member.addedAt]);
            if (!result.rows.length) { throw new ConflictException('Сотрудник уже в проекте. Обновите назначения.'); }
            const saved = projectMemberFromRow(result.rows[0]);
            await this.audit(client, projectId, actor, 'add', null, saved);
            return saved;
        });
    }

    update(projectId: string, userId: string, role: string, expectedRole: string | undefined, actor: string): Promise<IProjectMember | null> {
        return this.transaction(async client => {
            const result = await client.query<IProjectMemberRow>('SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE', [projectId, userId]);
            const row = result.rows[0];
            if (!row || expectedRole !== undefined && row.role !== expectedRole) { return null; }
            const before = projectMemberFromRow(row);
            if (before.role === role) { return before; }
            const changed = await client.query<IProjectMemberRow>('UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2 RETURNING *', [projectId, userId, role]);
            const after = projectMemberFromRow(changed.rows[0]);
            await this.audit(client, projectId, actor, 'update', before, after);
            return after;
        });
    }

    remove(projectId: string, userId: string, expectedRole: string | undefined, actor: string): Promise<boolean> {
        return this.transaction(async client => {
            const result = await client.query<IProjectMemberRow>('SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE', [projectId, userId]);
            const row = result.rows[0];
            if (!row || expectedRole !== undefined && row.role !== expectedRole) { return false; }
            await client.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId]);
            await this.audit(client, projectId, actor, 'remove', projectMemberFromRow(row), null);
            return true;
        });
    }
}
