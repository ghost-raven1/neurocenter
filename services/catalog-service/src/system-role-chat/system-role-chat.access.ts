/** The route gate grants only known operations; private ownership and fresh project ACL stay server-side. */
export function allowSystemRoleChatRoute(role: string, method: string, path: string): boolean | undefined {
    if (!path.startsWith('/api/system-role-chats')) return undefined;
    const root = '/api/system-role-chats',
        id = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',
        read = ['GET', 'HEAD'].includes(method);
    if (
        path === root ||
        new RegExp(`^${root}/${id}$`).test(path) ||
        new RegExp(`^${root}/${id}/requests/${id}$`).test(path)
    ) {
        return read || (path === root && method === 'POST' && ['Админ проекта', 'Главный админ'].includes(role));
    }
    if (new RegExp(`^${root}/${id}/turns/${id}/cancel$`).test(path)) return method === 'POST';
    return (
        method === 'POST' &&
        new RegExp(`^${root}/${id}/(?:prepare|turns)$`).test(path) &&
        ['Админ проекта', 'Главный админ'].includes(role)
    );
}
