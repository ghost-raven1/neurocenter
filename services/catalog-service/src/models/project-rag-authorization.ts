import { ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { normalizeEmail, roleLevel } from '../access/access.model';
import { RAG_WRITE_POLICY, RAG_WRITE_AUTHORIZATION_REQUIRED } from '../../../shared/rag-write-authorization.cjs';

export interface IRagIntentAuthor {
    author_email: string | null;
    author_role: string | null;
    write_policy: string;
}

/** Receipt recovery never invents an author for an older intent; only pinned current writers may mutate. */
export async function authorizeRagIntentAuthor(
    db: Pick<PoolClient, 'query'>,
    projectId: string,
    intent: IRagIntentAuthor,
): Promise<void> {
    const denied = (legacy = false) =>
        new ForbiddenException({
            code: RAG_WRITE_AUTHORIZATION_REQUIRED,
            message: legacy
                ? 'У старого пакета нет подтверждённого автора. Разрешена только сверка уже совершённой записи; автоматическая новая запись заблокирована.'
                : 'Права автора не подтверждены. Квитанция уже совершённой записи остаётся доступной; новая запись требует действующего доступа.',
        });
    if (intent.write_policy !== RAG_WRITE_POLICY || !intent.author_email || !intent.author_role) throw denied(true);
    const role = intent.author_role;
    let email: string;
    try {
        email = normalizeEmail(intent.author_email);
    } catch {
        throw denied();
    }
    if (email !== intent.author_email) throw denied();
    const account = (
        await db.query<{ enabled: boolean; is_main_admin: boolean }>(
            'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',
            [email],
        )
    ).rows[0];
    if (!account?.enabled) throw denied();
    if (role === 'Главный админ') {
        if (!account.is_main_admin) throw denied();
        return;
    }
    const memberships = (
        await db.query<{ project_id: string; role: string }>(
            'SELECT project_id,role FROM project_members WHERE lower(principal_name)=$1 FOR SHARE',
            [email],
        )
    ).rows;
    if (
        !memberships.some((row) => row.role === role) ||
        roleLevel(role) < 2 ||
        !memberships.some((row) => row.project_id === projectId && Math.min(roleLevel(row.role), roleLevel(role)) >= 2)
    )
        throw denied();
}
