/** Меняет вкладку проекта, сохраняя остальные параметры deep link. */
export function projectTabSearch(search: string, tab: string): string {
    const params = new URLSearchParams(search);
    params.set('tab', tab);
    return `?${params.toString()}`;
}

/** Справка по индексации сохраняет проект при дальнейшем переходе в каталог. */
export function projectRagSetupUrl(projectKey: string): string {
    return `/start?${new URLSearchParams({ extension: 'rag', p: projectKey }).toString()}`;
}
