/** Discovery is an explicit administrator admission; owner history remains available with execution disabled. */
export function allowSystemRoleMcpRoute(role: string, method: string, path: string): boolean | undefined {
    if (!path.startsWith('/api/system-role-mcp')) return undefined;
    const root = '/api/system-role-mcp', id = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
    if (path === root || new RegExp(`^${root}/(?:discoveries/${id}|runs/${id}/calls)$`).test(path)) return ['GET', 'HEAD'].includes(method);
    return path === root + '/discover' && method === 'POST' && ['Главный админ', 'Админ проекта'].includes(role);
}
