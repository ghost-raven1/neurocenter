import { canonicalAccessRoute } from '../../../shared/access-route.cjs';

/** Контракт области доступа, возвращаемый каталогом после проверки назначения. */
export interface IResourceClaims {
    email: string;
    userRoles: string[];
    projects: Array<{ projectId: string; projectName: string; role: string }>;
    pluginIds: string[];
    skillPaths: string[];
}

/** Фильтрует ответы списков до отправки клиенту, включая дерево коллекций. */
export function filterResponse(data: unknown, claims: IResourceClaims, activeRole: string, route: string): unknown {
    const canonical = canonicalAccessRoute(route);
    if (canonical === undefined) {
        throw new Error('Некорректный путь фильтрации ответа.');
    }
    route = canonical;
    if (activeRole === 'Главный админ') {
        return data;
    }
    const common = ['Главный админ', 'Админ проекта'].includes(activeRole);
    const projectIds = new Set(claims.projects.map((item) => item.projectId));
    const projectNames = new Set(claims.projects.map((item) => item.projectName));
    const allowedProject = (key: string): boolean =>
        projectIds.has(key) || (!key.startsWith('prj-') && projectNames.has(key));
    const allowedSkill = (value: string): boolean => {
        const scoped = /^project-([^/]+)(?:\/|$)/.exec(value);
        return scoped ? allowedProject(scoped[1]) : common || claims.skillPaths.includes(value);
    };
    if (Array.isArray(data) && route === '/api/skills') {
        return data.filter((item) => item && typeof item.path === 'string' && allowedSkill(item.path));
    }
    if (Array.isArray(data) && route === '/api/skills/tree') {
        const visit = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
            items.flatMap((item) => {
                if (Array.isArray(item.children)) {
                    const children = visit(item.children);
                    return children.length ? [{ ...item, children }] : [];
                }
                return typeof item.path === 'string' && allowedSkill(item.path) ? [item] : [];
            });
        return visit(data);
    }
    if (route === '/api/rag/projects' && data && typeof data === 'object' && 'projects' in data) {
        return {
            ...data,
            projects: (data as { projects: Array<{ projectKey: string }> }).projects.filter((item) =>
                allowedProject(item.projectKey),
            ),
        };
    }
    if (route === '/api/access/users' && data && typeof data === 'object' && 'users' in data) {
        const users = (data as { users: Array<{ principalName: string; accesses: Array<{ projectId: string }> }> })
            .users;
        return {
            users: users
                .map((user) => ({ ...user, accesses: user.accesses.filter((item) => projectIds.has(item.projectId)) }))
                .filter((user) => user.accesses.length > 0 || user.principalName === claims.email),
        };
    }
    return data;
}
