import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { normalizeEmail, roleLevel } from '../access/access.model';
import type { RemoteProviderActor } from './remote-provider.types';
import { providerFence } from './remote-provider.identity';

/** Shares the role-write fence until dispatch; no role is inferred from an email or model. */
export async function remoteProviderAuthority(
    db: Pick<PoolClient, 'query'>,
    raw: RemoteProviderActor,
    modelId: string,
    inference = false,
): Promise<RemoteProviderActor> {
    let email: string;
    try {
        email = normalizeEmail(raw?.email);
    } catch {
        throw new ForbiddenException('Нужен действующий пользователь для личного доступа к модели.');
    }
    if (!raw.activeRole || !roleLevel(raw.activeRole))
        throw new ForbiddenException('Активная роль запроса не подтверждена.');
    await db.query('SELECT pg_advisory_xact_lock_shared(72465381)');
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [providerFence(modelId)]);
    const account = (
        await db.query<{ enabled: boolean; is_main_admin: boolean }>(
            'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',
            [email],
        )
    ).rows[0];
    if (!account?.enabled) throw new ForbiddenException('Учётная запись отключена или доступ отозван.');
    const model = (
        await db.query<{ archived_at: string | null }>('SELECT archived_at FROM model_catalog WHERE id=$1 FOR SHARE', [
            modelId,
        ])
    ).rows[0];
    if (!model) throw new NotFoundException('Модель отсутствует в каталоге.');
    if (inference && model.archived_at)
        throw new ForbiddenException('Модель убрана из каталога. Выберите действующую модель.');
    if (raw.activeRole === 'Главный админ') {
        if (!account.is_main_admin) throw new ForbiddenException('Права главного администратора отозваны.');
        return { email, activeRole: raw.activeRole, projectId: raw.projectId };
    }
    const grants = (
        await db.query<{ project_id: string; role: string }>(
            'SELECT project_id,role FROM project_members WHERE lower(principal_name)=$1 FOR SHARE',
            [email],
        )
    ).rows;
    if (!grants.some((grant) => grant.role === raw.activeRole))
        throw new ForbiddenException('Активная роль больше не назначена пользователю.');
    if (!inference && roleLevel(raw.activeRole) >= 3)
        return { email, activeRole: raw.activeRole, projectId: raw.projectId };
    const minimum = inference ? 2 : 1;
    const allowed = grants
        .filter(
            (grant) =>
                (!raw.projectId || grant.project_id === raw.projectId) &&
                Math.min(roleLevel(grant.role), roleLevel(raw.activeRole)) >= minimum,
        )
        .map((grant) => grant.project_id);
    if (
        !allowed.length ||
        (
            await db.query(
                'SELECT project_id FROM project_models WHERE model_id=$1 AND project_id=ANY($2::text[]) FOR SHARE',
                [modelId, allowed],
            )
        ).rows.length === 0
    )
        throw new ForbiddenException('Для модели нужна действующая роль в проекте, которому она назначена.');
    return { email, activeRole: raw.activeRole, projectId: raw.projectId };
}
