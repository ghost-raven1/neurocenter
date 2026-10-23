/** Admission accepts only known actions. The owner rechecks exact project, initiator and current authority. */
export function allowSystemRoleRoute(role: string, method: string, path: string): boolean | undefined {
    if (!path.startsWith('/api/system-roles')) return undefined;
    const read = ['GET', 'HEAD'].includes(method), root = '/api/system-roles', agent = '(?:agent-ai-admin|agent-autoconfigurator|agent-indexer|agent-packager)', id = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
    if (path === root || new RegExp(`^${root}/${agent}/runs(?:/${id})?$`).test(path)) return read || method === 'POST' && path.endsWith('/runs') && ['Главный админ', 'Админ проекта'].includes(role);
    if (new RegExp(`^${root}/${agent}/requests/${id}$`).test(path)) return read;
    if (new RegExp(`^${root}/${agent}/prepare$`).test(path)) return method === 'POST' && ['Главный админ', 'Админ проекта'].includes(role);
    if (new RegExp(`^${root}/${agent}/runs/${id}/(?:cancel|rollback)$`).test(path)) return method === 'POST';
    if (new RegExp(`^${root}/${agent}/runs/${id}/apply$`).test(path)) return method === 'POST' && ['Главный админ', 'Админ проекта'].includes(role);
    return false;
}
