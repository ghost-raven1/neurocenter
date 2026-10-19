import type { IAuthMe } from '../../core/interfaces';

/** Инвалидирует данные при смене пользователя или прав, сохраняя кэш при обычной проверке сессии. */
export function authDataScope({ user, policies }: IAuthMe): string {
    return JSON.stringify({
        id: user.id,
        email: user.email,
        activeRole: user.activeRole,
        userRoles: [...user.userRoles].sort(),
        routePermissions: [...user.routePermissions].sort(),
        projectRoles: user.projectRoles
            .map(({ projectId, projectName, role }) => [projectId, projectName, role])
            .sort((left, right) => left[0].localeCompare(right[0]) || left[2].localeCompare(right[2]) || left[1].localeCompare(right[1])),
        policies: Object.fromEntries(Object.keys(policies).sort().map(key => [key, [...policies[key]].sort()])),
    });
}
