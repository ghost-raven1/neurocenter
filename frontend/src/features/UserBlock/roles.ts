/**
 * RBAC-модель панели — зеркало backend `services/catalog-service/src/catalog/rbac.ts`.
 *
 * Доступ определяется АКТИВНОЙ РОЛЬЮ пользователя (`user.activeRole`),
 * а не ABAC-списками политик/прав. 4 роли (уровень 4 — наибольший):
 * - «Главный админ» (4) — вся система (env `ADMIN_USERS`).
 * - «Админ проекта» (3) — всё, кроме назначения админа и maintenance.
 * - «Разработчик» (2) — чтение + контент + операции.
 * - «Наблюдатель» (1) — только чтение.
 */

/** Имена ролей (совпадают с backend `TRoleName`). */
export type TRoleName = 'Наблюдатель' | 'Разработчик' | 'Админ проекта' | 'Главный админ';

/** Набор действий RBAC-матрицы. */
export type TAction =
    | 'read'
    | 'content'
    | 'ops'
    | 'install'
    | 'member'
    | 'role'
    | 'quota'
    | 'delete'
    | 'assign_admin'
    | 'maintenance';

const ROLE_LEVELS: Record<TRoleName, number> = {
    Наблюдатель: 1,
    Разработчик: 2,
    'Админ проекта': 3,
    'Главный админ': 4,
};

/**
 * Панель выдаёт SSO-роли oauth2-bridge (`user.activeRole`): admin/business/curator.
 * Маппим на уровни RBAC (admin — верхний). Неизвестные роли → базовый уровень.
 */
const SSO_LEVELS: Record<string, number> = {};

/**
 * Уровень роли (0 — неизвестная/отсутствующая). Принимает и SSO-роли (admin),
 * и 4-имена RBAC («Главный админ»).
 *
 * @param role - имя роли (может быть null/undefined).
 * @returns {number} уровень из 0..4.
 */
export function roleLevel(role: string | null | undefined): number {
    if (typeof role !== 'string' || role.length === 0) {
        return 0;
    }
    const sso = SSO_LEVELS[role];
    if (typeof sso === 'number') {
        return sso;
    }
    return ROLE_LEVELS[role as TRoleName] ?? 0;
}

/**
 * Допущено ли действие роли (зеркало backend `roleCan`).
 *
 * @param role - название роли.
 * @param action - действие из матрицы.
 * @returns {boolean} разрешено ли действие.
 */
export function roleCan(role: string | null | undefined, action: TAction): boolean {
    const level = roleLevel(role);
    if (level === 0) {
        return false;
    }
    if (level >= 4) {
        return true;
    }
    if (level === 3) {
        return action !== 'assign_admin' && action !== 'maintenance';
    }
    if (action === 'read') {
        return true;
    }
    if (level >= 2 && (action === 'content' || action === 'ops')) {
        return true;
    }
    return false;
}

/**
 * Только системная роль «Главный админ» (уровень 4). Используется для записи
 * в глобальный каталог бандлов (ai-plugins).
 *
 * @param role - название роли.
 * @returns {boolean} является ли роль «Главный админ».
 */
export function isMainAdminRole(role: string | null | undefined): boolean {
    return roleLevel(role) === 4;
}

/** Возвращает права в выбранном проекте с учётом назначенной и активной роли. */
export function projectRoleLevel(user: {activeRole:string;userRoles:string[];projectRoles?:Array<{projectId:string;projectName:string;role:string}>} | null, project: string | null | undefined): number {
    if (!user || !user.userRoles.includes(user.activeRole)) { return 0; }
    if (isMainAdminRole(user.activeRole)) { return 4; }
    const grant=user.projectRoles?.find(item=>item.projectId===project || !project?.startsWith('prj-')&&item.projectName===project);
    return grant ? Math.min(roleLevel(user.activeRole),roleLevel(grant.role)) : 0;
}
