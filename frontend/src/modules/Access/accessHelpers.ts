import type { IAccessProjectRef, IProjectSummary } from '../../core/api/interfaces';

export const PROJECT_ROLE_OPTIONS = [
    { label: 'Наблюдатель', value: 'Наблюдатель' },
    { label: 'Разработчик', value: 'Разработчик' },
    { label: 'Админ проекта', value: 'Админ проекта' },
];
export interface IGrantEntry { checked: boolean; role: string; }
export type TGrantMap = Record<string, IGrantEntry>;
export interface IGrantChange { projectId: string; projectName: string; previousRole: string | null; desiredRole: string | null; userId: string; }
export interface IPlatformUser { email: string; displayName: string; isMainAdmin: boolean; enabled: boolean; createdAt: string; }
export interface IPlatformUserValues { email: string; displayName: string; isMainAdmin: boolean; enabled: boolean; }
export interface IPlatformUserSave extends IPlatformUserValues { createOnly: boolean; expected?: Pick<IPlatformUser, 'displayName' | 'isMainAdmin' | 'enabled'>; }

/** Совпадает с серверной нормализацией и допускает локальную учётную запись dev@localhost. */
export function accessEmail(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(normalized) || /[\x00-\x1f\x7f]/.test(normalized)) { throw new Error('Укажите корректную электронную почту.'); }
    return normalized;
}

export function grantMap(refs: IAccessProjectRef[]): TGrantMap {
    return Object.fromEntries(refs.map(ref => [ref.projectId, { checked: true, role: ref.role }]));
}

/** План затрагивает только управляемые проекты и использует настоящий ID участника. */
export function grantChanges(projects: Array<Pick<IProjectSummary, 'id' | 'name'>>, initial: IAccessProjectRef[], grants: TGrantMap, email: string, main: boolean): IGrantChange[] {
    const existing = new Map(initial.map(ref => [ref.projectId, ref]));
    return projects.flatMap(project => {
        const old = existing.get(project.id);
        const entry = grants[project.id];
        const desiredRole = entry?.checked ? entry.role : null;
        if (desiredRole === (old?.role ?? null)) { return []; }
        if (!main && (old?.role === 'Админ проекта' || desiredRole === 'Админ проекта')) { throw new Error('Роль «Админ проекта» назначает и изменяет главный админ.'); }
        if (desiredRole !== null && !PROJECT_ROLE_OPTIONS.some(option => option.value === desiredRole)) { throw new Error('Выберите одну из доступных проектных ролей.'); }
        return [{ projectId: project.id, projectName: project.name, previousRole: old?.role ?? null, desiredRole, userId: old?.userId ?? `u-${email}` }];
    });
}

/** Успешная часть пакетного сохранения становится основой следующей попытки. */
export function applyGrantChange(refs: IAccessProjectRef[], change: IGrantChange): IAccessProjectRef[] {
    const remaining = refs.filter(ref => ref.projectId !== change.projectId);
    return change.desiredRole ? [...remaining, { projectId: change.projectId, projectName: change.projectName, role: change.desiredRole, userId: change.userId }] : remaining;
}

/** Обнаруживает параллельную правку перед отправкой; записи за пределами области не сравниваются. */
export function sameManagedGrants(left: IAccessProjectRef[], right: IAccessProjectRef[], projectIds: Set<string>): boolean {
    const canonical = (refs: IAccessProjectRef[]): string => JSON.stringify(refs.filter(ref => projectIds.has(ref.projectId)).map(ref => [ref.projectId, ref.role, ref.userId ?? '']).sort(([a], [b]) => a.localeCompare(b)));
    return canonical(left) === canonical(right);
}

/** Новое добавление не должно превращаться в тихое редактирование существующей учётной записи. */
export function platformUserPayload(values: IPlatformUserValues, create: boolean, existing: IPlatformUser[], opened?: IPlatformUser): IPlatformUserSave {
    const email = accessEmail(values.email);
    if (create && existing.some(user => user.email.toLowerCase() === email)) { throw new Error('Пользователь с такой почтой уже добавлен. Откройте его настройки в списке.'); }
    const displayName = values.displayName?.trim().normalize('NFC') ?? '';
    if (displayName.length > 128 || /[\x00-\x1f\x7f]/.test(displayName)) { throw new Error('Имя: до 128 символов, без управляющих символов.'); }
    const original = opened ?? existing.find(user => user.email.toLowerCase() === email);
    if (!create && !original) { throw new Error('Учётная запись больше недоступна. Обновите список пользователей.'); }
    return { email, displayName, enabled: values.enabled, isMainAdmin: values.isMainAdmin, createOnly: create,
        ...(!create && original ? { expected: { displayName: original.displayName, isMainAdmin: original.isMainAdmin, enabled: original.enabled } } : {}) };
}
