/** Роли системы и права участника конкретного проекта. */
export const ROLES = ['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель'] as const;
export type TAccessRole = typeof ROLES[number];
export interface IProjectGrant { projectId: string; projectName: string; role: string }
export interface IAccessClaims {
    email: string;
    userRoles: string[];
    projects: IProjectGrant[];
    pluginIds: string[];
    skillPaths: string[];
}
export interface IPlatformUser { email: string; displayName: string; isMainAdmin: boolean; enabled: boolean; createdAt: string }
export interface IPlatformUserWrite {
    email?: unknown;
    displayName?: unknown;
    isMainAdmin?: unknown;
    enabled?: unknown;
    createOnly?: unknown;
    expected?: {displayName:string;isMainAdmin:boolean;enabled:boolean};
}
export interface IAccessActor { email: string; activeRole: string }

/** Неизвестная роль и отсутствие участия не дают даже права чтения. */
export function roleLevel(role: string | undefined): number {
    return role === 'Главный админ' ? 4 : role === 'Админ проекта' ? 3 : role === 'Разработчик' ? 2 : role === 'Наблюдатель' ? 1 : 0;
}

/** Нормализует почту до сохранения и поиска, не принимая произвольные логины. */
export function normalizeEmail(value: unknown): string {
    if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(value.trim()) || value.length > 254) {
        throw new Error('Укажите корректную электронную почту.');
    }
    return value.trim().toLowerCase();
}

/** Ограничивает права проекта выбранной ролью, сохраняя область назначения. */
export function projectLevel(claims: IAccessClaims, activeRole: string, project: string): number {
    if (!claims.userRoles.includes(activeRole)) { return 0; }
    if (activeRole === 'Главный админ') { return 4; }
    // Пространство постоянных ID зарезервировано: одноимённый проект не является назначением на чужой ID.
    const grant = claims.projects.find(item => item.projectId === project || !project.startsWith('prj-') && item.projectName === project);
    return grant ? Math.min(roleLevel(grant.role), roleLevel(activeRole)) : 0;
}

/** Общий каталог доступен админам проектов и главному админу. */
export function canReadCommon(claims: IAccessClaims, activeRole: string): boolean {
    return claims.userRoles.includes(activeRole) && roleLevel(activeRole) >= 3;
}
