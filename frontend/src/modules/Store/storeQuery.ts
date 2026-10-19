import { baseRoutes } from '../../core/baseRoutes';

/** Поисковая ссылка работает при первом открытии и переходах без перезагрузки страницы. */
export function storeSearchQuery(search: string): string {
    return new URLSearchParams(search).get('q') ?? '';
}

/** Явный проект из адреса имеет приоритет над последним выбором браузера. */
export function storeProjectQuery(search: string): string | null {
    return new URLSearchParams(search).get('p') || null;
}

/** Меняет только фильтр или проект, сохраняя остальные параметры и якорь каталога. */
export function storeQueryUrl(search: string, update: { project?: string | null; query?: string }, hash = ''): string {
    const params = new URLSearchParams(search);
    if (update.project !== undefined) {
        if (update.project) { params.set('p', update.project); }
        else { params.delete('p'); }
    }
    if (update.query !== undefined) {
        if (update.query) { params.set('q', update.query); }
        else { params.delete('q'); }
    }
    const next = params.toString();
    return `${baseRoutes.store}${next ? `?${next}` : ''}${hash}`;
}
