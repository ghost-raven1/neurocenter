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

/** Установка ведёт к нативному плагину и сохраняет выбранный серверный проект. */
export function projectRagCatalogUrl(projectKey: string): string {
    return `/store?${new URLSearchParams({q:'OpenCodeRAG (плагин)',p:projectKey}).toString()}`;
}

/** Привязка открывает точный серверный проект независимо от сохранённого поиска в списке. */
export function projectBindingUrl(projectId: string): string {
    return `/projects${projectBindingSearch('', projectId)}`;
}

/** Закрытие мастера удаляет только его параметр, сохраняя остальные условия страницы. */
export function projectBindingSearch(search: string, projectId: string | null): string {
    const params = new URLSearchParams(search);
    if (projectId) { params.set('bind', projectId); } else { params.delete('bind'); }
    const query = params.toString();
    return query ? '?' + query : '';
}

/** В ссылке мастера допускается ID, но не имя-алиас или непроверенный сегмент API-пути. */
export function projectBindingTarget(search: string): string | null {
    const id = new URLSearchParams(search).get('bind');
    return id?.startsWith('prj-') && id.length <= 256 && !/[/\\?#%\x00-\x20]/.test(id) ? id : null;
}
