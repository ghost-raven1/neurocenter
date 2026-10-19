import type { IAiPlugin, IPage } from '../../core/api/interfaces';

type ReadPage = (params: { pageSize: number; page: number }) => Promise<IPage<IAiPlugin>>;

/** Частичный каталог не позволяет отличить удалённую карточку от ещё не загруженной. */
export async function loadCompletePluginCatalog(readPage: ReadPage, isCurrent: () => boolean): Promise<IAiPlugin[] | null> {
    const plugins: IAiPlugin[] = [];
    const ids = new Set<string>();
    let total: number | undefined;
    let size: number | undefined;
    const incomplete = (): never => { throw new Error('Каталог изменился или загружен не полностью. Повторите загрузку.'); };

    for (let page = 1; ; page++) {
        if (!isCurrent()) { return null; }
        const result = await readPage({ pageSize: 100, page });
        if (!isCurrent()) { return null; }
        if (result.page !== page || !Number.isSafeInteger(result.size) || result.size < 1 || result.size > 100
            || !Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items)
            || (total !== undefined && result.total !== total) || (size !== undefined && result.size !== size)) { incomplete(); }
        total = result.total; size = result.size;
        if (result.items.length !== Math.min(size, total - (page - 1) * size)) { incomplete(); }
        for (const plugin of result.items) {
            if (ids.has(plugin.id)) { incomplete(); }
            ids.add(plugin.id); plugins.push(plugin);
        }
        if (plugins.length === total) { return plugins; }
    }
}
