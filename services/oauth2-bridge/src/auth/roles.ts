/** Маршруты и действия активной роли; проектная область дополнительно проверяется gateway. */
export function roleRoutes(role: string): string[] {
    const base = ['start','store','projects','projects-detail','operations','rag','help'];
    if (role === 'Главный админ') { return [...base,'settings','assets','access','maintenance','audit','mcp-bundles','skills','packages','model-usage']; }
    if (role === 'Админ проекта') { return [...base,'assets','access','model-usage']; }
    return role === 'Разработчик' ? [...base,'model-usage'] : role === 'Наблюдатель' ? base : [];
}

/** Политики интерфейса не заменяют проверки объекта на сервере. */
export function rolePolicies(role: string): Record<string,string[]> {
    const main=role==='Главный админ';
    const manager=main || role==='Админ проекта';
    const writer=manager || role==='Разработчик';
    return {
        GET_PERMISSIONS_LANCEDB_PROJECTS: main ? ['projects#create','projects#update'] : manager ? ['projects#update'] : [],
        GET_PERMISSIONS_LANCEDB_VERSIONS: [],
        GET_PERMISSIONS_LANCEDB_SKILLS: writer ? ['skills#read','skills#publish'] : ['skills#read'],
        GET_PERMISSIONS_LANCEDB_PACKAGES: main ? ['packages#download','packages#manage'] : ['packages#download'],
        GET_PERMISSIONS_LANCEDB_OPERATIONS: main ? ['operations#manage'] : [],
        GET_PERMISSIONS_LANCEDB_MAINTENANCE: main ? ['maintenance#quota-manage','maintenance#retention-manage','maintenance#backup-manage'] : [],
        GET_PERMISSIONS_LANCEDB_AUDIT: main ? ['audit#read'] : [],
        GET_PERMISSIONS_LANCEDB_RAG: writer ? ['rag#read','rag#sync'] : ['rag#read'],
        GET_PERMISSIONS_LANCEDB_ACCESS: [], GET_PERMISSIONS_USER_PROFILE: [],
    };
}
