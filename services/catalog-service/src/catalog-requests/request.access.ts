import { ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ROLES, projectLevel, roleLevel, type IAccessActor } from '../access/access.model';
import type { RequestActor, RequestPermissions, RequestRow } from './request.types';

/** Locks make role revocation and a request mutation share a single authorization boundary. */
export async function currentActor(db: Pick<PoolClient, 'query'>, input: IAccessActor): Promise<RequestActor> {
    const account = (
        await db.query<{ enabled: boolean; is_main_admin: boolean }>(
            'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',
            [input.email],
        )
    ).rows[0];
    if (!account?.enabled) throw new ForbiddenException('Учётная запись отключена.');
    const projects = (
        await db.query<{ projectId: string; projectName: string; role: string }>(
            `SELECT p.id AS "projectId",p.name AS "projectName",m.role FROM project_members m JOIN projects p ON p.id=m.project_id WHERE lower(m.principal_name)=$1 FOR SHARE OF m,p`,
            [input.email],
        )
    ).rows;
    const userRoles = ROLES.filter((role) =>
        role === 'Главный админ' ? account.is_main_admin : projects.some((item) => item.role === role),
    );
    if (!userRoles.includes(input.activeRole as (typeof ROLES)[number]))
        throw new ForbiddenException('Активная роль больше не назначена пользователю.');
    return { ...input, claims: { email: input.email, userRoles, projects, pluginIds: [], skillPaths: [] } };
}
export function canRead(actor: RequestActor, row: RequestRow): boolean {
    if (actor.activeRole === 'Главный админ') return true;
    if (row.project_id && projectLevel(actor.claims, actor.activeRole, row.project_id) < 1) return false;
    return (
        row.created_by === actor.email ||
        (!!row.project_id && projectLevel(actor.claims, actor.activeRole, row.project_id) >= 3)
    );
}
export function permissions(actor: RequestActor, row: RequestRow): RequestPermissions {
    const owner = row.created_by === actor.email,
        active = ['submitted', 'in_progress', 'needs_info'].includes(row.status);
    const reviewer =
        actor.activeRole === 'Главный админ' ||
        (!!row.project_id &&
            roleLevel(actor.activeRole) >= 3 &&
            projectLevel(actor.claims, actor.activeRole, row.project_id) >= 3);
    return {
        canEdit: owner && ['submitted', 'needs_info'].includes(row.status),
        canCancel: owner && active,
        canReview: reviewer && active,
        canResubmit: owner && row.status === 'needs_info',
    };
}
