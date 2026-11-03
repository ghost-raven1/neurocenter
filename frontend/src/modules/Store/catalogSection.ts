export type TCatalogSection = 'tools' | 'models' | 'agents' | 'requests' | 'supplies' | 'updates';

/** В карточке проекта параметр tab уже выбирает вкладку самого проекта. */
export function catalogSection(search: string, embedded = false): TCatalogSection {
    const value = new URLSearchParams(search).get(embedded ? 'catalogTab' : 'tab');
    if (value === 'updates' && !embedded) return 'updates';
    return value === 'models' || value === 'agents' || value === 'requests' || value === 'supplies' ? value : 'tools';
}

export function catalogSectionUrl(
    pathname: string,
    search: string,
    section: TCatalogSection,
    embedded = false,
    hash = '',
): string {
    const params = new URLSearchParams(search);
    const key = embedded ? 'catalogTab' : 'tab';
    if (section !== 'tools') params.set(key, section);
    else params.delete(key);
    const query = params.toString();
    return pathname + (query ? '?' + query : '') + hash;
}
