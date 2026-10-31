/**
 * RBAC-модель каталога: 4 роли и матрица действий.
 *
 * Хирархия (уровень 4 — наибольший):
 * - `Главный админ` (4): вся система; источник — env `ADMIN_USERS`. Не в PG.
 * - `Админ проекта` (3): полный набор действий внутри одного проекта.
 * - `Разработчик` (2): чтение + изменение контента (скиллы/пакеты/активы) + операции.
 * - `Наблюдатель` (1): только чтение.
 *
 * Матрица:
 * | Действие                  | Наблюдатель | Разработчик | Админ проекта | Главный админ |
 * | --- | --- | --- | --- | --- |
 * | чтение (read)             | да          | да          | да            | да            |
 * | контент (content/ops)     | нет         | да          | да            | да            |
 * | установка (install)       | нет         | нет         | да            | да            |
 * | члены/роли/квоты/удаление | нет         | нет         | да в проекте  | да            |
 * | назначение «Админ проекта»| нет         | нет         | нет           | да            |
 * | maintenance/backup        | нет         | нет         | нет           | да            |
 */

export type TRoleName = 'Наблюдатель' | 'Разработчик' | 'Админ проекта' | 'Главный админ';

export type TAction =
    'read' | 'content' | 'ops' | 'install' | 'member' | 'role' | 'quota' | 'delete' | 'assign_admin' | 'maintenance';

interface IRoleInfo {
    level: number;
}

const ROLE_LEVELS: Record<TRoleName, IRoleInfo> = {
    Наблюдатель: { level: 1 },
    Разработчик: { level: 2 },
    'Админ проекта': { level: 3 },
    'Главный админ': { level: 4 },
};

/** Допустимые роли участника проекта (без системной «Главный админ»). */
export const MEMBER_ROLE_OPTIONS: TRoleName[] = ['Админ проекта', 'Разработчик', 'Наблюдатель'];

/** Дефолтная роль при добавлении участника. */
export const T_DEFAULT_MEMBER_ROLE: TRoleName = 'Разработчик';

/**
 * Разрешена ли роль конкретное действие.
 *
 * @param role - роль участника (или системная «Главный админ»).
 * @param action - действие из `TAction`.
 * @returns {boolean} — разрешено ли действие.
 */
export function roleCan(role: string, action: TAction): boolean {
    const level = ROLE_LEVELS[role as TRoleName]?.level;

    if (level === undefined) {
        return false;
    }
    if (level >= 4) {
        return true; // Главный админ — всё.
    }
    if (level === 3) {
        // Админ проекта — всё в проекте, кроме назначения админа и maintenance.
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
 * Уровень роли (0 — неизвестная/отсутствующая). 4 — «Главный админ».
 *
 * @param role - название роли.
 * @returns {number} уровень из 0..4.
 */
export function roleLevel(role: string): number {
    return ROLE_LEVELS[role as TRoleName]?.level ?? 0;
}

/**
 * Разбирает список principals из env `ADMIN_USERS` (запятые; дефолт — dev-значения).
 *
 * @returns {string[]} нормализованный список.
 */
export function getMainAdmins(): string[] {
    const raw = process.env.ADMIN_USERS || 'dev-user,dev@localhost';

    return raw
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

/**
 * Является ли principal «Главным админом».
 *
 * @param principal - username из x-bridge-principal (null при отсутствии).
 * @returns {boolean}
 */
export function isMainAdmin(principal: string | null): boolean {
    return principal !== null && getMainAdmins().includes(principal);
}
