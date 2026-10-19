export type TCatalogSection = 'tools' | 'models';

/** В карточке проекта параметр tab уже выбирает вкладку самого проекта. */
export function catalogSection(search: string, embedded = false): TCatalogSection {
    return new URLSearchParams(search).get(embedded ? 'catalogTab' : 'tab') === 'models' ? 'models' : 'tools';
}

export function catalogSectionUrl(pathname: string, search: string, section: TCatalogSection, embedded = false, hash = ''): string {
    const params = new URLSearchParams(search);
    const key = embedded ? 'catalogTab' : 'tab';
    if (section === 'models') params.set(key, section);
    else params.delete(key);
    const query = params.toString();
    return pathname + (query ? '?' + query : '') + hash;
}
